'use strict';

const crypto = require('crypto');
const { pool } = require('../models/db');
const { writeStudentAudit, parentActor, diffChanges } = require('./studentAudit');
const ragic = require('./ragic');
const parentSync = require('./parentSync');
const { BindConflictError } = parentSync;
const { getTrueRagicLineUid } = require('../config/ragicSchema');
const { normalizePhone, normalizeStudentName, isCanonicalMobilePhone } = require('./identityNormalizer');
const { resolveMultipleSourceCandidate } = require('./parentIdentityResolver');
const { evaluateParentIdentityCanary } = require('./parentIdentityCanary');
const { createParentIdentityBackofficeTask } = require('./parentIdentityBackoffice');
const {
  buildParentProfilePatch,
  insertProfilePatchAudit,
} = require('./parentRegistrationProfile');
const { matchStudent } = require('./claimStudentMatcher');
const claimAttempts = require('./claimAttempts');

const CLAIM_MISMATCH_MESSAGE = '學員資料與登記資料不符：請確認學員姓名，或填寫學員身分證字號後再試；仍無法通過請洽櫃台協助。';
const CLAIM_COOLDOWN_MESSAGE = `學員資料核對錯誤次數過多，請 ${claimAttempts.COOLDOWN_MINUTES} 分鐘後再試，或洽櫃台協助。`;

// 預建家長一次最多核對幾位學員：名字越多等於一次猜越多次（其餘學員登入後再新增）。
const MAX_PREBUILT_CLAIM_STUDENTS = 3;
const CLAIM_TOO_MANY_STUDENTS_MESSAGE = `一次最多填 ${MAX_PREBUILT_CLAIM_STUDENTS} 位學員，其他學員請登入後再新增。`;

// 會新增學員的路徑判斷「和登記的只差一字」只比姓名、不帶身分證：身分證不同正好表示是另一個孩子，照樣另建並標 NEW_SIMILAR。
function _nearByName(rows, name) {
  const v = matchStudent(rows, { name });
  return v?.method === 'NEAR' ? v : null;
}

// 靠身分證或差一字比對時只用 Ragic 最新資料裡還在的學員：已移除的歷史學員不能拿來過關。
// （缺生日、同名重複的 INVALID_ROW／DUPLICATE_CANDIDATE 仍是真的孩子，照樣可比；完全同名的比對不受這條限制。）
const _fuzzyEligible = (row) => row.present_in_latest_payload !== false && row.classification !== 'EMPTY_TEMPLATE_ROW';

// 同名的登記列和送來的身分證衝不衝突（學員以身分證為唯一鍵）：有一筆身分證相同就算對上；
// 否則只拿還在的列比，Ragic 刪掉重打留下的已移除舊列不拿來擋人。rows：{ id_number, row（_fuzzyEligible 用）}
function _sameNameIdConflict(rows, idNumber) {
  const id = String(idNumber || '').trim().toUpperCase();
  const ids = (list) => list.map((r) => String(r.id_number || '').trim().toUpperCase()).filter(Boolean);
  if (!id || ids(rows).includes(id)) return false;
  return ids(rows.filter((r) => _fuzzyEligible(r.row))).length > 0;
}

// 註冊頁一次最多填 MAX_PREBUILT_CLAIM_STUDENTS 位學員，填了幾位就算猜了幾次。照 claimZ03Identity 的順序（同名 → 身分證 → 只差一字）
// 挑一位當核對對象，家長不必把已登記的孩子填在第一位；家庭範圍與比對資料都和 claimZ03Identity 相同。
// 其餘交給 claimZ03Identity 在同一筆交易裡連結或新增。
// 身分證為主（Owner 2026-10-20）：同名但身分證和登記的不同（_sameNameIdConflict）是這一戶的另一個孩子，
// 同名仍證明是這一戶，但優先挑同名且身分證相符的那位當核對對象，填寫順序不影響結果。
// 好幾位都沒有同名／身分證對上、只靠其中一位差一字：視為新戶（Owner 2026-10-20），另建帳號、不碰舊系統那一戶。
async function pickRegistrationClaimStudent(phone, students, db = pool) {
  if (students.length > MAX_PREBUILT_CLAIM_STUDENTS) {
    throw new Z03ClaimError('CLAIM_TOO_MANY_STUDENTS', CLAIM_TOO_MANY_STUDENTS_MESSAGE, 400);
  }
  const rows = (await db.query(
    `SELECT s.name_raw AS name, s.id_number_raw AS id_number, s.present_in_latest_payload, s.classification
       FROM ragic_z03_students s JOIN ragic_z03_records r ON r.id = s.z03_record_id
      WHERE (r.phone_canonical = $1 OR regexp_replace(COALESCE(r.phone,''), '\\D', '', 'g') = $1)
        AND r.status IN ('pending','resolved','manual_review')`, [normalizePhone(phone)]
  )).rows;
  const fuzzyRows = rows.filter(_fuzzyEligible);
  const sameName = (s) => rows.filter((row) => normalizeStudentName(row.name) === normalizeStudentName(s.name))
    .map((row) => ({ id_number: row.id_number, row }));
  const exact = students.findIndex((s) => sameName(s).length > 0);
  const strictExact = students.findIndex((s) => sameName(s).length > 0 && !_sameNameIdConflict(sameName(s), s.id_number));
  const byId = students.findIndex((s) => matchStudent(fuzzyRows, s, { allowNear: false })?.method === 'ID');
  const near = students.map((s) => _nearByName(fuzzyRows, s.name));
  const firstNear = near.findIndex(Boolean);
  const index = [strictExact, byId, exact, firstNear].find((i) => i >= 0) ?? 0;
  return {
    student: students[index],
    extraStudents: students.filter((_, i) => i !== index),
    guesses: students.length,
    newAccount: exact < 0 && byId < 0 && firstNear >= 0 && students.length > 1,
    similarNames: near.filter(Boolean).map((v) => String(v.candidates[0].name || '').trim()),
  };
}

// 註冊頁其餘填寫的學員對照登記的孩子（Owner 2026-10-20）：同名且身分證相符、或身分證對上的連結；其餘另建，
// 同名但身分證不同（身分證為主，是另一個孩子）或和登記學員只差一字的記 NEW_SIMILAR。
// 比對資料同主核對對象：同名看全部（身分證衝突照 _sameNameIdConflict），身分證／差一字只看 _fuzzyEligible。
// 同一個名字填兩次（含核對對象）、或兩位對到同一位登記學員，整筆當核對失敗。
function _classifyExtraStudents(childRows, primaryRows, students, primaryName = '') {
  const names = [primaryName, ...students.map((s) => s.name)].map(normalizeStudentName).filter(Boolean);
  if (new Set(names).size !== names.length) return { invalid: true };
  const candidates = childRows.map((row) => ({ name: row.name_raw, id_number: row.id_number_raw, row }));
  const fuzzy = candidates.filter((c) => _fuzzyEligible(c.row));
  const taken = new Set(primaryRows.map((row) => row.id));
  const verdicts = students.map((s) => {
    const sameName = candidates.filter((c) => normalizeStudentName(c.name) === normalizeStudentName(s.name));
    if (!sameName.length) return matchStudent(fuzzy, s, { allowNear: false });
    if (_sameNameIdConflict(sameName, s.id_number)) return { newChild: String(sameName[0].name || '').trim() };
    return { method: 'EXACT', candidates: sameName };
  });
  const linked = [];
  for (const v of verdicts) {
    if (!v || v.newChild) continue;
    if (v.conflict) return { invalid: true };
    const rows = v.candidates.map((c) => c.row);
    if (rows.some((row) => taken.has(row.id))) return { invalid: true };
    rows.forEach((row) => taken.add(row.id));
    linked.push(rows);
  }
  const appended = students.filter((_, i) => !verdicts[i] || verdicts[i].newChild);
  const similarNames = students.map((s, i) => verdicts[i]?.newChild
    || (!verdicts[i] && _nearByName(fuzzy, s.name)?.candidates[0].name)).filter(Boolean)
    .map((name) => String(name).trim());
  return { linked, appended, similarNames };
}

const _cooldownError = () => new Z03ClaimError('CLAIM_COOLDOWN', CLAIM_COOLDOWN_MESSAGE, 429);

// 認領結果寫回嘗試紀錄：用同一條連線（交易已結束），寫不進去只記 log，不改變回給家長的結果。
async function _finishClaimAttempt(client, attempt, result) {
  if (!attempt) return;
  await claimAttempts.finishClaimAttempt(attempt.id, result, client).catch((err) => {
    console.error('[claimAttempts] 結果寫入失敗：', err.code || err.message);
  });
}

class Z03ClaimError extends Error {
  constructor(code, message, http = 409, details = {}) {
    super(message);
    this.name = 'Z03ClaimError';
    this.code = code;
    this.http = http;
    Object.assign(this, details);
  }
}

function _lineUidHash(lineUid) {
  return crypto.createHash('sha256').update(String(lineUid || '')).digest('hex');
}

function _safeDate(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!m) return null;
  const normalized = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return Number.isNaN(new Date(`${normalized}T00:00:00+08:00`).getTime()) ? null : normalized;
}

function _sourceProfileFromFamily(family, trueLineUid = '') {
  return {
    name: family?.raw_name || '',
    phone: family?.phone || '',
    email: family?.email_raw || '',
    home_phone: family?.home_phone_raw || '',
    home_address: family?.home_address_raw || '',
    line_id: family?.line_id_raw || '',
    line_uid: String(trueLineUid || ''),
  };
}

