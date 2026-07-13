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
 *  - 權威移除：Ragic 權威清單已不含、且先前已同步過（ragic_record_id 非空）的學員，
 *    只硬刪「沒有業務 FK」的本地殘留；有課程/簽到/轉讓關聯者保留連結，不再用 soft-delete 隱藏。
 */
const crypto = require('crypto');
const { pool } = require('../models/db');
const ragic = require('./ragic');
const { maskName, maskPhone } = require('../utils/piiMask');
const { normalizePhone, normalizeStudentName } = require('./identityNormalizer');
const { STABILITY_FLAGS, getTrueRagicLineUid } = require('../config/ragicSchema');

class BindConflictError extends Error {
  constructor(code, message, http = 409) {
    super(message);
    this.code = code;
    this.http = http;
  }
}

async function findActiveParentByLineUid(lineUid, db = pool) {
  const uid = String(lineUid || '').trim();
  if (!uid) return null;
  const rows = (await db.query(
    `SELECT id,name,phone,line_uid,primary_venue_id,gender,email,identity,
            home_phone,home_address,line_id,is_active
       FROM parents
      WHERE line_uid=$1 AND is_active=TRUE
      ORDER BY id`,
    [uid]
  )).rows;
  if (rows.length > 1) {
    throw new BindConflictError('DATA_RECONCILIATION_PENDING', 'LINE UID 命中多個 active parent');
  }
  return rows[0] || null;
}

// Ragic Z01「館別」欄位存的是場館「名稱」（如「新北高中」），本地 venues.id 是「代碼」（如「B」）。
// 先試 by-id（呼叫端萬一已傳代碼時的保險），查無再退而 by-name 對應真正的代碼；
// 兩者都查無（名稱在本地不存在／已改名）才回 NULL。修正前這裡永遠傳 Ragic 名稱去比對
// venues.id，永遠查無 → 每次從 Ragic 同步下來的家長 primary_venue_id 都被靜默清空。
//
// venuesMap（選用）：批次呼叫端（如排程整批同步）可預先撈好 loadVenuesMap() 的結果
// 傳入，省掉每筆家長都要重查 venues 表；不傳就當場載入（venues 僅數十列，成本可忽略）。

// 場館名稱正規化：去頭尾空白 + 去掉「結尾」的括號備註（半形/全形皆可）。
// 實際案例：本地 venues（H05 同步而來）叫「三重商工 (test)」「三民高中 (tx)」，
// 但 Ragic Z01 客戶記錄的館別存的是「三重商工」「三民高中」→ 精確比對永遠查無
// → 上千筆家長的 primary_venue_id 被靜默解析成 NULL，登入時再被
// LOCAL_VENUE_REFRESH_FAILED 擋下。兩邊都先正規化再比對，吸收這類備註後綴差異。
function _normalizeVenueName(name) {
  return String(name || '')
    .trim()
    .replace(/\s*[（(][^（()）]*[）)]\s*$/, '')
    .trim();
}

async function _resolveVenueId(client, code, venuesMap = null) {
  if (!code) return null;
  const map = venuesMap || (await loadVenuesMap(client));
  if (map.byId.has(code)) return code;
  if (map.byName.has(code)) return map.byName.get(code);
  return map.byNormName.get(_normalizeVenueName(code)) || null;
}

/** 供批次呼叫端一次撈好場館對照表，餵給 upsertLocalParent 的 venuesMap 選項。 */
async function loadVenuesMap(client) {
  const r = await client.query(`SELECT id, name FROM venues`);
  const byNormName = new Map();
  const ambiguous = new Set();
  for (const row of r.rows) {
    const norm = _normalizeVenueName(row.name);
    if (!norm) continue;
    // 兩個場館正規化後同名（如「A館 (新)」與「A館 (舊)」）→ 無法判斷該配哪個，
    // 寧可回 NULL 保留本地既有值，也不要亂配到錯的場館。
    if (byNormName.has(norm) && byNormName.get(norm) !== row.id) {
      ambiguous.add(norm);
      continue;
    }
    byNormName.set(norm, row.id);
  }
  for (const k of ambiguous) byNormName.delete(k);
  return {
    byId: new Set(r.rows.map((row) => row.id)),
    byName: new Map(r.rows.map((row) => [row.name, row.id])),
    byNormName,
  };
}

