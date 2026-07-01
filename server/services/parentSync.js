/**
 * server/services/parentSync.js — 家長/學員 與 Ragic 的同步「唯一語意來源」
 *
 * 從 routes/auth.js 抽出，讓「登入/綁定/註冊」與「開場刷新同步（POST /api/parents/me/sync）」
 * 共用同一套 upsert，避免兩處漂移。
 *
 * 設計原則（對應計畫）：
 *  - 名單/身分以 Ragic 為權威；本地 parents/students 為可靠鏡像。
 *  - 同步必須 id-stable：以 (parent_id, id_number) → (parent_id, ragic_record_id) →
 *    (parent_id, name, birth_date) 比對後「就地 UPDATE」，絕不重建學員 / 換 id，
 *    否則本地活動紀錄（course_period_enrollments / checkin_records …）會斷鏈成孤兒。
 *  - 只刷新、不復活：刷新同步不把軟刪除的家長 is_active 由 FALSE 翻 TRUE；
 *    只有「刻意登入/綁定（reactivate=true）」才允許重新啟用。
 *  - 權威移除：Ragic 權威清單已不含、且先前已同步過（ragic_record_id 非空）的學員 → 軟拆除隱藏。
 */
const crypto = require('crypto');
const { pool } = require('../models/db');
const ragic = require('./ragic');

class BindConflictError extends Error {
  constructor(code, message, http = 409) {
    super(message);
    this.code = code;
    this.http = http;
  }
}

// Ragic Z01「館別」欄位存的是場館「名稱」（如「新北高中」），本地 venues.id 是「代碼」（如「B」）。
// 先試 by-id（呼叫端萬一已傳代碼時的保險），查無再退而 by-name 對應真正的代碼；
// 兩者都查無（名稱在本地不存在／已改名）才回 NULL。修正前這裡永遠傳 Ragic 名稱去比對
// venues.id，永遠查無 → 每次從 Ragic 同步下來的家長 primary_venue_id 都被靜默清空。
async function _resolveVenueId(client, code) {
  if (!code) return null;
  const byId = await client.query(`SELECT id FROM venues WHERE id = $1`, [code]);
  if (byId.rowCount) return code;
  const byName = await client.query(`SELECT id FROM venues WHERE name = $1`, [code]);
  return byName.rowCount ? byName.rows[0].id : null;
}

/**
 * Upsert parents（以 phone 為唯一鍵）。
 *  - line_uid 已有不同值時，絕不覆蓋（COALESCE 保護）。
 *  - reactivate=true（刻意登入/綁定）才允許把軟刪除的家長重新啟用；
 *    reactivate=false（背景刷新）則保留既有 is_active，不讓被移除的孤兒因同步復活。
 */
async function upsertLocalParent(client, mapped, lineUid, { reactivate = true } = {}) {
  const name  = mapped.name  || '未命名家長';
  const phone = mapped.phone || '';
  if (!phone) throw new Error('缺少手機，無法 upsert parent');

  const venueId = await _resolveVenueId(client, mapped.primary_venue_id);

  const up = await client.query(
    `INSERT INTO parents
       (phone, name, line_uid, primary_venue_id, gender, email, ragic_record_id,
        identity, home_phone, home_address, line_id, last_synced_at)
     VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''),
             NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NOW())
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       line_uid = COALESCE(parents.line_uid, EXCLUDED.line_uid),
       primary_venue_id = COALESCE(parents.primary_venue_id, EXCLUDED.primary_venue_id),
       gender = COALESCE(NULLIF(EXCLUDED.gender,''), parents.gender),
       email  = COALESCE(NULLIF(EXCLUDED.email,''),  parents.email),
       identity = COALESCE(NULLIF(EXCLUDED.identity,''), parents.identity),
       home_phone = COALESCE(NULLIF(EXCLUDED.home_phone,''), parents.home_phone),
       home_address = COALESCE(NULLIF(EXCLUDED.home_address,''), parents.home_address),
       line_id = COALESCE(NULLIF(EXCLUDED.line_id,''), parents.line_id),
       ragic_record_id = COALESCE(parents.ragic_record_id, EXCLUDED.ragic_record_id),
       -- 只刷新不復活：唯有 reactivate=true 才允許覆蓋先前的軟刪除。
       is_active = CASE WHEN $12::boolean THEN TRUE ELSE parents.is_active END,
       last_synced_at = NOW(),
       updated_at = NOW()
     RETURNING id, name, phone, line_uid, primary_venue_id, gender, email, identity,
               home_phone, home_address, line_id, is_active`,
    [phone, name, lineUid || '', venueId,
     ragic.normalizeGender(mapped.gender), mapped.email || '', mapped.ragic_record_id || '',
     mapped.identity || '', mapped.home_phone || '', mapped.home_address || '', mapped.line_id || '',
     reactivate]
  );
  return up.rows[0];
}