async function _applyAllowlistedLocalProfile(client, parent, parentProfile = {}, ownershipVerified = false) {
  const incomingName = String(parentProfile.name || '').trim();
  const incomingEmail = String(parentProfile.email || '').trim();
  const incomingHomePhone = String(parentProfile.home_phone || '').trim();
  const incomingHomeAddress = String(parentProfile.home_address || '').trim();
  const incomingLineId = String(parentProfile.line_id || '').trim();
  return (await client.query(
    `UPDATE parents SET
       name=CASE WHEN (name IS NULL OR BTRIM(name)='' OR name='未命名家長') AND $2<>'' THEN $2 ELSE name END,
       email=CASE WHEN $7::boolean AND $3<>'' THEN $3 WHEN (email IS NULL OR BTRIM(email)='') THEN NULLIF($3,'') ELSE email END,
       home_phone=CASE WHEN $7::boolean AND $4<>'' THEN $4 WHEN (home_phone IS NULL OR BTRIM(home_phone)='') THEN NULLIF($4,'') ELSE home_phone END,
       home_address=CASE WHEN $7::boolean AND $5<>'' THEN $5 WHEN (home_address IS NULL OR BTRIM(home_address)='') THEN NULLIF($5,'') ELSE home_address END,
       line_id=CASE WHEN $7::boolean AND $6<>'' THEN $6 WHEN (line_id IS NULL OR BTRIM(line_id)='') THEN NULLIF($6,'') ELSE line_id END,
       updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [parent.id, incomingName, incomingEmail, incomingHomePhone, incomingHomeAddress,
     incomingLineId, Boolean(ownershipVerified)]
  )).rows[0];
}

async function _insertOrReuseStudent(client, parentId, studentInput) {
  const normalized = normalizeStudentName(studentInput?.name);
  const submittedId = String(studentInput?.id_number || '').trim().toUpperCase();
  // 身分證為主（Owner 2026-10-20）：同名但身分證不同是另一個孩子，不沿用那一筆。
  const existing = (await client.query(
    `SELECT * FROM students WHERE parent_id=$1 ORDER BY created_at,id FOR UPDATE`, [parentId]
  )).rows.filter((row) => normalizeStudentName(row.name) === normalized
    && !(submittedId && row.id_number && String(row.id_number).trim().toUpperCase() !== submittedId));
  if (existing.length > 1) {
    throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', 'canonical family 內同名 student 命中多筆', 409);
  }
  if (existing[0]) return { student: existing[0], appended: false };
  const student = (await client.query(
    `INSERT INTO students
       (parent_id,name,birth_date,gender,id_number,blood_type,student_code,is_active,last_synced_at)
     VALUES ($1,$2,$3::date,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),TRUE,NULL)
     RETURNING *`,
    [parentId, String(studentInput?.name || '').trim(), _safeDate(studentInput?.birth_date),
     studentInput?.gender || '', String(studentInput?.id_number || '').trim().toUpperCase(),
     studentInput?.blood_type || '', studentInput?.student_code || '']
  )).rows[0];
  await writeStudentAudit(client, student.id, 'create', parentActor(parentId, 'identity-registration-append'));
  return { student, appended: true };
}

// 本地已有的學員只補空白欄位（不覆蓋）；身分證不和同戶其他學員重複才補。
async function _fillBlankStudentFields(client, parentId, student, input, note) {
  const filled = (await client.query(
    `UPDATE students
        SET birth_date=COALESCE(birth_date,$2::date),
            gender=COALESCE(NULLIF(gender,''),NULLIF($3,'')),
            blood_type=COALESCE(NULLIF(blood_type,''),NULLIF($4,'')),
            id_number=CASE WHEN NULLIF(id_number,'') IS NULL AND NULLIF($5,'') IS NOT NULL
                            AND NOT EXISTS (SELECT 1 FROM students x
                                             WHERE x.parent_id=students.parent_id AND x.id_number=$5 AND x.id<>students.id)
                           THEN $5 ELSE id_number END,
            updated_at=NOW()
      WHERE id=$1
      RETURNING *`,
    [student.id, _safeDate(input.birth_date), input.gender || '',
     input.blood_type || '', String(input.id_number || '').trim().toUpperCase()]
  )).rows[0];
  await writeStudentAudit(client, filled.id, 'edit', {
    ...parentActor(parentId, note), changes: diffChanges(student, filled),
  });
  return filled;
}

// 登記在 Z03 的孩子鏡射成本地學員（資料以登記的為準）。
async function _mirrorSourceStudent(client, parentId, child) {
  const student = (await client.query(
    `INSERT INTO students
       (parent_id,name,birth_date,gender,blood_type,student_code,is_active,last_synced_at)
     VALUES ($1,$2,$3::date,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),TRUE,NOW())
     RETURNING *`,
    [parentId, child.name_raw, _safeDate(child.birth_date_raw),
     child.gender_raw || '', child.blood_type_raw || '', child.student_code_raw || '']
  )).rows[0];
  await writeStudentAudit(client, student.id, 'create', parentActor(parentId, 'legacy-claim-source-mirror'));
  return student;
}

// 其餘學員（_classifyExtraStudents 的結果）寫進本地：對上登記的鏡射並回填 canonical_student_id；
// 新的另建，回傳要送 Ragic 的那幾位。canAppend 為 false（這筆認領沒有 outbox 可送 Ragic）時新的不建，回傳已忽略的姓名。
async function _attachExtraStudents(client, parentId, extras, { canAppend }) {
  for (const rows of extras.linked) {
    const wanted = normalizeStudentName(rows[0].name_raw);
    const same = (await client.query(
      `SELECT * FROM students WHERE parent_id=$1 ORDER BY created_at,id FOR UPDATE`, [parentId]
    )).rows.filter((row) => normalizeStudentName(row.name) === wanted);
    if (same.length > 1) throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', 'canonical family 內同名 student 命中多筆', 409);
    const student = same[0] || await _mirrorSourceStudent(client, parentId, rows[0]);
    await client.query(`UPDATE ragic_z03_students SET canonical_student_id=$2 WHERE id=ANY($1::bigint[])`,
      [rows.map((row) => row.id), student.id]);
  }
  if (!canAppend) return { toRagic: [], ignored: extras.appended.map((s) => String(s.name || '').trim()) };
  const toRagic = [];
  for (const input of extras.appended) {
    const { student, appended } = await _insertOrReuseStudent(client, parentId, input);
    if (appended) { toRagic.push(input); continue; }
    // 沿用的本地學員還不在 Ragic（例如舊系統預建、只有姓名）：補上這次填的資料，照樣送 Ragic。
    if (!student.ragic_record_id) {
      await _fillBlankStudentFields(client, parentId, student, input, 'identity-registration-append-fill');
      toRagic.push(input);
    }
  }
  return { toRagic, ignored: [] };
}

function _payloadHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function _classifyConstraint(err) {
  if (err?.code === 'PHONE_AMBIGUOUS') return 'PHONE_AMBIGUOUS';
  if (err?.code !== '23505') return 'LOCAL_LINK_FAILED';
  const byConstraint = {
    uq_parents_phone_canonical_active: 'PHONE_AMBIGUOUS',
    parents_phone_key: 'DATA_RECONCILIATION_PENDING',
    parents_line_uid_key: 'ACCOUNT_RECOVERY_REQUIRED',
    uq_parents_ragic_record_id: 'DATA_RECONCILIATION_PENDING',
    uq_students_ragic_record_id: 'DATA_RECONCILIATION_PENDING',
    uq_identity_claims_active_source: 'DATA_RECONCILIATION_PENDING',
    // 新戶註冊實際會撞到的是這條 5 欄唯一索引
    // (purpose, student_name_normalized, source_system, source_table, source_record_id)，
    // 它原本不在表上，於是同一家人重送註冊時拿到的是兜底的 LOCAL_LINK_FAILED ——
    // 那個碼帶 retryable:false / loginAllowed:false，對家長是一條死路。
    // 歸到 DATA_RECONCILIATION_PENDING 才會走人工複核，而不是把人擋在門外。
    identity_claims_purpose_source_system_source_table_source_r_key: 'DATA_RECONCILIATION_PENDING',
  };
  return byConstraint[err.constraint] || 'LOCAL_LINK_FAILED';
}

async function registerNewParentLocalFirst({
  parent: parentInput,
  students = [],
  lineUid,
  idempotencyKey,
  similarOnFile = [],
  correlationId = crypto.randomUUID(),
} = {}) {
  const phoneCanonical = normalizePhone(parentInput?.phone);
  const uid = String(lineUid || '').trim();
  const cleanStudents = students.filter((s) => normalizeStudentName(s?.name));
  if (!phoneCanonical || !uid || !cleanStudents.length) {
    throw new Z03ClaimError('LOCAL_LINK_FAILED', '建立本地身分所需資料不足', 400);
  }
  const requestKey = String(idempotencyKey || _payloadHash({ uid, phoneCanonical, names: cleanStudents.map((s) => normalizeStudentName(s.name)) }));
  const lineUidHash = _lineUidHash(uid);
  const payload = { parent: { ...parentInput, phone: phoneCanonical }, students: cleanStudents };
  const payloadHash = _payloadHash(payload);
  const client = await pool.connect();
  let attempt = null;
  // 舊系統有這支電話、但視為新戶另建（Owner 2026-10-20）：和登記的孩子只差一字的記 NEW_SIMILAR 給櫃台反查。
  let attemptResult = similarOnFile.length
    ? { outcome: 'NEW_SIMILAR', matchedName: similarOnFile.join('、') }
    : { outcome: 'REGISTERED' };
  let failedPrebuiltClaim = null;
  try {
    attempt = await claimAttempts.reserveClaimAttempt({
      lineUid: uid, phone: phoneCanonical, path: 'REGISTER',
      submittedName: cleanStudents.map((s) => s.name).join('、'),
      submittedIdNumber: cleanStudents.map((s) => s.id_number || '').join(''),
      guesses: cleanStudents.length,
    }, client);
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`canonical-parent:${phoneCanonical}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`line-uid:${lineUidHash}`]);
    const replay = (await client.query(
      `SELECT r.*,p.* FROM parent_identity_requests r
        LEFT JOIN parents p ON p.id=r.canonical_parent_id
       WHERE r.line_uid_hash=$1 AND r.operation='NEW_REGISTRATION' AND r.idempotency_key=$2
       FOR UPDATE OF r`, [lineUidHash, requestKey]
    )).rows[0] || null;
    if (replay) {
      if (replay.payload_hash !== payloadHash) {
        throw new Z03ClaimError('LOCAL_LINK_FAILED', '相同 idempotency key 的 payload 不一致', 409);
      }
      await client.query('COMMIT');
      attemptResult = { outcome: 'REPLAYED' };
      return { parent: replay, replayed: true, sync_state: replay.state, correlation_id: replay.correlation_id };
    }
    // 從舊系統那一戶轉來的新戶也是核對過名字的，和 Z03 認領一樣按名字數算到上限，免得兩種回應透露哪個名字差一字。
    if (attempt.coolingDown
        || (similarOnFile.length && attempt.priorGuesses + cleanStudents.length > claimAttempts.FAILURE_LIMIT)) {
      attemptResult = { outcome: 'COOLDOWN' };
      throw _cooldownError();
    }

    const byUid = (await client.query(`SELECT * FROM parents WHERE line_uid=$1 FOR UPDATE`, [uid])).rows[0] || null;
    const phoneRows = (await client.query(
      `SELECT * FROM parents WHERE phone=$1 OR regexp_replace(COALESCE(phone,''),'\\D','','g')=$1 FOR UPDATE`,
      [phoneCanonical]
    )).rows;
    if (phoneRows.length > 1) throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', '手機命中多個 canonical parent');
    let parent = phoneRows[0] || byUid || null;
    if (byUid && parent && byUid.id !== parent.id) throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', 'LINE UID 與手機指向不同 parent');
    if (parent?.line_uid && parent.line_uid !== uid) throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', '手機已綁定另一個 LINE UID');
    let claimingPrebuilt = false;
    let claimStudents = cleanStudents;
    if (parent && !parent.line_uid) {
      claimingPrebuilt = true;
      if (cleanStudents.length > MAX_PREBUILT_CLAIM_STUDENTS) {
        throw new Z03ClaimError('CLAIM_TOO_MANY_STUDENTS', CLAIM_TOO_MANY_STUDENTS_MESSAGE, 400);
      }
      if (attempt.priorGuesses + cleanStudents.length > claimAttempts.FAILURE_LIMIT) {
        attemptResult = { outcome: 'COOLDOWN' };
        throw _cooldownError();
      }
      // 2026-10 舊家教移轉：櫃台預建檔的家長（本地有、還沒綁 LINE、Ragic 沒有）。
      // 原本這裡沿用 parent 卻不寫 line_uid → 家長下次用 LINE 登入找不到人，
      // CREATE_Z01_PARENT 也會因 LINE_UID_REQUIRED 卡在 outbox。
      // 綁定前核對（claimStudentMatcher）：電話＋任一位在學學員的身分證相同、姓名相同或只差一字才綁，
      // 只知道電話不能接走別人的課；任何一位送來的身分證和登記的不同就不綁。
      // 名下沒有學員的預建家長無從核對，一律轉櫃台，不靠電話單獨綁定。
      const onFile = (await client.query(
        `SELECT name, id_number FROM students WHERE parent_id=$1 AND is_active`, [parent.id]
      )).rows;
      // 這條路會新增學員，NEAR 分不出打錯字和只差一字的兄弟姊妹（Owner 2026-10-20：當成新的一位、標成「名字相近」）：
      // EXACT/ID 對上的沿用既有學員；其餘和「還沒被對上」的登記學員只差一字的，仍算核對過關的依據，
      // 但另建成新學員，嘗試紀錄記 NEW_SIMILAR 給櫃台反查（打錯字就由櫃台合併）。
      const strict = cleanStudents.map((s) => matchStudent(onFile, s, { allowNear: false }));
      const strictlyMatched = new Set(strict.filter((v) => v && !v.conflict).map((v) => v.name));
      const unmatchedOnFile = onFile.filter((row) => !strictlyMatched.has(normalizeStudentName(row.name)));
      const similar = strict.map((v, i) => (v ? null : _nearByName(unmatchedOnFile, cleanStudents[i].name)));
      const matchedNames = strict.filter((v) => v && !v.conflict).map((v) => v.name);
      const similarNames = similar.filter(Boolean).map((v) => v.candidates[0].name);
      // 只差一字只在只填一位時能當過關依據；填好幾個名字只靠其中一個差一字，等於一次猜好幾次。
      const nearProves = cleanStudents.length === 1 && similarNames.length === 1;
      if (strict.some((v) => v?.conflict) || (!matchedNames.length && !nearProves)
          || new Set(matchedNames).size !== matchedNames.length) {
        parentSync.auditClaim({ phone: phoneCanonical, lineUid: uid, result: 'failed', reason: 'prebuilt_parent_claim_mismatch' });
        failedPrebuiltClaim = { parentId: parent.id };
        throw new Z03ClaimError('CLAIM_VERIFICATION_FAILED', CLAIM_MISMATCH_MESSAGE, 409);
      }
      // 以登記的姓名為準：靠身分證對上的沿用既有學員，不另建一位。
      claimStudents = cleanStudents.map((s, i) => (strict[i] ? { ...s, name: strict[i].candidates[0].name } : s));
      const byId = strict.filter((v) => v?.method === 'ID').map((v) => v.candidates[0].name);
      attemptResult = similarNames.length
        ? { outcome: 'NEW_SIMILAR', path: 'PREBUILT', sourceRecordId: parent.id, matchedName: similarNames.join('、') }
        : { outcome: byId.length ? 'PASSED_ID' : 'PASSED_EXACT', path: 'PREBUILT', sourceRecordId: parent.id,
            matchedName: byId.join('、') || null };
      // 館別沿用預建時的，免得家長被移出原場館櫃台的範圍；其餘以家長本人填的為準。
      parent = (await client.query(
        `UPDATE parents
            SET line_uid=$2, is_active=TRUE,
                name=COALESCE(NULLIF($3,''),name), gender=COALESCE(NULLIF($4,''),gender),
                email=COALESCE(NULLIF($5,''),email), primary_venue_id=COALESCE(NULLIF(primary_venue_id,''),NULLIF($6,'')),
                identity=COALESCE(NULLIF($7,''),identity), updated_at=NOW()
          WHERE id=$1 AND (line_uid IS NULL OR line_uid='')
          RETURNING *`,
        [parent.id, uid, String(parentInput?.name || '').trim(), parentInput?.gender || '',
         parentInput?.email || '', parentInput?.primary_venue_id || '', parentInput?.identity || '']
      )).rows[0];
    }
    if (!parent) {
      parent = (await client.query(
        `INSERT INTO parents
           (phone,name,line_uid,primary_venue_id,gender,email,identity,home_phone,home_address,line_id,is_active)
         VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),TRUE)
         RETURNING *`,
        [phoneCanonical, String(parentInput.name || '').trim() || '未命名家長', uid,
         parentInput.primary_venue_id || null, parentInput.gender || '', parentInput.email || '',
         parentInput.identity || '', parentInput.home_phone || '', parentInput.home_address || '', parentInput.line_id || '']
      )).rows[0];
    }

    const localStudents = (await client.query(`SELECT * FROM students WHERE parent_id=$1 FOR UPDATE`, [parent.id])).rows;
    const linkedStudents = [];
    for (const sourceStudent of claimStudents) {
      const normalized = normalizeStudentName(sourceStudent.name);
      const matches = localStudents.filter((row) => normalizeStudentName(row.name) === normalized);
      if (matches.length > 1) throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', '同名學員命中多筆');
      let student = matches[0] || null;
      if (student && claimingPrebuilt) {
        student = await _fillBlankStudentFields(client, parent.id, student, sourceStudent, 'prebuilt-claim-fill');
      }
      if (!student) {
        student = (await client.query(
          `INSERT INTO students
             (parent_id,name,birth_date,gender,id_number,blood_type,student_code,is_active)
           VALUES ($1,$2,$3::date,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),TRUE)
           RETURNING *`,
          [parent.id, sourceStudent.name, _safeDate(sourceStudent.birth_date), sourceStudent.gender || '',
           sourceStudent.id_number || '', sourceStudent.blood_type || '', sourceStudent.student_code || '']
        )).rows[0];
        await writeStudentAudit(client, student.id, 'create', parentActor(parent.id, 'new-parent-registration'));
        localStudents.push(student);
      }
      linkedStudents.push(student);
    }

    let outboxPayload = payload;
    if (claimingPrebuilt) {
      // 預建學員以本地合併後的值送 Ragic：既有值不被家長送來的覆蓋、同家長重複的身分證不補，
      // outbox 照原始送出的值建 Ragic 的話，之後 Ragic→本地同步會反過來蓋掉本地。
      const merged = new Map((await client.query(
        `SELECT id, name, to_char(birth_date,'YYYY-MM-DD') AS birth_date, gender, id_number, blood_type
           FROM students WHERE id = ANY($1::uuid[])`, [linkedStudents.map((s) => s.id)]
      )).rows.map((row) => [row.id, row]));
      outboxPayload = {
        ...payload,
        students: claimStudents.map((s, i) => {
          const row = merged.get(linkedStudents[i].id);
          return { ...s, name: row.name, birth_date: row.birth_date || '', gender: row.gender || '',
            id_number: row.id_number || '', blood_type: row.blood_type || '' };
        }),
      };
    }

    const pendingSourceId = `PENDING:${requestKey}`;
    const claim = (await client.query(
      `INSERT INTO identity_claims
         (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,
          canonical_student_id,line_uid_hash,source_system,source_table,source_record_id,
          correlation_id,verified_at,linked_at)
       VALUES ('NEW_REGISTRATION','SYNC_PENDING',$1,$2,$3,$4,$5,'RAGIC','Z01',$6,$7,NOW(),NOW())
       RETURNING *`,
      [phoneCanonical, normalizeStudentName(claimStudents[0].name), parent.id, linkedStudents[0].id,
       lineUidHash, pendingSourceId, correlationId]
    )).rows[0];
    await client.query(
      `INSERT INTO ragic_sync_outbox
         (idempotency_key,claim_id,operation,source_system,source_table,source_record_id,
          payload_reference,state,correlation_id,field_id)
       VALUES ($1,$2,'CREATE_Z01_PARENT','RAGIC','Z01',$3,$4::jsonb,'pending',$5,'1006846')`,
      [`create-z01-parent:${requestKey}`, claim.id, pendingSourceId, JSON.stringify(outboxPayload), correlationId]
    );
    await client.query(
      `INSERT INTO parent_identity_requests
         (idempotency_key,line_uid_hash,operation,payload_hash,canonical_parent_id,
          canonical_student_id,claim_id,state,correlation_id)
       VALUES ($1,$2,'NEW_REGISTRATION',$3,$4,$5,$6,'SYNC_PENDING',$7)`,
      [requestKey, lineUidHash, payloadHash, parent.id, linkedStudents[0].id, claim.id, correlationId]
    );
    await client.query('COMMIT');
    return { parent, students: linkedStudents, replayed: false, sync_state: 'SYNC_PENDING', correlation_id: correlationId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (attemptResult.outcome !== 'COOLDOWN') {
      attemptResult = failedPrebuiltClaim
        ? { outcome: 'FAILED', path: 'PREBUILT', sourceRecordId: failedPrebuiltClaim.parentId }
        : { outcome: 'ERROR' };
    }
    if (err instanceof Z03ClaimError) throw err;
    // 這是新戶註冊唯一的寫入交易。原本直接把 err 換成 LOCAL_LINK_FAILED 丟出去，
    // 家長看到「註冊失敗」，而後台一行線索都沒有 —— 家長回報「填一填就跳掉」
    // 查了好幾週查不出來，正是因為原因在這裡被丟掉了。
    // 不記 err.detail：pg 會把欄位值放進去（電話、身分證），那是個資。
    console.error('[registerNewParentLocalFirst] 交易失敗（已回滾）：',
      'code=' + (err?.code || '-'),
      'constraint=' + (err?.constraint || '-'),
      'table=' + (err?.table || '-'),
      'column=' + (err?.column || '-'),
      '|', err?.message);
    throw new Z03ClaimError(_classifyConstraint(err), '本地新會員 transaction 失敗', 409, {
      constraint: err.constraint || null,
    });
  } finally {
    await _finishClaimAttempt(client, attempt, attemptResult);
    client.release();
  }
}