const _columnCache = new Map();
function _quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

async function _hasColumn(client, table, column) {
  const key = `${table}.${column}`;
  if (_columnCache.has(key)) return _columnCache.get(key);
  const r = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
      LIMIT 1`,
    [table, column]
  );
  const ok = r.rowCount > 0;
  _columnCache.set(key, ok);
  return ok;
}

async function _existsByColumn(client, table, column, id) {
  if (!(await _hasColumn(client, table, column))) return false;
  const r = await client.query(
    `SELECT 1 FROM ${_quoteIdent(table)} WHERE ${_quoteIdent(column)} = $1 LIMIT 1`,
    [id]
  );
  return r.rowCount > 0;
}

async function _existsByUuidArrayColumn(client, table, column, id) {
  if (!(await _hasColumn(client, table, column))) return false;
  const r = await client.query(
    `SELECT 1 FROM ${_quoteIdent(table)} WHERE $1::uuid = ANY(${_quoteIdent(column)}) LIMIT 1`,
    [id]
  );
  return r.rowCount > 0;
}

async function _hasAnyReference(client, id, specs) {
  for (const spec of specs) {
    for (const column of spec.columns || []) {
      if (await _existsByColumn(client, spec.table, column, id)) return true;
    }
    for (const column of spec.arrayColumns || []) {
      if (await _existsByUuidArrayColumn(client, spec.table, column, id)) return true;
    }
  }
  return false;
}

const STUDENT_REFERENCE_SPECS = [
  { table: 'course_period_enrollments', columns: ['student_id'] },
  { table: 'checkin_records', columns: ['student_id', 'checked_in_by_student_id'] },
  { table: 'transfer_records', columns: ['from_student_id', 'to_student_id'] },
  { table: 'group_order_members', arrayColumns: ['student_ids'] },
  { table: 'student_audit_logs', columns: ['student_id'] },
];

const PARENT_REFERENCE_SPECS = [
  { table: 'checkin_records', columns: ['checked_in_by_parent_id'] },
  { table: 'course_sessions', columns: ['initiated_by_parent_id', 'cancelled_by_parent_id'] },
  { table: 'transfer_records', columns: ['from_parent_id', 'to_parent_id', 'requested_by_parent_id'] },
  { table: 'group_orders', columns: ['leader_parent_id'] },
  { table: 'group_order_members', columns: ['parent_id'] },
  { table: 'group_order_drafts', columns: ['parent_id'] },
  { table: 'course_evaluations', columns: ['parent_id'] },
  { table: 'promotion_usages', columns: ['parent_id'] },
  { table: 'promotions', columns: ['eligible_parent_id'] },
  { table: 'referral_records', columns: ['referrer_parent_id', 'referee_parent_id'] },
  { table: 'families', columns: ['owner_parent_id'] },
  { table: 'family_members', columns: ['parent_id', 'invited_by'] },
];

async function hardDeleteStudentIfSafe(client, studentId) {
  void client;
  void studentId;
  return false;
}

/**
 * Upsert canonical parent。
 *  - 身分候選固定依 LINE UID → canonical phone → source_record_link 收斂；
 *    ragic_record_id 只定位來源，不能單獨證明人的身分。
 *  - 同一手機即使帶來另一個 Ragic record id，也只補 source_record_link，不建第二人。
 *  - line_uid 已有不同值時，預設絕不覆蓋（COALESCE 保護）。
 *    overwriteLineUid=true 僅供「Ragic 已確認改綁成功後」的登入/綁定刷新使用。
 *  - reactivate=true（刻意登入/綁定）才允許把軟刪除的家長重新啟用；
 *    reactivate=false（背景刷新）則保留既有 is_active，不讓被移除的孤兒因同步復活。
 *  - preservePending=true（預設，比照 upsertLocalStudents 同款 guard）：本地列尚未
 *    回寫 Ragic（last_synced_at IS NULL）時，姓名與其餘可編輯欄位保留本地值，不被
 *    夜間全量 pull 用 Ragic 舊值蓋掉（P1.1 決策1/2、嫌疑6 lost-update）。即時登入/
 *    綁定刷新（refreshParentMirrorFromRagic）傳 preservePending=false：此時本地編輯
 *    已於稍早寫回 Ragic，這裡讀回的就是合併後的權威狀態，可以覆蓋。
 *  - venuesMap：見 _resolveVenueId 說明，批次同步用。
 */
async function upsertLocalParent(client, mapped, lineUid, { reactivate = true, venuesMap = null, overwriteLineUid = false, preservePending = true } = {}) {
  const name  = mapped.name  || '未命名家長';
  const phone = normalizePhone(mapped.phone);
  if (!phone) throw new Error('缺少手機，無法 upsert parent');
  const ragicRecordId = mapped.ragic_record_id ? String(mapped.ragic_record_id).trim() : '';

  const venueId = await _resolveVenueId(client, mapped.primary_venue_id, venuesMap);
  const lineUidForWrite = String(lineUid || '').trim();

  // Canonical identity order: LINE UID -> phone -> explicit source link. A
  // bare Ragic record id is never accepted as proof that two people are one.
  const byUid = lineUidForWrite
    ? (await client.query(`SELECT * FROM parents WHERE line_uid=$1 FOR UPDATE`, [lineUidForWrite])).rows[0] || null
    : null;
  const byPhoneRows = (await client.query(
    `SELECT * FROM parents
      WHERE phone=$1 OR regexp_replace(COALESCE(phone,''),'\\D','','g')=$1
      ORDER BY created_at,id FOR UPDATE`,
    [phone]
  )).rows;
  if (byPhoneRows.length > 1) {
    throw new BindConflictError('DATA_RECONCILIATION_PENDING', 'canonical phone 命中多個 parent');
  }
  const byPhone = byPhoneRows[0] || null;
  const byLink = ragicRecordId
    ? (await client.query(
      `SELECT p.* FROM source_record_links l JOIN parents p ON p.id=l.canonical_parent_id
        WHERE l.source_system='RAGIC' AND l.source_table='Z01' AND l.source_record_id=$1
        FOR UPDATE OF p`, [ragicRecordId]
    )).rows[0] || null
    : null;
  const candidates = new Map([byUid, byPhone, byLink].filter(Boolean).map((row) => [String(row.id), row]));
  if (candidates.size > 1) {
    throw new BindConflictError('DATA_RECONCILIATION_PENDING', 'LINE UID、canonical phone 與 source link 指向不同 parent');
  }
  let parent = candidates.values().next().value || null;
  if (parent && normalizePhone(parent.phone) !== phone) {
    throw new BindConflictError('ACCOUNT_RECOVERY_REQUIRED', 'LINE UID 或 source link 指向不同手機');
  }
  if (parent?.line_uid && lineUidForWrite && parent.line_uid !== lineUidForWrite) {
    throw new BindConflictError('ACCOUNT_RECOVERY_REQUIRED', 'canonical parent 已綁定另一個 LINE UID');
  }

  if (!parent) {
    try {
      parent = (await client.query(
        `INSERT INTO parents
           (phone,name,line_uid,primary_venue_id,gender,email,ragic_record_id,identity,
            home_phone,home_address,line_id,is_active,last_synced_at)
         VALUES ($1,$2,NULLIF($3,''),$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),
                 NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),NULLIF($11,''),TRUE,NOW())
         RETURNING *`,
        [phone, name, lineUidForWrite, venueId, ragic.normalizeGender(mapped.gender), mapped.email || '',
         ragicRecordId, mapped.identity || '', mapped.home_phone || '', mapped.home_address || '', mapped.line_id || '']
      )).rows[0];
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'uq_parents_ragic_record_id') {
        throw new BindConflictError('DATA_RECONCILIATION_PENDING', 'Ragic source id 已存在但缺少安全 source link');
      }
      throw err;
    }
  } else {
    parent = (await client.query(
      `UPDATE parents SET
         name=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN name ELSE COALESCE(NULLIF($2,''),name) END,
         line_uid=CASE WHEN $12::boolean THEN NULLIF($3,'') ELSE COALESCE(line_uid,NULLIF($3,'')) END,
         primary_venue_id=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN primary_venue_id ELSE COALESCE($4,primary_venue_id) END,
         gender=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN gender ELSE COALESCE(NULLIF($5,''),gender) END,
         email=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN email ELSE COALESCE(NULLIF($6,''),email) END,
         identity=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN identity ELSE COALESCE(NULLIF($7,''),identity) END,
         home_phone=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN home_phone ELSE COALESCE(NULLIF($8,''),home_phone) END,
         home_address=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN home_address ELSE COALESCE(NULLIF($9,''),home_address) END,
         line_id=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN line_id ELSE COALESCE(NULLIF($10,''),line_id) END,
         ragic_record_id=COALESCE(ragic_record_id,NULLIF($11,'')),
         is_active=CASE WHEN $14::boolean THEN TRUE ELSE is_active END,
         last_synced_at=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN last_synced_at ELSE NOW() END,
         updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [parent.id, name, lineUidForWrite, venueId, ragic.normalizeGender(mapped.gender), mapped.email || '',
       mapped.identity || '', mapped.home_phone || '', mapped.home_address || '', mapped.line_id || '',
       ragicRecordId, overwriteLineUid, preservePending, reactivate]
    )).rows[0];
  }
  return parent;
}