/**
 * Upsert students（id-stable）。
 *  匹配序：(parent_id, id_number) → (parent_id, ragic_record_id) → (parent_id, name, birth_date)。
 *  - 命中 → 就地 UPDATE（保留同一 student.id，活動紀錄不斷鏈）；設 is_active=TRUE、補 ragic_record_id。
 *    若本地該列為「尚未同步」(last_synced_at IS NULL，代表有家長端未送達 Ragic 的編輯)，
 *    則不覆蓋顯示欄位，避免用舊的 Ragic 值蓋掉本地待同步的新值（防 lost-update）。
 *  - 未命中 → INSERT 新列。
 *  - authoritative=true（同步來源為 Ragic 權威清單）時，對「先前已同步過(ragic_record_id 非空)、
 *    有 id_number、但不在本次權威清單」的本地學員做軟拆除（is_active=FALSE，隱藏不外露）。
 *    僅在取得非空權威 id 集合時執行，避免 Ragic 解析回空時誤殺整批。
 */
async function upsertLocalStudents(client, parentId, students, { authoritative = false } = {}) {
  for (const s of students || []) {
    if (!s || !s.name) continue;
    const idNum  = s.id_number ? String(s.id_number).toUpperCase().trim() : null;
    const ragicId = s.ragic_record_id ? String(s.ragic_record_id).trim() : null;
    let matched = null;

    if (idNum) {
      const r = await client.query(
        `SELECT id FROM students WHERE parent_id = $1 AND id_number = $2 LIMIT 1`,
        [parentId, idNum]
      );
      matched = r.rows[0] || null;
    }
    if (!matched && ragicId) {
      const r = await client.query(
        `SELECT id FROM students WHERE parent_id = $1 AND ragic_record_id = $2 LIMIT 1`,
        [parentId, ragicId]
      );
      matched = r.rows[0] || null;
    }
    if (!matched) {
      const r = await client.query(
        `SELECT id FROM students
          WHERE parent_id = $1 AND name = $2
            AND ($3::date IS NULL OR birth_date = $3::date)
          LIMIT 1`,
        [parentId, s.name, s.birth_date || null]
      );
      matched = r.rows[0] || null;
    }

    if (matched) {
      await client.query(
        `UPDATE students SET
           -- 待同步(last_synced_at IS NULL)的本地編輯不被舊 Ragic 值覆蓋；其餘以 Ragic 為準。
           name        = CASE WHEN last_synced_at IS NULL THEN name        ELSE $2 END,
           birth_date  = CASE WHEN last_synced_at IS NULL THEN birth_date  ELSE COALESCE($3::date, birth_date) END,
           gender      = CASE WHEN last_synced_at IS NULL THEN gender      ELSE COALESCE(NULLIF($4,''), gender) END,
           blood_type  = CASE WHEN last_synced_at IS NULL THEN blood_type  ELSE COALESCE(NULLIF($6,''), blood_type) END,
           student_code = CASE WHEN last_synced_at IS NULL THEN student_code ELSE COALESCE(NULLIF($7,''), student_code) END,
           id_number   = COALESCE(id_number, NULLIF($5,'')),
           ragic_record_id = COALESCE(ragic_record_id, NULLIF($8,'')),
           is_active   = TRUE,
           last_synced_at = CASE WHEN last_synced_at IS NULL THEN last_synced_at ELSE NOW() END,
           updated_at  = NOW()
         WHERE id = $1`,
        [matched.id, s.name, s.birth_date || null, ragic.normalizeGender(s.gender),
         idNum || '', s.blood_type || '', s.student_code || '', ragicId || '']
      );
    } else {
      await client.query(
        `INSERT INTO students
           (parent_id, name, birth_date, gender, id_number, blood_type, student_code, ragic_record_id, is_active, last_synced_at)
         VALUES ($1, $2, $3::date, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), NULLIF($7,''), NULLIF($8,''), TRUE, NOW())`,
        [parentId, s.name, s.birth_date || null, ragic.normalizeGender(s.gender),
         idNum || '', s.blood_type || '', s.student_code || '', ragicId || '']
      );
    }
  }

  if (authoritative) {
    const presentIds = [...new Set(
      (students || [])
        .map((s) => (s && s.id_number ? String(s.id_number).toUpperCase().trim() : null))
        .filter(Boolean)
    )];
    if (presentIds.length > 0) {
      await client.query(
        `UPDATE students SET is_active = FALSE, updated_at = NOW()
          WHERE parent_id = $1
            AND COALESCE(is_active, TRUE) = TRUE
            AND ragic_record_id IS NOT NULL
            AND id_number IS NOT NULL
            AND NOT (UPPER(id_number) = ANY($2::text[]))`,
        [parentId, presentIds]
      );
    }
  }
}