async function completeTrueUidRegistration({
  source,
  parentProfile = {},
  students = [],
  lineUid,
  ownershipVerified = false,
  actor = 'parent-register-line',
  correlationId = crypto.randomUUID(),
} = {}) {
  const uid = String(lineUid || '').trim();
  if (!source || getTrueRagicLineUid(source) !== uid) {
    throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', 'Ragic field 1006846 與目前 LINE UID 不一致', 409);
  }
  const mapped = ragic.mapZ01Parent(source);
  const sourceRecordId = String(mapped?.ragic_record_id || source?._ragicId || '').trim();
  const phoneCanonical = normalizePhone(mapped?.phone);
  if (!sourceRecordId || !isCanonicalMobilePhone(phoneCanonical)) {
    throw new Z03ClaimError('MANUAL_REVIEW_REQUIRED', 'Ragic source 缺少安全 canonical phone 或 record id', 409);
  }
  const submitted = (students || []).filter((row) => normalizeStudentName(row?.name));
  if (!submitted.length) throw new Z03ClaimError('STUDENT_NAME_REQUIRED', '學員姓名必填', 400);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`canonical-parent:${phoneCanonical}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`line-uid:${_lineUidHash(uid)}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ragic-z01:${sourceRecordId}`]);

    let parent = await parentSync.upsertLocalParent(client, { ...mapped, phone: phoneCanonical }, uid, {
      reactivate: true,
      overwriteLineUid: false,
      preservePending: true,
    });
    await parentSync.upsertLocalStudents(client, parent.id, ragic.parseZ01Students(source), {
      authoritative: false,
      preservePending: true,
    });
    parent = await _applyAllowlistedLocalProfile(client, parent,
      { ...parentProfile, phone: phoneCanonical }, ownershipVerified);

    // Z01 子表已有這位孩子才不送：同名但身分證不同是另一個孩子（身分證為主，Owner 2026-10-20）。
    const sourceStudents = ragic.parseZ01Students(source);
    const inSource = (input) => {
      const id = String(input.id_number || '').trim().toUpperCase();
      return sourceStudents.some((row) => normalizeStudentName(row.name) === normalizeStudentName(input.name)
        && !(id && row.id_number && row.id_number !== id));
    };
    const localStudents = [];
    const studentsToAppend = [];
    for (const studentInput of submitted) {
      const local = await _insertOrReuseStudent(client, parent.id, studentInput);
      localStudents.push(local.student);
      if (!inSource(studentInput)) studentsToAppend.push(studentInput);
    }
    await client.query(
      `INSERT INTO source_record_links
         (source_system,source_table,source_record_id,canonical_parent_id,canonical_student_id,link_method)
       VALUES ('RAGIC','Z01',$1,$2,$3,'TRUE_LINE_UID_EXACT')
       ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
         canonical_parent_id=EXCLUDED.canonical_parent_id,
         canonical_student_id=COALESCE(source_record_links.canonical_student_id,EXCLUDED.canonical_student_id),
         link_method=EXCLUDED.link_method,updated_at=NOW()`,
      [sourceRecordId, parent.id, localStudents[0]?.id || null]
    );

    const profile = buildParentProfilePatch({
      sourceProfile: { ...mapped, line_uid: getTrueRagicLineUid(source) },
      parentInput: { ...parentProfile, phone: phoneCanonical },
      lineUid: uid,
      ownershipVerified,
      includeUid: false,
    });
    const needsSync = Object.keys(profile.patch).length > 0 || studentsToAppend.length > 0;
    if (needsSync) {
      const primaryStudent = localStudents[0];
      const claim = (await client.query(
        `INSERT INTO identity_claims
           (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,
            canonical_student_id,line_uid_hash,source_system,source_table,source_record_id,
            correlation_id,verified_at,linked_at)
         VALUES ('UID_REGISTRATION','SYNC_PENDING',$1,$2,$3,$4,$5,'RAGIC','Z01',$6,$7,NOW(),NOW())
         ON CONFLICT (purpose,source_system,source_table,source_record_id,student_name_normalized)
         DO UPDATE SET state='SYNC_PENDING',canonical_parent_id=EXCLUDED.canonical_parent_id,
           canonical_student_id=EXCLUDED.canonical_student_id,last_error_code=NULL,
           version=identity_claims.version+1,updated_at=NOW()
         RETURNING *`,
        [phoneCanonical, normalizeStudentName(primaryStudent?.name), parent.id, primaryStudent?.id || null,
         _lineUidHash(uid), sourceRecordId, correlationId]
      )).rows[0];
      await insertProfilePatchAudit(client, {
        parentId: parent.id,
        sourceRecordId,
        changes: profile.changes,
        correlationId: claim.correlation_id,
        actor,
      });
      await client.query(
        `INSERT INTO ragic_sync_outbox
           (idempotency_key,claim_id,operation,source_system,source_table,source_record_id,
            payload_reference,state,correlation_id,target_record_id,field_id)
         VALUES ($1,$2,'BIND_Z01_LINE_UID','RAGIC','Z01',$3,$4::jsonb,'pending',$5,$3,'1006846')
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [`complete-z01-registration:${sourceRecordId}:${_lineUidHash(uid).slice(0,16)}`, claim.id,
         sourceRecordId, JSON.stringify({ canonical_parent_id: parent.id, profile_patch: profile.patch,
           students_to_append: studentsToAppend, verify_readback: true, skip_uid_write: true }),
         claim.correlation_id]
      );
    }
    await client.query('COMMIT');
    return { parent, students: localStudents, replayed: false,
      sync_state: needsSync ? 'SYNC_PENDING' : 'SYNCED', correlation_id: correlationId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof Z03ClaimError) throw err;
    if (err instanceof BindConflictError && err.code === 'PHONE_AMBIGUOUS') {
      throw new Z03ClaimError('PHONE_AMBIGUOUS', err.message, 409);
    }
    if (err.code === 'ACCOUNT_RECOVERY_REQUIRED') {
      throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', err.message, 409);
    }
    throw new Z03ClaimError(_classifyConstraint(err), '本地 UID source transaction 失敗', 409, {
      constraint: err.constraint || null,
    });
  } finally {
    client.release();
  }
}

