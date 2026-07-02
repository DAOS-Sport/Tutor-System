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
//
// venuesMap（選用）：批次呼叫端（如排程整批同步）可預先撈好 { byId:Set, byName:Map(name->id) }
// 傳入，省掉每筆家長都要查兩次 venues 表；不傳就照舊查 DB（既有單筆呼叫端行為不變）。
async function _resolveVenueId(client, code, venuesMap = null) {
  if (!code) return null;
  if (venuesMap) {
    if (venuesMap.byId.has(code)) return code;
    return venuesMap.byName.get(code) || null;
  }
  const byId = await client.query(`SELECT id FROM venues WHERE id = $1`, [code]);
  if (byId.rowCount) return code;
  const byName = await client.query(`SELECT id FROM venues WHERE name = $1`, [code]);
  return byName.rowCount ? byName.rows[0].id : null;
}

/** 供批次呼叫端一次撈好場館對照表，餵給 upsertLocalParent 的 venuesMap 選項。 */
async function loadVenuesMap(client) {
  const r = await client.query(`SELECT id, name FROM venues`);
  return {
    byId: new Set(r.rows.map((row) => row.id)),
    byName: new Map(r.rows.map((row) => [row.name, row.id])),
  };
}

/**
 * Upsert parents（以 phone 為唯一鍵）。
 *  - line_uid 已有不同值時，預設絕不覆蓋（COALESCE 保護）。
 *    overwriteLineUid=true 僅供「Ragic 已確認改綁成功後」的登入/綁定刷新使用。
 *  - reactivate=true（刻意登入/綁定）才允許把軟刪除的家長重新啟用；
 *    reactivate=false（背景刷新）則保留既有 is_active，不讓被移除的孤兒因同步復活。
 *  - venuesMap：見 _resolveVenueId 說明，批次同步用。
 */
async function upsertLocalParent(client, mapped, lineUid, { reactivate = true, venuesMap = null, overwriteLineUid = false } = {}) {
  const name  = mapped.name  || '未命名家長';
  const phone = mapped.phone || '';
  if (!phone) throw new Error('缺少手機，無法 upsert parent');

  const venueId = await _resolveVenueId(client, mapped.primary_venue_id, venuesMap);

  const up = await client.query(
    `INSERT INTO parents
       (phone, name, line_uid, primary_venue_id, gender, email, ragic_record_id,
        identity, home_phone, home_address, line_id, last_synced_at)
     VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''),
             NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NOW())
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       line_uid = CASE
         WHEN $13::boolean THEN NULLIF($3, '')
         ELSE COALESCE(parents.line_uid, EXCLUDED.line_uid)
       END,
       -- Ragic 是業務資料權威；有解析到場館時應更新本地鏡像，否則家長端改館別後
       -- refresh 仍會保留舊值，看起來像沒有回寫。Ragic 空白/待補登解析成 NULL 時才保留本地值。
       primary_venue_id = COALESCE(EXCLUDED.primary_venue_id, parents.primary_venue_id),
       gender = COALESCE(NULLIF(EXCLUDED.gender,''), parents.gender),
       email  = COALESCE(NULLIF(EXCLUDED.email,''),  parents.email),
       identity = COALESCE(NULLIF(EXCLUDED.identity,''), parents.identity),
       home_phone = COALESCE(NULLIF(EXCLUDED.home_phone,''), parents.home_phone),
       home_address = COALESCE(NULLIF(EXCLUDED.home_address,''), parents.home_address),
       line_id = COALESCE(NULLIF(EXCLUDED.line_id,''), parents.line_id),
       -- Ragic 端記錄可能被取代/重建（同電話換新 _ragicId）；本地快取要跟著更新，
       -- 否則後續寫回 Ragic 會一直打到已經不存在的舊記錄（見 resolveParentRagicRecord）。
       ragic_record_id = COALESCE(NULLIF(EXCLUDED.ragic_record_id, ''), parents.ragic_record_id),
       -- 只刷新不復活：唯有 reactivate=true 才允許覆蓋先前的軟刪除。
       is_active = CASE WHEN $12::boolean THEN TRUE ELSE parents.is_active END,
       last_synced_at = NOW(),
       updated_at = NOW()
     RETURNING id, name, phone, line_uid, primary_venue_id, gender, email, identity,
               home_phone, home_address, line_id, is_active`,
    [phone, name, lineUid || '', venueId,
     ragic.normalizeGender(mapped.gender), mapped.email || '', mapped.ragic_record_id || '',
     mapped.identity || '', mapped.home_phone || '', mapped.home_address || '', mapped.line_id || '',
     reactivate, overwriteLineUid]
  );
  return up.rows[0];
}