async function _queryWithLineUidRetry(client, sql, buildParams, lineUidForWrite, phone) {
  if (!lineUidForWrite) return client.query(sql, buildParams(''));
  let hasSavepoint = false;
  try {
    // 呼叫端（_syncWithLock / ragicAdmin pull）都在交易內；萬一未在交易中
    // （SAVEPOINT 需要 transaction block），退回無 savepoint 路徑，
    // 此時單一語句失敗不會 poison 連線，仍可直接重試。
    await client.query('SAVEPOINT sp_upsert_parent');
    hasSavepoint = true;
  } catch (_) { /* not in a transaction */ }
  try {
    const r = await client.query(sql, buildParams(lineUidForWrite));
    if (hasSavepoint) await client.query('RELEASE SAVEPOINT sp_upsert_parent');
    return r;
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'parents_line_uid_key') {
      if (hasSavepoint) {
        await client.query('ROLLBACK TO SAVEPOINT sp_upsert_parent');
        console.warn('[parent-sync] line_uid 衝突（並發競態），ROLLBACK SAVEPOINT 後不帶 UID 重試 (phone=%s)', maskPhone(phone));
        return client.query(sql, buildParams(''));
      }
      // 無 SAVEPOINT 時（如未在交易中）不嘗試在 ABORT 的 tx 上重試，
      // 直接重拋讓呼叫端做 ROLLBACK；下一輪排程可補回這筆。
      console.warn('[parent-sync] line_uid 衝突（無 SAVEPOINT），由呼叫端 ROLLBACK 處理 (phone=%s)', maskPhone(phone));
      throw err;
    }
    throw err;
  }
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
 *    有 id_number、但不在本次權威清單」且沒有業務 FK 的本地學員做硬刪除。
 *    有 FK 的學員保留原列與關聯，避免課程/簽到/轉讓斷鏈；僅在取得非空權威 id 集合時執行，
 *    避免 Ragic 解析回空時誤殺整批。
 *  - existingStudents（選用）：批次呼叫端可預先撈好「這位家長目前的學員列」陣列
 *    （至少含 id/id_number/ragic_record_id/name/birth_date）傳入，三層比對改成在記憶體裡
 *    做，省掉每位學員 3 次序列 SELECT；不傳就照舊逐筆查 DB（既有單筆呼叫端行為不變）。
 */