async function _persistManualReview({ z03Ids = [], sourceRecordId = null, phoneCanonical, studentNameNormalized, lineUid, code, correlationId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (z03Ids.length) {
      await client.query(
        `UPDATE ragic_z03_records
            SET status = 'manual_review', classification = 'MANUAL_REVIEW',
                claim_state = 'MANUAL_REVIEW', reason_code = $2,
                last_error_code = $2, last_processed_at = NOW(),
                correlation_id = COALESCE(correlation_id, $3::uuid)
          WHERE id = ANY($1::bigint[])`,
        [z03Ids, code, correlationId]
      );
    }
    if (sourceRecordId) {
      const claim = (await client.query(
        `INSERT INTO identity_claims
           (purpose, state, phone_canonical, student_name_normalized, line_uid_hash,
            source_system, source_table, source_record_id, last_error_code, correlation_id)
         VALUES ('CLAIM_LEGACY','MANUAL_REVIEW',$1,$2,$3,'RAGIC','Z01',$4,$5,$6)
         ON CONFLICT (purpose, source_system, source_table, source_record_id, student_name_normalized)
         DO UPDATE SET state='MANUAL_REVIEW', last_error_code=EXCLUDED.last_error_code,
                       retry_count=identity_claims.retry_count+1,
                       version=identity_claims.version+1, updated_at=NOW()
         RETURNING id, correlation_id`,
        [phoneCanonical, studentNameNormalized, _lineUidHash(lineUid), sourceRecordId, code, correlationId]
      )).rows[0];
      await client.query(
        `INSERT INTO identity_claim_events
           (claim_id, from_state, to_state, reason_code, actor_type, correlation_id)
         VALUES ($1,NULL,'MANUAL_REVIEW',$2,'parent',$3)`,
        [claim.id, code, claim.correlation_id]
      );
    }
    await createParentIdentityBackofficeTask({
      client,
      phone: phoneCanonical,
      sourceRecordIds: sourceRecordId ? [sourceRecordId] : [],
      reasonCode: code || 'PARENT_IDENTITY_MANUAL_REVIEW',
      suggestedAction: 'Review canonical phone and source evidence; preserve all existing rights and do not create a duplicate parent.',
      correlationId,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function claimZ03Identity({
  phone,
  studentName,
  studentInput = null,
  lineUid,
  parentName = '',
  parentProfile = null,
  allowStudentAppend = false,
  ownershipVerified = false,
  z03Id = null,
  sourceRecordId = null,
  claimIdNumber = '',
  claimGuesses = 1,
  extraStudents = [],
  actor = 'parent-auth',
  correlationId = crypto.randomUUID(),
} = {}) {
  const phoneCanonical = normalizePhone(phone);
  let studentNameNormalized = normalizeStudentName(studentName);
  let claimStudentName = String(studentName || '').trim();
  if (!isCanonicalMobilePhone(phoneCanonical)) throw new Z03ClaimError('INVALID_PHONE', '手機無法安全正規化', 400);
  if (!studentNameNormalized) throw new Z03ClaimError('STUDENT_NAME_REQUIRED', '學員姓名必填', 400);
  if (!String(lineUid || '').trim()) throw new Z03ClaimError('LINE_UID_REQUIRED', 'LINE UID 必填', 400);
  const submittedStudent = { ...(studentInput || {}), name: String(studentInput?.name || studentName || '').trim() };
  const submittedProfile = { ...(parentProfile || {}), name: String(parentProfile?.name || parentName || '').trim(), phone: phoneCanonical };
  const registrationCompletion = Boolean(parentProfile || studentInput || allowStudentAppend);
  const submittedIdNumber = String(claimIdNumber || studentInput?.id_number || '').trim();

  const client = await pool.connect();
  let attempt = null;
  let attemptResult = { outcome: 'PASSED_EXACT' };
  let similarOnFile = null;
  let reviewContext = null;
  let failedAttempt = null;
  try {
    attempt = await claimAttempts.reserveClaimAttempt({
      lineUid, phone: phoneCanonical, path: 'Z03', guesses: claimGuesses,
      submittedName: [studentName, ...extraStudents.map((s) => s.name)].join('、'),
      submittedIdNumber: [submittedIdNumber, ...extraStudents.map((s) => s.id_number || '')].join(''),
    }, client);
    if (attempt.priorGuesses + claimGuesses > claimAttempts.FAILURE_LIMIT) {
      attemptResult = { outcome: 'COOLDOWN' };
      throw _cooldownError();
    }
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`canonical-parent:${phoneCanonical}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`line-uid:${_lineUidHash(lineUid)}`]);

    const params = [];
    const where = [];
    if (z03Id) {
      params.push(z03Id);
      where.push(`id = $${params.length}`);
    } else if (sourceRecordId) {
      params.push(String(sourceRecordId));
      where.push(`z01_ragic_record_id = $${params.length}`);
    } else {
      params.push(phoneCanonical);
      where.push(`(phone_canonical = $${params.length}
        OR regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $${params.length})`);
    }
    const families = (await client.query(
      `SELECT * FROM ragic_z03_records
        WHERE ${where.join(' AND ')}
          AND status IN ('pending','resolved','manual_review')
        ORDER BY fetched_at DESC, id
        FOR UPDATE`,
      params
    )).rows;
    if (!families.length) {
      throw new Z03ClaimError('IDENTITY_NOT_FOUND', '找不到同一家庭的 Z03 source record', 404);
    }

    const familyIds = families.map((row) => row.id);
    const childRows = (await client.query(
      `SELECT * FROM ragic_z03_students
        WHERE z03_record_id = ANY($1::bigint[])
        ORDER BY z03_record_id, seq_raw, id
        FOR UPDATE`,
      [familyIds]
    )).rows;
    let exactMatches = childRows.filter((row) => normalizeStudentName(row.name_raw) === studentNameNormalized);
    // 身分證為主（Owner 2026-10-20）：註冊時同名但身分證和登記的不同，是這一戶的另一個孩子。
    // 同名仍證明是這一戶，但不連到登記的那位：另建、記 NEW_SIMILAR 給櫃台反查。
    let sameNameNewChild = false;
    if (allowStudentAppend && _sameNameIdConflict(
      exactMatches.map((row) => ({ id_number: row.id_number_raw, row })), submittedIdNumber)) {
      similarOnFile = String(exactMatches[0].name_raw || '').trim();
      sameNameNewChild = true;
      exactMatches = [];
    }
    if (exactMatches.length === 0) {
      // 姓名沒有完全相同：身分證相同或姓名只差一字也算對上（claimStudentMatcher），之後以登記的姓名為準。
      // 註冊新增學員（allowStudentAppend）時不認 NEAR：只差一字的可能是還沒登記的兄弟姊妹，
      // 照樣另建，但記 NEW_SIMILAR 給櫃台反查（Owner 2026-10-20）。
      const candidates = childRows
        .filter(_fuzzyEligible)
        .map((row) => ({ name: row.name_raw, id_number: row.id_number_raw, row }));
      const submitted = { name: studentName, id_number: submittedIdNumber };
      const verdict = matchStudent(candidates, submitted, { allowNear: !allowStudentAppend });
      if (!verdict && allowStudentAppend) {
        const near = _nearByName(candidates, studentName);
        if (near) similarOnFile = String(near.candidates[0].row.name_raw || '').trim();
      }
      if (verdict && !verdict.conflict) {
        exactMatches = verdict.candidates.map((candidate) => candidate.row);
        studentNameNormalized = verdict.name;
        claimStudentName = String(exactMatches[0].name_raw || '').trim();
        submittedStudent.name = claimStudentName;
        attemptResult = {
          outcome: `PASSED_${verdict.method}`, sourceRecordId: exactMatches[0].z03_record_id, matchedName: claimStudentName,
        };
      }
    }
    // 註冊頁其餘填寫的學員：核對對象要先證明是這一戶（同名或身分證對上）才處理其餘的（Owner 2026-10-20）。
    const extras = _classifyExtraStudents(childRows, exactMatches, extraStudents, claimStudentName);
    if (extraStudents.length && (extras.invalid || !(exactMatches.length || sameNameNewChild))) {
      failedAttempt = { sourceRecordId: families.length === 1 ? families[0].id : null };
      throw new Z03ClaimError('CLAIM_VERIFICATION_FAILED', CLAIM_MISMATCH_MESSAGE, 409, { reason: 'IDENTITY_NOT_FOUND' });
    }
    const similarNames = [...new Set([similarOnFile, ...extras.similarNames].filter(Boolean))];
    if (exactMatches.length && extras.similarNames.length) {
      attemptResult = { outcome: 'NEW_SIMILAR', sourceRecordId: exactMatches[0].z03_record_id, matchedName: similarNames.join('、') };
    }
    if (exactMatches.length === 0) {
      // 註冊新增學員也要先證明是這一戶：名字和登記的孩子只差一字才另建（標 NEW_SIMILAR），
      // 完全對不上就當核對失敗，不再只憑電話把 LINE 綁進這一戶（Owner 2026-10-20）。
      if (allowStudentAppend && similarOnFile) {
        attemptResult = { outcome: 'NEW_SIMILAR', matchedName: similarNames.join('、') };
        const localCandidates = (await client.query(
          `SELECT * FROM parents
            WHERE line_uid=$1 OR phone=$2 OR regexp_replace(COALESCE(phone,''),'\\D','','g')=$2
            ORDER BY created_at,id FOR UPDATE`, [lineUid, phoneCanonical]
        )).rows;
        const canonicalIds = [...new Set(localCandidates.map((row) => String(row.id)))];
        if (canonicalIds.length > 1) {
          reviewContext = { z03Ids: familyIds, sourceRecordId: null, code: 'DUPLICATE_PARENT_IDENTITY' };
          throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', '本地 canonical parent 證據互相衝突', 409);
        }
        let parent = localCandidates[0] || null;
        if (parent?.line_uid && parent.line_uid !== lineUid) {
          throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', '手機已綁定另一個 LINE UID', 409);
        }

        let family = families.length === 1 ? families[0] : null;
        let aliasFamilies = [];
        let resolutionMethod = 'PHONE_MATCH_STUDENT_APPEND';
        if (!family) {
          const canary = evaluateParentIdentityCanary({
            lineUid,
            phone: phoneCanonical,
            sourceRecordIds: families.map((row) => row.z01_ragic_record_id),
            existingLocalLineUidFound: false,
          });
          const resolution = await resolveMultipleSourceCandidate(client, {
            matchedFamilies: families,
            exactMatches: [],
            canonicalParent: parent,
            currentLineUid: lineUid,
            maxPriority: canary.allowed ? 6 : 3,
          });
          family = resolution.winnerSourceId
            ? families.find((row) => String(row.z01_ragic_record_id) === String(resolution.winnerSourceId))
            : null;
          if (family) {
            aliasFamilies = families.filter((row) => row.id !== family.id);
            resolutionMethod = `PHONE_MATCH_STUDENT_APPEND_PRIORITY_${resolution.priority}`;
          }
        }

        if (!family) {
          if (!parent) {
            parent = (await client.query(
              `INSERT INTO parents (phone,name,line_uid,is_active)
               VALUES ($1,$2,$3,TRUE) RETURNING *`,
              [phoneCanonical, submittedProfile.name || '未命名家長', lineUid]
            )).rows[0];
          } else if (!parent.line_uid) {
            parent = (await client.query(
              `UPDATE parents SET line_uid=$2,is_active=TRUE,updated_at=NOW() WHERE id=$1 RETURNING *`,
              [parent.id, lineUid]
            )).rows[0];
          }
          parent = await _applyAllowlistedLocalProfile(client, parent, submittedProfile, ownershipVerified);
          const { student } = await _insertOrReuseStudent(client, parent.id, submittedStudent);
          const extra = await _attachExtraStudents(client, parent.id, extras, { canAppend: false });
          for (const source of families) {
            const claim = (await client.query(
              `INSERT INTO identity_claims
                 (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,
                  canonical_student_id,line_uid_hash,source_system,source_table,source_record_id,
                  last_error_code,correlation_id,verified_at,linked_at)
               VALUES ('CLAIM_LEGACY','DATA_RECONCILIATION_PENDING',$1,$2,$3,$4,$5,
                       'RAGIC','Z01',$6,'MULTIPLE_SOURCE_NO_UNIQUE_WINNER',$7,NOW(),NOW())
               ON CONFLICT (purpose,source_system,source_table,source_record_id,student_name_normalized)
               DO UPDATE SET state='DATA_RECONCILIATION_PENDING',canonical_parent_id=EXCLUDED.canonical_parent_id,
                 canonical_student_id=EXCLUDED.canonical_student_id,last_error_code=EXCLUDED.last_error_code,
                 version=identity_claims.version+1,updated_at=NOW()
               RETURNING *`,
              [phoneCanonical, studentNameNormalized, parent.id, student.id, _lineUidHash(lineUid),
               source.z01_ragic_record_id, correlationId]
            )).rows[0];
            await client.query(
              `INSERT INTO source_record_links
                 (source_system,source_table,source_record_id,canonical_parent_id,
                  canonical_student_id,claim_id,link_method)
               VALUES ('RAGIC','Z01',$1,$2,$3,$4,'MULTIPLE_SOURCE_ALIAS')
               ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
                 canonical_parent_id=EXCLUDED.canonical_parent_id,
                 canonical_student_id=COALESCE(source_record_links.canonical_student_id,EXCLUDED.canonical_student_id),
                 claim_id=EXCLUDED.claim_id,link_method=EXCLUDED.link_method,updated_at=NOW()`,
              [source.z01_ragic_record_id, parent.id, student.id, claim.id]
            );
          }
          await client.query(
            `UPDATE ragic_z03_records SET status='resolved',classification='DATA_RECONCILIATION_PENDING',
               reason_code='MULTIPLE_SOURCE_NO_UNIQUE_WINNER',claim_state='DATA_RECONCILIATION_PENDING',
               canonical_parent_id=$2,canonical_student_id=$3,last_processed_at=NOW(),correlation_id=$4
             WHERE id=ANY($1::bigint[])`,
            [familyIds, parent.id, student.id, correlationId]
          );
          await createParentIdentityBackofficeTask({
            client,
            parent,
            sourceRecordIds: families.map((row) => row.z01_ragic_record_id),
            reasonCode: 'MULTIPLE_SOURCE_NO_UNIQUE_WINNER',
            suggestedAction: 'Review source evidence and select the primary Z01; do not create another parent.',
            correlationId,
          });
          await client.query('COMMIT');
          return { parent, student, replayed: false, student_appended: true,
            sync_state: 'DATA_RECONCILIATION_PENDING', correlation_id: correlationId, ignored_students: extra.ignored };
        }

        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `ragic-z01:${family.z01_ragic_record_id}`,
        ]);
        const shadow = (await client.query(
          `SELECT raw_data FROM ragic_z01_shadow WHERE ragic_record_id=$1 FOR UPDATE`,
          [family.z01_ragic_record_id]
        )).rows[0]?.raw_data || {};
        const remoteUid = String(shadow['1006846'] || '').trim();
        if (remoteUid && remoteUid !== lineUid) {
          throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', 'Ragic source 已綁定另一個 LINE UID', 409);
        }
        const existingLink = (await client.query(
          `SELECT * FROM source_record_links
            WHERE source_system='RAGIC' AND source_table='Z01' AND source_record_id=$1 FOR UPDATE`,
          [family.z01_ragic_record_id]
        )).rows[0] || null;
        if (existingLink) {
          const linkedParent = (await client.query(
            `SELECT * FROM parents WHERE id=$1 FOR UPDATE`, [existingLink.canonical_parent_id]
          )).rows[0];
          if (!linkedParent || normalizePhone(linkedParent.phone) !== phoneCanonical) {
            throw new Z03ClaimError('SOURCE_RECORD_ALREADY_LINKED', 'source record 已連結另一個家庭', 409);
          }
          if (parent && String(parent.id) !== String(linkedParent.id)) {
            throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', 'source link 與 canonical phone 指向不同 parent', 409);
          }
          parent = linkedParent;
        }
        if (!parent) {
          parent = (await client.query(
            `INSERT INTO parents
               (phone,name,line_uid,email,home_phone,home_address,line_id,ragic_record_id,is_active,last_synced_at)
             VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),$8,TRUE,NOW())
             RETURNING *`,
            [phoneCanonical, submittedProfile.name || family.raw_name || '未命名家長', lineUid,
             family.email_raw || '', family.home_phone_raw || '', family.home_address_raw || '',
             family.line_id_raw || '', family.z01_ragic_record_id]
          )).rows[0];
        } else {
          parent = (await client.query(
            `UPDATE parents SET line_uid=COALESCE(line_uid,$2),ragic_record_id=COALESCE(ragic_record_id,$3),
               is_active=TRUE,updated_at=NOW() WHERE id=$1 RETURNING *`,
            [parent.id, lineUid, family.z01_ragic_record_id]
          )).rows[0];
        }
        parent = await _applyAllowlistedLocalProfile(client, parent, submittedProfile, ownershipVerified);
        const { student } = await _insertOrReuseStudent(client, parent.id, submittedStudent);
        const appendKey = `bind-z01-line-uid:${family.z01_ragic_record_id}`;
        const appendQueued = (await client.query(`SELECT 1 FROM ragic_sync_outbox WHERE idempotency_key=$1`, [appendKey])).rowCount > 0;
        const extra = await _attachExtraStudents(client, parent.id, extras, { canAppend: !appendQueued });
        const claim = (await client.query(
          `INSERT INTO identity_claims
             (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,
              canonical_student_id,line_uid_hash,source_system,source_table,source_record_id,
              correlation_id,verified_at,linked_at)
           VALUES ('CLAIM_LEGACY','SYNC_PENDING',$1,$2,$3,$4,$5,'RAGIC','Z01',$6,$7,NOW(),NOW())
           ON CONFLICT (purpose,source_system,source_table,source_record_id,student_name_normalized)
           DO UPDATE SET state='SYNC_PENDING',canonical_parent_id=EXCLUDED.canonical_parent_id,
             canonical_student_id=EXCLUDED.canonical_student_id,line_uid_hash=EXCLUDED.line_uid_hash,
             last_error_code=NULL,version=identity_claims.version+1,updated_at=NOW()
           RETURNING *`,
          [phoneCanonical, studentNameNormalized, parent.id, student.id, _lineUidHash(lineUid),
           family.z01_ragic_record_id, correlationId]
        )).rows[0];
        await client.query(
          `INSERT INTO source_record_links
             (source_system,source_table,source_record_id,canonical_parent_id,
              canonical_student_id,claim_id,link_method)
           VALUES ('RAGIC','Z01',$1,$2,$3,$4,$5)
           ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
             canonical_parent_id=EXCLUDED.canonical_parent_id,
             canonical_student_id=COALESCE(source_record_links.canonical_student_id,EXCLUDED.canonical_student_id),
             claim_id=EXCLUDED.claim_id,link_method=EXCLUDED.link_method,updated_at=NOW()`,
          [family.z01_ragic_record_id, parent.id, student.id, claim.id, resolutionMethod]
        );
        for (const alias of aliasFamilies) {
          await client.query(
            `INSERT INTO source_record_links
               (source_system,source_table,source_record_id,canonical_parent_id,canonical_student_id,claim_id,link_method)
             VALUES ('RAGIC','Z01',$1,$2,$3,$4,'MULTIPLE_SOURCE_ALIAS')
             ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
               canonical_parent_id=EXCLUDED.canonical_parent_id,
               canonical_student_id=COALESCE(source_record_links.canonical_student_id,EXCLUDED.canonical_student_id),
               claim_id=EXCLUDED.claim_id,link_method=EXCLUDED.link_method,updated_at=NOW()`,
            [alias.z01_ragic_record_id, parent.id, student.id, claim.id]
          );
        }
        const profile = buildParentProfilePatch({
          sourceProfile: _sourceProfileFromFamily(family, remoteUid),
          parentInput: submittedProfile,
          lineUid,
          ownershipVerified,
          includeUid: remoteUid !== lineUid,
        });
        await insertProfilePatchAudit(client, {
          parentId: parent.id,
          sourceRecordId: family.z01_ragic_record_id,
          changes: profile.changes,
          correlationId: claim.correlation_id,
          actor,
        });
        await client.query(
          `INSERT INTO ragic_sync_outbox
             (idempotency_key,claim_id,operation,source_system,source_table,source_record_id,
              payload_reference,state,correlation_id,target_record_id,field_id)
           VALUES ($1,$2,'BIND_Z01_LINE_UID','RAGIC','Z01',$3,$4::jsonb,'pending',$5,$3,'1006846')
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [appendKey, claim.id, family.z01_ragic_record_id,
           JSON.stringify({ canonical_parent_id: parent.id, profile_patch: profile.patch,
             students_to_append: [submittedStudent, ...extra.toRagic], verify_readback: true,
             skip_uid_write: remoteUid === lineUid }), claim.correlation_id]
        );
        await client.query(
          `UPDATE ragic_z03_records SET status='resolved',classification='RESOLVED',
             reason_code='STUDENT_APPENDED_LOCAL',claim_state='SYNC_PENDING',canonical_parent_id=$2,
             canonical_student_id=$3,resolved_at=NOW(),resolved_by=$4,last_error_code=NULL,
             last_processed_at=NOW(),correlation_id=$5 WHERE id=$1`,
          [family.id, parent.id, student.id, actor, claim.correlation_id]
        );
        await client.query('COMMIT');
        return { parent, student, replayed: false, student_appended: true,
          sync_state: 'SYNC_PENDING', correlation_id: claim.correlation_id, ignored_students: extra.ignored };
      }
      // 核對失敗只記這一次（同一個 LINE 帳號錯 5 次才冷靜），不再把整個家庭鎖成人工審核
      // （Owner 2026-10-20：一次打錯字就整戶鎖死，家長之後填對也進不來）。
      failedAttempt = { sourceRecordId: families.length === 1 ? families[0].id : null };
      throw new Z03ClaimError('CLAIM_VERIFICATION_FAILED', CLAIM_MISMATCH_MESSAGE, 409, {
        reason: 'IDENTITY_NOT_FOUND',
      });
    }
    const matchedFamilyIds = [...new Set(exactMatches.map((row) => row.z03_record_id))];
    const allExactMatchIds = exactMatches.map((row) => row.id);
    const matchedFamilies = families.filter((row) => matchedFamilyIds.includes(row.id));
    let aliasFamilies = [];
    let resolutionMethod = 'PHONE_AND_EXACT_STUDENT_NAME';
    if (matchedFamilyIds.length > 1) {
      // Evidence-only winner order. No ID ordering, timestamps or first-row
      // fallback may choose the primary source.
      const localCandidates = (await client.query(
        `SELECT * FROM parents
          WHERE line_uid=$1 OR phone=$2 OR regexp_replace(COALESCE(phone,''),'\\D','','g')=$2
          ORDER BY id FOR UPDATE`, [lineUid, phoneCanonical]
      )).rows;
      const canonicalIds = [...new Set(localCandidates.map((row) => String(row.id)))];
      if (canonicalIds.length > 1) {
        throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', '本地 canonical parent 證據互相衝突', 409);
      }
      const canonicalParent = localCandidates[0] || null;
      const canary = evaluateParentIdentityCanary({
        lineUid,
        phone: phoneCanonical,
        sourceRecordIds: matchedFamilies.map((row) => row.z01_ragic_record_id),
        existingLocalLineUidFound: false,
      });
      const resolution = await resolveMultipleSourceCandidate(client, {
        matchedFamilies,
        exactMatches,
        canonicalParent,
        currentLineUid: lineUid,
        maxPriority: canary.allowed ? 6 : 3,
      });
      const winnerSet = resolution.winnerSourceId ? [resolution.winnerSourceId] : [];

      if (winnerSet.length === 1) {
        const winnerFamily = matchedFamilies.find((row) => String(row.z01_ragic_record_id) === String(winnerSet[0]));
        exactMatches = exactMatches.filter((row) => row.z03_record_id === winnerFamily.id);
        if (exactMatches.length !== 1) {
          throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', 'winner source 內仍有重複同名學員', 409);
        }
        aliasFamilies = matchedFamilies.filter((row) => row.id !== winnerFamily.id);
        resolutionMethod = `MULTIPLE_SOURCE_PRIORITY_${resolution.priority}`;
      } else {
        // Phone ownership + exact student name has been verified, but no source
        // is safe to make primary. Create/use one local identity, preserve every
        // source as an alias, enqueue no Ragic write, and allow login.
        if (canonicalParent?.line_uid && canonicalParent.line_uid !== lineUid) {
          throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', '手機已綁另一個 LINE UID', 409);
        }
        let parent = canonicalParent;
        if (!parent) {
          parent = (await client.query(
            `INSERT INTO parents (phone,name,line_uid,is_active)
             VALUES ($1,$2,$3,TRUE) RETURNING *`,
            [phoneCanonical, String(parentName || '').trim() || '未命名家長', lineUid]
          )).rows[0];
        } else if (!parent.line_uid) {
          parent = (await client.query(
            `UPDATE parents SET line_uid=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,
            [parent.id, lineUid]
          )).rows[0];
        }
        const studentRows = (await client.query(`SELECT * FROM students WHERE parent_id=$1 FOR UPDATE`, [parent.id])).rows
          .filter((row) => normalizeStudentName(row.name) === studentNameNormalized);
        if (studentRows.length > 1) throw new Z03ClaimError('DATA_RECONCILIATION_PENDING', 'canonical student 命中多筆', 409);
        const student = studentRows[0] || (await client.query(
          `INSERT INTO students (parent_id,name,is_active) VALUES ($1,$2,TRUE) RETURNING *`,
          [parent.id, claimStudentName]
        )).rows[0];
        if (!studentRows[0]) await writeStudentAudit(client, student.id, 'create', parentActor(parent.id, 'legacy-claim-local-identity'));
        await client.query(
          `UPDATE ragic_z03_students SET canonical_student_id=$2
            WHERE id=ANY($1::bigint[])`,
          [allExactMatchIds, student.id]
        );
        const extra = await _attachExtraStudents(client, parent.id, extras, { canAppend: false });
        for (const source of matchedFamilies) {
          const claim = (await client.query(
            `INSERT INTO identity_claims
               (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,
                canonical_student_id,line_uid_hash,source_system,source_table,source_record_id,
                last_error_code,correlation_id,verified_at,linked_at)
             VALUES ('CLAIM_LEGACY','DATA_RECONCILIATION_PENDING',$1,$2,$3,$4,$5,
                     'RAGIC','Z01',$6,'MULTIPLE_SOURCE_NO_UNIQUE_WINNER',$7,NOW(),NOW())
             ON CONFLICT (purpose,source_system,source_table,source_record_id,student_name_normalized)
             DO UPDATE SET state='DATA_RECONCILIATION_PENDING',canonical_parent_id=EXCLUDED.canonical_parent_id,
               canonical_student_id=EXCLUDED.canonical_student_id,last_error_code=EXCLUDED.last_error_code,
               version=identity_claims.version+1,updated_at=NOW()
             RETURNING *`,
            [phoneCanonical, studentNameNormalized, parent.id, student.id, _lineUidHash(lineUid),
             source.z01_ragic_record_id, correlationId]
          )).rows[0];
          await client.query(
            `INSERT INTO source_record_links
               (source_system,source_table,source_record_id,canonical_parent_id,
                canonical_student_id,claim_id,link_method)
             VALUES ('RAGIC','Z01',$1,$2,$3,$4,'MULTIPLE_SOURCE_ALIAS')
             ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
               canonical_parent_id=EXCLUDED.canonical_parent_id,
               canonical_student_id=EXCLUDED.canonical_student_id,claim_id=EXCLUDED.claim_id,
               link_method=EXCLUDED.link_method,updated_at=NOW()`,
            [source.z01_ragic_record_id, parent.id, student.id, claim.id]
          );
        }
        await client.query(
          `UPDATE ragic_z03_records SET status='resolved',classification='DATA_RECONCILIATION_PENDING',
             reason_code='MULTIPLE_SOURCE_NO_UNIQUE_WINNER',claim_state='DATA_RECONCILIATION_PENDING',
             canonical_parent_id=$2,canonical_student_id=$3,last_processed_at=NOW(),correlation_id=$4
           WHERE id=ANY($1::bigint[])`,
          [matchedFamilyIds, parent.id, student.id, correlationId]
        );
        await client.query('COMMIT');
        return { parent, student, replayed: false, sync_state: 'DATA_RECONCILIATION_PENDING',
          correlation_id: correlationId, ambiguous_source_resolved: false, ignored_students: extra.ignored };
      }
    }

    const matchedChild = exactMatches[0];
    const family = families.find((row) => row.id === matchedChild.z03_record_id);
    if (!family) throw new Z03ClaimError('LOCAL_TRANSACTION_FAILED', 'Z03 family/child 關係不一致', 500);
    const recoverableSameSourceDuplicate = family.status === 'manual_review'
      && family.reason_code === 'AMBIGUOUS_STUDENT_MATCH'
      && matchedFamilyIds.length === 1
      && exactMatches.length > 1;
    // 以前打錯字留下的 IDENTITY_NOT_FOUND 不算人工鎖：這次核對已通過就放行。櫃台手動轉人工的照樣擋。
    if (family.status === 'manual_review' && !recoverableSameSourceDuplicate && family.reason_code !== 'IDENTITY_NOT_FOUND') {
      throw new Z03ClaimError('MANUAL_REVIEW_REQUIRED', '這個家庭的資料正在由櫃台確認中，請洽櫃台協助完成綁定。', 409, {
        reason: family.reason_code || 'MANUAL_REVIEW',
      });
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `ragic-z01:${family.z01_ragic_record_id}`,
    ]);
    const shadow = (await client.query(
      `SELECT raw_data FROM ragic_z01_shadow WHERE ragic_record_id=$1 FOR UPDATE`,
      [family.z01_ragic_record_id]
    )).rows[0]?.raw_data || {};
    const remoteUid = String(shadow['1006846'] || '').trim();
    if (remoteUid && remoteUid !== lineUid) {
      throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', 'Ragic source 已綁定另一個 LINE UID', 409);
    }

    const existingLink = (await client.query(
      `SELECT * FROM source_record_links
        WHERE source_system='RAGIC' AND source_table='Z01' AND source_record_id=$1
        FOR UPDATE`,
      [family.z01_ragic_record_id]
    )).rows[0] || null;
    if (existingLink) {
      const linkedParent = (await client.query(
        `SELECT * FROM parents WHERE id=$1 FOR UPDATE`, [existingLink.canonical_parent_id]
      )).rows[0];
      const linkedStudent = existingLink.canonical_student_id
        ? (await client.query(`SELECT * FROM students WHERE id=$1 FOR UPDATE`, [existingLink.canonical_student_id])).rows[0]
        : null;
      if (!linkedParent) throw new Z03ClaimError('ORPHAN_CLAIM_CONFLICT', 'source link parent 不存在', 409);
      if (normalizePhone(linkedParent.phone) !== phoneCanonical) {
        throw new Z03ClaimError('SOURCE_RECORD_ALREADY_LINKED', 'source record 已連結另一個 phone', 409);
      }
      if (linkedParent.line_uid && linkedParent.line_uid !== lineUid) {
        throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', '手機已綁定另一個 LINE UID', 409);
      }
      if (linkedStudent && normalizeStudentName(linkedStudent.name) !== studentNameNormalized) {
        throw new Z03ClaimError('SOURCE_RECORD_ALREADY_LINKED', 'source record 已連結另一位 student', 409);
      }
      if (linkedParent.line_uid !== lineUid) {
        await client.query(`UPDATE parents SET line_uid=$2, updated_at=NOW() WHERE id=$1`, [linkedParent.id, lineUid]);
        linkedParent.line_uid = lineUid;
      }
      if (linkedStudent) {
        await client.query(
          `UPDATE ragic_z03_records SET
             status='resolved', classification='RESOLVED', claim_state='SYNC_PENDING',
             canonical_parent_id=$2, canonical_student_id=$3,
             reason_code='CLAIM_REPLAY', last_error_code=NULL,
             resolved_at=COALESCE(resolved_at,NOW()), resolved_by=COALESCE(resolved_by,$4),
             last_processed_at=NOW(), correlation_id=COALESCE(correlation_id,$5::uuid)
           WHERE id=$1`,
          [family.id, linkedParent.id, linkedStudent.id, actor, correlationId]
        );
        const extra = await _attachExtraStudents(client, linkedParent.id, extras, { canAppend: false });
        await client.query('COMMIT');
        return { parent: linkedParent, student: linkedStudent, replayed: true, sync_state: 'SYNC_PENDING',
          correlation_id: correlationId, ignored_students: extra.ignored };
      }
    }

    const parentRows = (await client.query(
      `SELECT * FROM parents
        WHERE phone=$1 OR regexp_replace(COALESCE(phone,''), '\\D', '', 'g')=$1
        ORDER BY created_at,id FOR UPDATE`,
      [phoneCanonical]
    )).rows;
    if (parentRows.length > 1) {
      reviewContext = { z03Ids: [family.id], sourceRecordId: family.z01_ragic_record_id, code: 'DUPLICATE_PARENT_IDENTITY' };
      throw new Z03ClaimError('DUPLICATE_PARENT_IDENTITY', 'canonical phone 命中多個 parent', 409);
    }
    const uidParent = (await client.query(`SELECT * FROM parents WHERE line_uid=$1 FOR UPDATE`, [lineUid])).rows[0] || null;
    let parent = parentRows[0] || null;
    if (uidParent && parent && uidParent.id !== parent.id) {
      throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', 'LINE UID 已綁另一個 parent', 409);
    }
    if (uidParent && !parent) {
      if (normalizePhone(uidParent.phone) !== phoneCanonical) {
        throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', 'LINE UID 已綁另一個 phone', 409);
      }
      parent = uidParent;
    }
    if (parent?.line_uid && parent.line_uid !== lineUid) {
      throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', '手機已綁另一個 LINE UID', 409);
    }

    if (!parent) {
      const displayName = String(parentName || family.raw_name || '').trim() || '未命名家長';
      parent = (await client.query(
        `INSERT INTO parents
           (phone,name,line_uid,gender,email,identity,home_phone,home_address,line_id,
            ragic_record_id,is_active,last_synced_at)
         VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),
                 NULLIF($8,''),NULLIF($9,''),$10,TRUE,NOW())
         RETURNING *`,
        [phoneCanonical, displayName, lineUid, family.gender_raw || '', family.email_raw || '',
         family.identity_raw || '', family.home_phone_raw || '', family.home_address_raw || '',
         family.line_id_raw || '', family.z01_ragic_record_id]
      )).rows[0];
    } else {
      parent = (await client.query(
        `UPDATE parents SET
           line_uid=COALESCE(line_uid,$2),
           name=CASE WHEN name='未命名家長' THEN COALESCE(NULLIF($3,''),NULLIF($4,''),name) ELSE name END,
           ragic_record_id=COALESCE(ragic_record_id,$5),
           is_active=TRUE, updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [parent.id, lineUid, String(parentName || '').trim(), family.raw_name || '', family.z01_ragic_record_id]
      )).rows[0];
    }
    parent = await _applyAllowlistedLocalProfile(client, parent, submittedProfile, ownershipVerified);

    const canonicalStudents = (await client.query(
      `SELECT * FROM students WHERE parent_id=$1 ORDER BY created_at,id FOR UPDATE`, [parent.id]
    )).rows.filter((row) => normalizeStudentName(row.name) === studentNameNormalized);
    if (canonicalStudents.length > 1) {
      reviewContext = { z03Ids: [family.id], sourceRecordId: family.z01_ragic_record_id, code: 'AMBIGUOUS_STUDENT_MATCH' };
      throw new Z03ClaimError('AMBIGUOUS_STUDENT_MATCH', 'canonical family 內同名 student 命中多筆', 409);
    }
    const student = canonicalStudents[0] || await _mirrorSourceStudent(client, parent.id, matchedChild);
    // 新的學員跟這筆 outbox 一起送 Ragic；這個來源之前已排過 outbox 就加不進去，回傳已忽略讓家長登入後再新增。
    const bindKey = `bind-z01-line-uid:${family.z01_ragic_record_id}`;
    const bindQueued = (await client.query(`SELECT 1 FROM ragic_sync_outbox WHERE idempotency_key=$1`, [bindKey])).rowCount > 0;
    const extra = await _attachExtraStudents(client, parent.id, extras, { canAppend: !bindQueued });

    const claim = (await client.query(
      `INSERT INTO identity_claims
         (purpose,state,phone_canonical,student_name_normalized,canonical_parent_id,
          canonical_student_id,line_uid_hash,source_system,source_table,source_record_id,
          correlation_id,verified_at,linked_at)
       VALUES ('CLAIM_LEGACY','SYNC_PENDING',$1,$2,$3,$4,$5,'RAGIC','Z01',$6,$7,NOW(),NOW())
       ON CONFLICT (purpose,source_system,source_table,source_record_id,student_name_normalized)
       DO UPDATE SET state='SYNC_PENDING', canonical_parent_id=EXCLUDED.canonical_parent_id,
                     canonical_student_id=EXCLUDED.canonical_student_id,
                     line_uid_hash=EXCLUDED.line_uid_hash, last_error_code=NULL,
                     version=identity_claims.version+1, updated_at=NOW(),
                     verified_at=COALESCE(identity_claims.verified_at,NOW()),
                     linked_at=COALESCE(identity_claims.linked_at,NOW())
       RETURNING *`,
      [phoneCanonical, studentNameNormalized, parent.id, student.id, _lineUidHash(lineUid),
       family.z01_ragic_record_id, correlationId]
    )).rows[0];

    await client.query(
      `INSERT INTO source_record_links
         (source_system,source_table,source_record_id,canonical_parent_id,
          canonical_student_id,claim_id,link_method)
       VALUES ('RAGIC','Z01',$1,$2,$3,$4,$5)
       ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
         canonical_parent_id=EXCLUDED.canonical_parent_id,
         canonical_student_id=COALESCE(source_record_links.canonical_student_id,EXCLUDED.canonical_student_id),
         claim_id=EXCLUDED.claim_id,
         link_method=EXCLUDED.link_method,
         updated_at=NOW()`,
      [family.z01_ragic_record_id, parent.id, student.id, claim.id, resolutionMethod]
    );
    await client.query(
      `UPDATE ragic_z03_students SET canonical_student_id=$2
        WHERE id=ANY($1::bigint[])`,
      [allExactMatchIds, student.id]
    );
    for (const alias of aliasFamilies) {
      await client.query(
        `INSERT INTO source_record_links
           (source_system,source_table,source_record_id,canonical_parent_id,
            canonical_student_id,claim_id,link_method)
         VALUES ('RAGIC','Z01',$1,$2,$3,$4,'MULTIPLE_SOURCE_ALIAS')
         ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET
           canonical_parent_id=EXCLUDED.canonical_parent_id,
           canonical_student_id=COALESCE(source_record_links.canonical_student_id,EXCLUDED.canonical_student_id),
           claim_id=EXCLUDED.claim_id,link_method=EXCLUDED.link_method,updated_at=NOW()`,
        [alias.z01_ragic_record_id, parent.id, student.id, claim.id]
      );
    }
    if (aliasFamilies.length) {
      await client.query(
        `UPDATE ragic_z03_records SET status='resolved',classification='SOURCE_ALIAS',
           reason_code=$2,claim_state='ALIAS_LINKED',canonical_parent_id=$3,
           canonical_student_id=$4,last_processed_at=NOW(),correlation_id=$5
         WHERE id=ANY($1::bigint[])`,
        [aliasFamilies.map((row) => row.id), resolutionMethod, parent.id, student.id, claim.correlation_id]
      );
    }
    await client.query(
      `INSERT INTO identity_claim_events
         (claim_id,from_state,to_state,reason_code,actor_type,correlation_id)
       VALUES ($1,'MATCHED','SYNC_PENDING','LOCAL_LINK_COMMITTED',$2,$3)`,
      [claim.id, actor, claim.correlation_id]
    );
    const profile = buildParentProfilePatch({
      sourceProfile: _sourceProfileFromFamily(family, remoteUid),
      parentInput: submittedProfile,
      lineUid,
      ownershipVerified,
      includeUid: remoteUid !== lineUid,
    });
    await insertProfilePatchAudit(client, {
      parentId: parent.id,
      sourceRecordId: family.z01_ragic_record_id,
      changes: profile.changes,
      correlationId: claim.correlation_id,
      actor,
    });
    await client.query(
      `INSERT INTO ragic_sync_outbox
         (idempotency_key,claim_id,operation,source_system,source_table,source_record_id,
          payload_reference,state,correlation_id,target_record_id,field_id)
       VALUES ($1,$2,'BIND_Z01_LINE_UID','RAGIC','Z01',$3,$4::jsonb,'pending',$5,$3,'1006846')
      ON CONFLICT (idempotency_key) DO NOTHING`,
      [bindKey, claim.id, family.z01_ragic_record_id,
       JSON.stringify({ canonical_parent_id: parent.id, profile_patch: profile.patch,
         students_to_append: extra.toRagic, verify_readback: registrationCompletion,
         skip_uid_write: remoteUid === lineUid }),
       claim.correlation_id]
    );
    await client.query(
      `UPDATE ragic_z03_records SET
         status='resolved', classification='RESOLVED', reason_code='CLAIM_LINKED_LOCAL',
         claim_state='SYNC_PENDING', canonical_parent_id=$2, canonical_student_id=$3,
         resolved_at=NOW(), resolved_by=$4, last_error_code=NULL,
         last_processed_at=NOW(), correlation_id=$5
       WHERE id=$1`,
      [family.id, parent.id, student.id, actor, claim.correlation_id]
    );

    await client.query('COMMIT');
    return { parent, student, replayed: false, sync_state: 'SYNC_PENDING', correlation_id: claim.correlation_id,
      ignored_students: extra.ignored };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (attemptResult.outcome !== 'COOLDOWN') {
      attemptResult = failedAttempt ? { outcome: 'FAILED', sourceRecordId: failedAttempt.sourceRecordId } : { outcome: 'ERROR' };
    }
    if (reviewContext) {
      await _persistManualReview({
        ...reviewContext,
        phoneCanonical,
        studentNameNormalized,
        lineUid,
        correlationId,
      }).catch((persistErr) => {
        err.manualReviewPersistenceError = persistErr.code || persistErr.message;
      });
    }
    if (err instanceof Z03ClaimError) throw err;
    if (err.code === '23505' && err.constraint === 'uq_parents_phone_canonical_active') {
      throw new Z03ClaimError('PHONE_AMBIGUOUS', 'canonical phone 已由另一個 parent 使用', 409);
    }
    if (err.code === '23505' && err.constraint === 'parents_line_uid_key') {
      throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', 'LINE UID unique constraint conflict', 409);
    }
    throw new Z03ClaimError('LOCAL_TRANSACTION_FAILED', '本地認領 transaction 失敗', 500, {
      constraint: err.constraint || null,
      causeCode: err.code || null,
    });
  } finally {
    await _finishClaimAttempt(client, attempt, attemptResult);
    client.release();
  }
}

module.exports = {
  Z03ClaimError,
  claimZ03Identity,
  pickRegistrationClaimStudent,
  registerNewParentLocalFirst,
  completeTrueUidRegistration,
  __test__: {
    safeDate: _safeDate,
    lineUidHash: _lineUidHash,
    classifyConstraint: _classifyConstraint,
  },
};