/**
 * Upsert students（id-stable）。
 *  匹配序：(parent_id, id_number) → (parent_id, ragic_record_id) → (parent_id, name, birth_date)。
 *  - 命中 → 就地 UPDATE（保留同一 student.id，活動紀錄不斷鏈）；設 is_active=TRUE、補 ragic_record_id。
 *    preservePending=true 時，若本地該列為「尚未同步」(last_synced_at IS NULL)，
 *    則不覆蓋顯示欄位，避免用舊的 Ragic 值蓋掉本地待同步的新值（背景批次防 lost-update）。
 *    即時登入/個資嚴格刷新會傳 preservePending=false，確保本地鏡射真的等於 Ragic 權威資料。
 *  - 未命中 → INSERT 新列。
 *  - authoritative=true（同步來源為 Ragic 權威清單）時，對「先前已同步過(ragic_record_id 非空)、
 *    有 id_number、但不在本次權威清單」的本地學員做軟拆除（is_active=FALSE，隱藏不外露）。
 *    僅在取得非空權威 id 集合時執行，避免 Ragic 解析回空時誤殺整批。
 *  - existingStudents（選用）：批次呼叫端可預先撈好「這位家長目前的學員列」陣列
 *    （至少含 id/id_number/ragic_record_id/name/birth_date）傳入，三層比對改成在記憶體裡
 *    做，省掉每位學員 3 次序列 SELECT；不傳就照舊逐筆查 DB（既有單筆呼叫端行為不變）。
 */