async function upsertLocalStudents(client, parentId, students, { authoritative = false, existingStudents = null, preservePending = true } = {}) {
  // tier-3（name+birth）候選的既有列 id：待人工複核期間，權威掃尾不可把它當「Ragic
  // 已無此人」硬刪掉——否則等於繞過複核直接刪除，與決策7的初衷矛盾。
  const reviewCandidateIds = [];
  for (const s of students || []) {
    if (!s || !s.name) continue;
    const idNum  = s.id_number ? String(s.id_number).toUpperCase().trim() : null;
    const ragicId = s.ragic_record_id ? String(s.ragic_record_id).trim() : null;
    let matched = null;
    const incomingName = normalizeStudentName(s.name);
    const familyRows = existingStudents || (await client.query(
      `SELECT id,name,birth_date,id_number,ragic_record_id
         FROM students WHERE parent_id=$1 ORDER BY created_at,id FOR UPDATE`,
      [parentId]
    )).rows;
    const exactNameMatches = familyRows.filter((row) => normalizeStudentName(row.name) === incomingName);
    if (exactNameMatches.length > 1) {
      throw new BindConflictError('DATA_RECONCILIATION_PENDING', '同一家庭內學員姓名精準命中多筆');
    }
    matched = exactNameMatches[0] || null;

    // 單一學員撞唯一鍵（並發競態等）不應讓整位家長同步失敗：SAVEPOINT 隔離，
    // 失敗記 log 跳下一位（該位學員下一輪同步會再收斂）。
    let spActive = false;
    try {
      await client.query('SAVEPOINT sp_upsert_student');
      spActive = true;
    } catch (_) { /* not in a transaction */ }
    try {
      // Ragic record id 全域唯一（uq_students_ragic_record_id）：若這個 rid 目前掛在
      // 「別的家長」名下（Ragic 端把學員子表列搬到本家長、或同電話換記錄後的殘留），
      // 直接寫入會撞唯一鍵讓整位家長的同步失敗（後台顯示 duplicate key ... 錯誤）。
      // 在 SAVEPOINT 內解除舊列的 rid 佔用；若後續本學員 upsert 失敗，rollback 會一起撤回，
      // 不會留下「舊列已清空、新列未取得 rid」的中間狀態。
      if (ragicId && spActive) {
        const freed = await client.query(
          `UPDATE students SET ragic_record_id = NULL, updated_at = NOW()
            WHERE ragic_record_id = $1 AND parent_id <> $2`,
          [ragicId, parentId]
        );
        if (freed.rowCount) {
          console.warn('[parent-sync] 學員 ragic_record_id=%s 原掛在其他家長名下，已解除舊佔用（移轉到 parent=%s）', ragicId, parentId);
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
             ragic_record_id = COALESCE(NULLIF($8,''), ragic_record_id),
             is_active   = CASE WHEN is_active = FALSE THEN is_active ELSE TRUE END,
             last_synced_at = CASE WHEN $9::boolean AND last_synced_at IS NULL THEN last_synced_at ELSE NOW() END,
             updated_at  = NOW()
           WHERE id = $1`,
          [matched.id, s.name, s.birth_date || null, ragic.normalizeGender(s.gender),
           idNum || '', s.blood_type || '', s.student_code || '', ragicId || '', preservePending]
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO students
             (parent_id, name, birth_date, gender, id_number, blood_type, student_code, ragic_record_id, is_active, last_synced_at)
           VALUES ($1, $2, $3::date, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), NULLIF($7,''), NULLIF($8,''), TRUE, NOW())
           RETURNING id`,
          [parentId, s.name, s.birth_date || null, ragic.normalizeGender(s.gender),
           idNum || '', s.blood_type || '', s.student_code || '', ragicId || '']
        );
        if (existingStudents) existingStudents.push({
          id: inserted.rows[0].id,
          name: s.name,
          birth_date: s.birth_date || null,
          id_number: idNum,
          ragic_record_id: ragicId,
        });
      }
      if (spActive) await client.query('RELEASE SAVEPOINT sp_upsert_student');
    } catch (err) {
      if (err.code === '23505' && spActive) {
        await client.query('ROLLBACK TO SAVEPOINT sp_upsert_student');
        await client.query('RELEASE SAVEPOINT sp_upsert_student').catch(() => {});
        console.warn('[parent-sync] 學員 upsert 撞唯一鍵（%s），略過此學員待下輪收斂 (parent=%s, name=%s)',
          err.constraint || 'unique', parentId, maskName(s.name));
        continue;
      }
      throw err;
    }
  }

  if (authoritative && STABILITY_FLAGS.DESTRUCTIVE_RECONCILE_ENABLED) {
    const presentIdNums = [...new Set(
      (students || [])
        .map((s) => (s && s.id_number ? String(s.id_number).toUpperCase().trim() : null))
        .filter(Boolean)
    )];
    const presentRagicIds = [...new Set(
      (students || [])
        .map((s) => (s && s.ragic_record_id ? String(s.ragic_record_id).trim() : null))
        .filter(Boolean)
    )];
    if (presentIdNums.length > 0 || presentRagicIds.length > 0) {
      const candidates = await client.query(
        `SELECT id
           FROM students
          WHERE parent_id = $1
            AND ragic_record_id IS NOT NULL
            AND NOT ($4::boolean AND last_synced_at IS NULL)
            AND NOT (
              (array_length($2::text[], 1) IS NOT NULL AND ragic_record_id = ANY($2::text[]))
              OR
              (array_length($3::text[], 1) IS NOT NULL
               AND id_number IS NOT NULL
               AND UPPER(id_number) = ANY($3::text[]))
            )
            AND NOT (array_length($5::uuid[], 1) IS NOT NULL AND id = ANY($5::uuid[]))`,
        [parentId, presentRagicIds, presentIdNums, preservePending, reviewCandidateIds]
      );
      for (const row of candidates.rows) {
        await hardDeleteStudentIfSafe(client, row.id);
      }
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
  // Compatibility no-op: identity reconciliation is permanently
  // non-destructive and no feature flag may reactivate hard deletion.
  void db;
  void parentId;
  return false;
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
      throw new BindConflictError('ACCOUNT_RECOVERY_REQUIRED',
        '此 LINE UID 已由另一個 canonical parent 持有，需完成帳號恢復驗證');
    }
    const dupPhone = await client.query(
      `SELECT line_uid FROM parents WHERE phone = $1 AND is_active = TRUE LIMIT 1`, [phone]);
    if (dupPhone.rowCount && dupPhone.rows[0].line_uid && dupPhone.rows[0].line_uid !== lineUid) {
      throw new BindConflictError('ACCOUNT_RECOVERY_REQUIRED',
        '此手機已綁定其他 LINE 帳號，需完成帳號恢復驗證');
    }

    const local = await upsertLocalParent(client, mapped, lineUid, {
      reactivate,
      overwriteLineUid: allowRebind,
      preservePending,
    });

    if (local.line_uid && local.line_uid !== lineUid) {
      throw new BindConflictError('PHONE_ALREADY_BOUND_TO_OTHER_LINE',
        '此手機已綁定其他 LINE 帳號，請聯絡客服處理');
    }

    // 來源為 Ragic 權威清單 → 開啟 id-stable upsert + 權威移除清理。
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

async function linkFromRagicRecordLocalFirst(z01Row, lineUid, { reactivate = true } = {}) {
  const trueUid = getTrueRagicLineUid(z01Row);
  if (!trueUid || trueUid !== String(lineUid || '').trim()) {
    throw new BindConflictError(trueUid ? 'ACCOUNT_RECOVERY_REQUIRED' : 'RAGIC_UID_WRITE_PENDING',
      trueUid ? 'Ragic source 已綁定另一個 LINE UID' : 'Ragic source 尚未綁定 LINE UID');
  }
  const mapped = { ...ragic.mapZ01Parent(z01Row), line_uid: trueUid };
  const sourceRecordId = String(mapped.ragic_record_id || '').trim();
  if (!sourceRecordId) throw new BindConflictError('LOCAL_LINK_FAILED', 'Ragic source record id 缺失', 500);
  const students = ragic.parseZ01Students(z01Row);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const phone = normalizePhone(mapped.phone);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`canonical-parent:${phone}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ragic-z01:${sourceRecordId}`]);
    const parent = await upsertLocalParent(client, { ...mapped, phone }, trueUid, {
      reactivate,
      overwriteLineUid: false,
      preservePending: true,
    });
    await upsertLocalStudents(client, parent.id, students, { authoritative: false, preservePending: true });
    await client.query(
      `INSERT INTO source_record_links
         (source_system,source_table,source_record_id,canonical_parent_id,link_method)
       VALUES ('RAGIC','Z01',$1,$2,'TRUE_LINE_UID_EXACT')
       ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
         canonical_parent_id=EXCLUDED.canonical_parent_id,
         link_method=EXCLUDED.link_method,updated_at=NOW()`,
      [sourceRecordId, parent.id]
    );
    await client.query('COMMIT');
    return parent;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function linkSourceAliases({ parentId, sourceRecordIds = [], studentName = '' } = {}) {
  const ids = [...new Set(sourceRecordIds.map((value) => String(value || '').trim()).filter(Boolean))];
  if (!parentId || !ids.length) return { linked: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const parent = (await client.query(`SELECT * FROM parents WHERE id=$1 FOR UPDATE`, [parentId])).rows[0];
    if (!parent) throw new BindConflictError('LOCAL_LINK_FAILED', 'canonical parent 不存在', 500);
    const normalizedName = normalizeStudentName(studentName);
    const students = normalizedName
      ? (await client.query(`SELECT * FROM students WHERE parent_id=$1 FOR UPDATE`, [parentId])).rows
        .filter((row) => normalizeStudentName(row.name) === normalizedName)
      : [];
    if (students.length > 1) throw new BindConflictError('DATA_RECONCILIATION_PENDING', 'canonical student 命中多筆');
    for (const sourceRecordId of ids) {
      const existing = (await client.query(
        `SELECT * FROM source_record_links WHERE source_system='RAGIC' AND source_table='Z01'
          AND source_record_id=$1 FOR UPDATE`, [sourceRecordId]
      )).rows[0];
      if (existing && String(existing.canonical_parent_id) !== String(parentId)) {
        throw new BindConflictError('DATA_RECONCILIATION_PENDING', 'source alias 已指向另一個 parent');
      }
      await client.query(
        `INSERT INTO source_record_links
           (source_system,source_table,source_record_id,canonical_parent_id,canonical_student_id,link_method)
         VALUES ('RAGIC','Z01',$1,$2,$3,'MULTIPLE_SOURCE_ALIAS')
         ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
           canonical_parent_id=EXCLUDED.canonical_parent_id,
           canonical_student_id=COALESCE(source_record_links.canonical_student_id,EXCLUDED.canonical_student_id),
           link_method=EXCLUDED.link_method,updated_at=NOW()`,
        [sourceRecordId, parentId, students[0]?.id || null]
      );
    }
    await client.query('COMMIT');
    return { linked: ids.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 認領驗證：把家長提供的「學員姓名 + 身分證字號」與「即將連結的 Ragic 學員清單」比對。
 * 兩者皆需提供、且與某一位學員的 (姓名, 身分證) 完全一致才回 true。
 */
function matchStudentClaim(ragicStudents, claim) {
  return classifyStudentClaim(ragicStudents, claim) === 'matched';
}

function _normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const half = raw.replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xFF10));
  const compact = half.replace(/[\s\-()]/g, '');
  if (compact.startsWith('+886')) return `0${compact.slice(4)}`.replace(/\D/g, '');
  if (compact.startsWith('886') && compact.length === 12) return `0${compact.slice(3)}`.replace(/\D/g, '');
  return compact.replace(/\D/g, '');
}

// 學員姓名查找用正規化：僅供「找出對應的 Ragic 學員」比對，不放寬身分證字號/電話
// 這類真正的身分驗證。.normalize('NFKC') 收斂全形/半形（如中文輸入法打出的「Ｅｒｉｃ」），
// .toLowerCase() 收斂大小寫，.replace(/\s+/g,' ') 收斂內部多餘空白。
function _normalizeStudentName(v) {
  return String(v || '').trim().toLowerCase().normalize('NFKC').replace(/\s+/g, ' ');
}

/**
 * 認領驗證分類版：區分「真的比對不符」與「Ragic 該學員本來就沒存身分證字號、
 * 家長不可能比對得過」、以及「這個姓名根本還沒建檔」三種狀況，讓 caller 能回
 * 不同的錯誤碼與文案（後者是資料缺口，不是使用者打錯，不該顯示「請確認後再試」）。
 *   'matched'        姓名 + 身分證字號都對上
 *   'no_id_on_file'  姓名對上，但該筆 Ragic 學員身分證字號欄位是空的（無從比對）
 *   'not_on_file'    姓名對不上任何現有學員 → 視為尚未建檔的新學生，不是衝突
 *   'mismatch'       姓名有對到某位現有學員，但身分證字號對不上（Ragic 有值但不同）
 */
function classifyStudentClaim(ragicStudents, claim) {
  const name = String(claim?.student_name || claim?.name || '').trim();
  const id   = String(claim?.id_number || '').trim().toUpperCase();
  if (!name || !id) return 'mismatch';
  const byName = (ragicStudents || []).find((s) => _normalizeStudentName(s.name) === _normalizeStudentName(name));
  if (!byName) return 'not_on_file';
  const ragicId = String(byName.id_number || '').trim().toUpperCase();
  if (!ragicId) return 'no_id_on_file';
  return ragicId === id ? 'matched' : 'mismatch';
}

/**
 * 認領驗證（手機版）：使用者提供「學員姓名 + 登記手機號碼」。
 * 若 Ragic Z01 學員子表有「登記電話」欄，優先比對該欄；否則退回比對 Z01 家長手機。
 */
function classifyStudentPhoneClaim(ragicStudents, claim, parentPhone) {
  const name = String(claim?.student_name || claim?.name || '').trim();
  const phone = _normalizePhone(claim?.phone || claim?.parent_phone || claim?.registered_phone || '');
  if (!name || !phone) return 'mismatch';
  const byName = (ragicStudents || []).find((s) => _normalizeStudentName(s.name) === _normalizeStudentName(name));
  if (!byName) return 'not_on_file';
  const expectedPhone = _normalizePhone(byName.registered_phone || parentPhone || '');
  if (!expectedPhone) return 'mismatch';
  return phone === expectedPhone ? 'matched' : 'mismatch';
}

/** 認領稽核：寫進伺服器日誌；門號雜湊、line_uid 遮罩，嚴禁落地完整 PII。 */
function auditClaim({ phone, lineUid, result, reason }) {
  const phoneHash = phone
    ? crypto.createHash('sha256').update(String(phone)).digest('hex').slice(0, 12)
    : null;
  const uidHash = lineUid
    ? crypto.createHash('sha256').update(String(lineUid)).digest('hex').slice(0, 12)
    : null;
  console.log('[claim-audit]', JSON.stringify({ phoneHash, uidHash, result, reason: reason || null }));
}

/**
 * 供批次呼叫端（整批 Ragic→本地同步）一次撈好「電話 → 該家長目前學員列」的對照表，
 * 餵給 upsertLocalStudents 的 existingStudents 選項，避免逐位家長各查一次。
 */
async function loadStudentsByParentPhone(client) {
  // 不篩 is_active：若 Ragic 權威清單仍包含同一位學員，應比對到既有列後就地更新，
  // 避免批次同步誤判成新學員而重複建立。
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
 * 供批次呼叫端一次撈好「已綁定 line_uid 的手機 → 該 UID」對照——用來判斷某支手機
 * 是否已經有真人透過即時登入流程建過帳號（見 ragicAdmin.js _pullParentsStudentsImpl
 * 的 Z03 分流規則：已綁定的人即使姓名是佔位資料也不能被排除在 parents 同步之外）。
 * 回傳 Map(phone → line_uid)；.has(phone) 語意與先前的 Set 相容。
 */
async function loadBoundPhones(client) {
  const r = await client.query(
    `SELECT phone, line_uid FROM parents
      WHERE is_active = TRUE
        AND line_uid IS NOT NULL AND line_uid <> ''
        AND line_uid NOT LIKE 'demo:%'
        AND line_uid NOT LIKE 'DEMOTEST_%'`
  );
  return new Map(r.rows.map((row) => [row.phone, row.line_uid]));
}

module.exports = {
  BindConflictError,
  findActiveParentByLineUid,
  upsertLocalParent,
  upsertLocalStudents,
  loadVenuesMap,
  loadStudentsByParentPhone,
  loadBoundPhones,
  hardDeleteParentIfSafe,
  _syncWithLock,
  syncFromRagicRecord,
  linkFromRagicRecordLocalFirst,
  linkSourceAliases,
  matchStudentClaim,
  classifyStudentClaim,
  classifyStudentPhoneClaim,
  auditClaim,
};