/**
 * 在同一個 phone 上 advisory lock，序列化同手機上的 bind/register/refresh，
 * 避免「conflict check 在 txn 外、upsert 在 txn 內」之間的縫導致誤綁。
 * 流程：lock → 重做 line/phone 衝突檢查 → upsert parent → 斷言 line_uid===caller → upsert students。
 */
async function _syncWithLock({ mapped, students, lineUid, reactivate = true }) {
  const phone = mapped.phone;
  if (!phone) throw new Error('缺少手機');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`parent_bind:${phone}`]);

    const dupLine = await client.query(
      `SELECT phone FROM parents WHERE line_uid = $1 LIMIT 1`, [lineUid]);
    if (dupLine.rowCount && dupLine.rows[0].phone !== phone) {
      throw new BindConflictError('LINE_ALREADY_BOUND_TO_OTHER_PHONE',
        '此 LINE 帳號已綁定其他手機，請改用原手機登入或聯絡客服');
    }
    const dupPhone = await client.query(
      `SELECT line_uid FROM parents WHERE phone = $1 LIMIT 1`, [phone]);
    if (dupPhone.rowCount && dupPhone.rows[0].line_uid && dupPhone.rows[0].line_uid !== lineUid) {
      throw new BindConflictError('PHONE_ALREADY_BOUND_TO_OTHER_LINE',
        '此手機已綁定其他 LINE 帳號，請聯絡客服處理');
    }

    const local = await upsertLocalParent(client, mapped, lineUid, { reactivate });

    if (local.line_uid && local.line_uid !== lineUid) {
      throw new BindConflictError('PHONE_ALREADY_BOUND_TO_OTHER_LINE',
        '此手機已綁定其他 LINE 帳號，請聯絡客服處理');
    }

    // 來源為 Ragic 權威清單 → 開啟 id-stable upsert + 權威移除軟拆除。
    await upsertLocalStudents(client, local.id, students || [], { authoritative: true });
    await client.query('COMMIT');
    return local;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 從 Ragic Z01 record 同步 parent + students 到本地（單一交易）。
 *  opts.reactivate：刻意登入/綁定=true（允許重新啟用）；背景刷新=false（不復活）。
 */
async function syncFromRagicRecord(z01Row, lineUid, { reactivate = true } = {}) {
  const mapped = ragic.mapZ01Parent(z01Row);
  const students = ragic.parseZ01Students(z01Row);
  return _syncWithLock({ mapped, students, lineUid, reactivate });
}

/**
 * 認領驗證：把家長提供的「學員姓名 + 身分證字號」與「即將連結的 Ragic 學員清單」比對。
 * 兩者皆需提供、且與某一位學員的 (姓名, 身分證) 完全一致才回 true。
 */
function matchStudentClaim(ragicStudents, claim) {
  const name = String(claim?.student_name || claim?.name || '').trim();
  const id   = String(claim?.id_number || '').trim().toUpperCase();
  if (!name || !id) return false;
  return (ragicStudents || []).some((s) =>
    String(s.name || '').trim() === name &&
    String(s.id_number || '').trim().toUpperCase() === id
  );
}

/** 認領稽核：寫進伺服器日誌；門號雜湊、line_uid 遮罩，嚴禁落地完整 PII。 */
function auditClaim({ phone, lineUid, result, reason }) {
  const phoneHash = phone
    ? crypto.createHash('sha256').update(String(phone)).digest('hex').slice(0, 12)
    : null;
  const uidTail = lineUid ? `***${String(lineUid).slice(-4)}` : null;
  console.log('[claim-audit]', JSON.stringify({ phoneHash, uidTail, result, reason: reason || null }));
}

module.exports = {
  BindConflictError,
  upsertLocalParent,
  upsertLocalStudents,
  _syncWithLock,
  syncFromRagicRecord,
  matchStudentClaim,
  auditClaim,
};