async function upsertLocalStudents(client, parentId, students, { authoritative = false, existingStudents = null, preservePending = true } = {}) {
  for (const s of students || []) {
    if (!s || !s.name) continue;
    const idNum  = s.id_number ? String(s.id_number).toUpperCase().trim() : null;
    const ragicId = s.ragic_record_id ? String(s.ragic_record_id).trim() : null;
    let matched = null;

    if (existingStudents) {
      if (idNum) {
        matched = existingStudents.find((r) => r.id_number && String(r.id_number).toUpperCase() === idNum) || null;
      }
      if (!matched && ragicId) {
        matched = existingStudents.find((r) => r.ragic_record_id && String(r.ragic_record_id) === ragicId) || null;
      }
      if (!matched) {
        // r.birth_date 來自 pg 對 DATE 欄位的預設解析（Date 物件或可解析字串皆有可能），
        // 一律經 new Date().toISOString() 正規化再比對，不可直接 String() 轉換
        // （String(dateObj) 會是 "Wed Jul 01 2026..." 這種人類可讀格式，永遠比不出結果）。
        const sBirth = s.birth_date ? new Date(s.birth_date).toISOString().slice(0, 10) : null;
        matched = existingStudents.find((r) => {
          if (r.name !== s.name) return false;
          // 比照原 SQL 的 ($3::date IS NULL OR birth_date = $3::date)：
          // 沒帶入生日 → 純比姓名；有帶入但本地是 NULL → 不算相等，不視為同一人。
          if (!sBirth) return true;
          if (!r.birth_date) return false;
          return new Date(r.birth_date).toISOString().slice(0, 10) === sBirth;
        }) || null;
      }
    } else {
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
    }

    if (matched) {
      await client.query(
        `UPDATE students SET
           -- 背景批次可保留待同步本地編輯；嚴格刷新則以 Ragic 回讀值覆蓋，消除鏡射漂移。
           name        = CASE WHEN $9::boolean AND last_synced_at IS NULL THEN name        ELSE $2 END,
           birth_date  = CASE WHEN $9::boolean AND last_synced_at IS NULL THEN birth_date  ELSE COALESCE($3::date, birth_date) END,
           gender      = CASE WHEN $9::boolean AND last_synced_at IS NULL THEN gender      ELSE COALESCE(NULLIF($4,''), gender) END,
           blood_type  = CASE WHEN $9::boolean AND last_synced_at IS NULL THEN blood_type  ELSE COALESCE(NULLIF($6,''), blood_type) END,
           student_code = CASE WHEN $9::boolean AND last_synced_at IS NULL THEN student_code ELSE COALESCE(NULLIF($7,''), student_code) END,
           id_number   = COALESCE(id_number, NULLIF($5,'')),
           ragic_record_id = COALESCE(ragic_record_id, NULLIF($8,'')),
           is_active   = TRUE,
           last_synced_at = CASE WHEN $9::boolean AND last_synced_at IS NULL THEN last_synced_at ELSE NOW() END,
           updated_at  = NOW()
         WHERE id = $1`,
        [matched.id, s.name, s.birth_date || null, ragic.normalizeGender(s.gender),
         idNum || '', s.blood_type || '', s.student_code || '', ragicId || '', preservePending]
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
      // 硬刪除 Ragic 已移除的學員（無業務 FK）；有報名/簽到/轉讓記錄者跳過不動。
      await client.query(
        `DELETE FROM students
           WHERE parent_id = $1
             AND ragic_record_id IS NOT NULL
             AND id_number IS NOT NULL
             AND NOT (UPPER(id_number) = ANY($2::text[]))
             AND id NOT IN (
               SELECT student_id FROM course_period_enrollments
               UNION ALL SELECT student_id FROM checkin_records WHERE student_id IS NOT NULL
               UNION ALL SELECT from_student_id FROM transfer_records WHERE from_student_id IS NOT NULL
             )`,
        [parentId, presentIds]
      );
    }
  }
}

/**
 * 安全硬刪除本地家長及其學員（硬邊界：只動本地 DB，Ragic 完全不碰）。
 *
 * 策略：
 *  1. 刪除「無業務 FK」的學員（課程報名 / 簽到 / 轉讓紀錄皆無）。
 *  2. 若家長已無剩餘學員，且自身無其他業務 FK，則刪除家長。
 *  有 FK 的學員/家長直接跳過（不刪也不軟刪），保留業務資料完整性。
 *
 * @param {object} db  - pg pool 或 pool client（支援 .query()）
 * @param {string} parentId
 * @returns {Promise<boolean>} true = 家長已刪除；false = 有 FK 暫留
 */
async function hardDeleteParentIfSafe(db, parentId) {
  await db.query(
    `DELETE FROM students
       WHERE parent_id = $1
         AND id NOT IN (
           SELECT student_id FROM course_period_enrollments
           UNION ALL SELECT student_id FROM checkin_records WHERE student_id IS NOT NULL
           UNION ALL SELECT from_student_id FROM transfer_records WHERE from_student_id IS NOT NULL
         )`,
    [parentId]
  );
  const r = await db.query(
    `DELETE FROM parents
       WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM students WHERE parent_id = $1)
         AND id NOT IN (
           SELECT checked_in_by_parent_id FROM checkin_records WHERE checked_in_by_parent_id IS NOT NULL
           UNION ALL SELECT initiated_by_parent_id FROM course_sessions WHERE initiated_by_parent_id IS NOT NULL
           UNION ALL SELECT from_parent_id FROM transfer_records WHERE from_parent_id IS NOT NULL
         )
       RETURNING id`,
    [parentId]
  );
  return r.rowCount > 0;
}

/**
 * 在同一個 phone 上 advisory lock，序列化同手機上的 bind/register/refresh，
 * 避免「conflict check 在 txn 外、upsert 在 txn 內」之間的縫導致誤綁。
 * 流程：lock → 重做 line/phone 衝突檢查 → upsert parent → 斷言 line_uid===caller → upsert students。
 */
async function _syncWithLock({ mapped, students, lineUid, reactivate = true, allowRebind = false, preservePending = true }) {
  const phone = mapped.phone;
  if (!phone) throw new Error('缺少手機');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`parent_bind:${phone}`]);

    // dupLine：任何 phone 上（不限 is_active）都不能有同一 LINE UID，
    // 因為 UNIQUE constraint parents_line_uid_key 不分 is_active。
    const dupLine = await client.query(
      `SELECT id, phone, is_active FROM parents WHERE line_uid = $1 LIMIT 1`, [lineUid]);
    if (dupLine.rowCount && dupLine.rows[0].phone !== phone) {
      const dup = dupLine.rows[0];
      if (dup.is_active) {
        // 活躍記錄持有這個 UID → 真正的衝突，阻擋並提示
        throw new BindConflictError('LINE_ALREADY_BOUND_TO_OTHER_PHONE',
          '此 LINE 帳號已綁定其他手機，請改用原手機登入或聯絡客服');
      }
      // 停用 ghost 記錄仍持有 UID → 清除它，讓 upsert 可以正常寫入
      await client.query(
        `UPDATE parents SET line_uid = NULL, updated_at = NOW() WHERE id = $1`, [dup.id]);
    }
    const dupPhone = await client.query(
      `SELECT line_uid FROM parents WHERE phone = $1 AND is_active = TRUE LIMIT 1`, [phone]);
    if (!allowRebind && dupPhone.rowCount && dupPhone.rows[0].line_uid && dupPhone.rows[0].line_uid !== lineUid) {
      throw new BindConflictError('PHONE_ALREADY_BOUND_TO_OTHER_LINE',
        '此手機已綁定其他 LINE 帳號，請聯絡客服處理');
    }

    const local = await upsertLocalParent(client, mapped, lineUid, {
      reactivate,
      overwriteLineUid: allowRebind,
    });

    if (local.line_uid && local.line_uid !== lineUid) {
      throw new BindConflictError('PHONE_ALREADY_BOUND_TO_OTHER_LINE',
        '此手機已綁定其他 LINE 帳號，請聯絡客服處理');
    }

    // 來源為 Ragic 權威清單 → 開啟 id-stable upsert + 權威移除軟拆除。
    await upsertLocalStudents(client, local.id, students || [], { authoritative: true, preservePending });
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
  return classifyStudentClaim(ragicStudents, claim) === 'matched';
}

/**
 * 認領驗證分類版：區分「真的比對不符」與「Ragic 該學員本來就沒存身分證字號、
 * 家長不可能比對得過」兩種狀況，讓 caller 能回不同的錯誤碼與文案
 * （後者是資料缺口，不是使用者打錯，不該顯示「請確認後再試」）。
 *   'matched'        姓名 + 身分證字號都對上
 *   'no_id_on_file'  姓名對上，但該筆 Ragic 學員身分證字號欄位是空的（無從比對）
 *   'mismatch'       姓名對不上任何學員，或身分證字號對不上（Ragic 有值但不同）
 */
function classifyStudentClaim(ragicStudents, claim) {
  const name = String(claim?.student_name || claim?.name || '').trim();
  const id   = String(claim?.id_number || '').trim().toUpperCase();
  if (!name || !id) return 'mismatch';
  const byName = (ragicStudents || []).find((s) => String(s.name || '').trim() === name);
  if (!byName) return 'mismatch';
  const ragicId = String(byName.id_number || '').trim().toUpperCase();
  if (!ragicId) return 'no_id_on_file';
  return ragicId === id ? 'matched' : 'mismatch';
}

/** 認領稽核：寫進伺服器日誌；門號雜湊、line_uid 遮罩，嚴禁落地完整 PII。 */
function auditClaim({ phone, lineUid, result, reason }) {
  const phoneHash = phone
    ? crypto.createHash('sha256').update(String(phone)).digest('hex').slice(0, 12)
    : null;
  const uidTail = lineUid ? `***${String(lineUid).slice(-4)}` : null;
  console.log('[claim-audit]', JSON.stringify({ phoneHash, uidTail, result, reason: reason || null }));
}

/**
 * 供批次呼叫端（整批 Ragic→本地同步）一次撈好「電話 → 該家長目前學員列」的對照表，
 * 餵給 upsertLocalStudents 的 existingStudents 選項，避免逐位家長各查一次。
 */
async function loadStudentsByParentPhone(client) {
  // 不篩 is_active：既有逐筆比對的 3 道 SQL 查詢本來就沒過濾軟刪除列
  // （比對到才由後續 UPDATE 的 is_active=TRUE 復活），這裡要維持同樣語意，
  // 否則已軟刪除的學員會在批次同步時比對不到、被誤判成新學員重複建立。
  const r = await client.query(
    `SELECT p.phone, s.id, s.id_number, s.ragic_record_id, s.name, s.birth_date
       FROM students s
       JOIN parents p ON p.id = s.parent_id`
  );
  const map = new Map();
  for (const row of r.rows) {
    const list = map.get(row.phone);
    if (list) list.push(row); else map.set(row.phone, [row]);
  }
  return map;
}

/**
 * 供批次呼叫端一次撈好「已綁定 line_uid 的手機」集合——用來判斷某支手機
 * 是否已經有真人透過即時登入流程建過帳號（見 ragicAdmin.js _pullParentsStudentsImpl
 * 的 Z03 分流規則：已綁定的人即使姓名是佔位資料也不能被排除在 parents 同步之外）。
 */
async function loadBoundPhones(client) {
  const r = await client.query(
    `SELECT phone FROM parents
      WHERE is_active = TRUE
        AND line_uid IS NOT NULL AND line_uid <> ''
        AND line_uid NOT LIKE 'demo:%'
        AND line_uid NOT LIKE 'DEMOTEST_%'`
  );
  return new Set(r.rows.map((row) => row.phone));
}

module.exports = {
  BindConflictError,
  upsertLocalParent,
  upsertLocalStudents,
  loadVenuesMap,
  loadStudentsByParentPhone,
  loadBoundPhones,
  hardDeleteParentIfSafe,
  _syncWithLock,
  syncFromRagicRecord,
  matchStudentClaim,
  classifyStudentClaim,
  auditClaim,
};
