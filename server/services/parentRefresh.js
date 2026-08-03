const { pool } = require('../models/db');
const ragic = require('./ragic');
const parentSync = require('./parentSync');
const ragicAdmin = require('./ragicAdmin');
const { maskPhone } = require('../utils/piiMask');

class ParentRefreshError extends Error {
  constructor(code, message, http = 500, details = null) {
    super(message);
    this.code = code;
    this.http = http;
    this.details = details;
  }
}

// 角色身份（identity）已從家長端 UI 移除，全系統一律以 parent.identity || '一般身分'
// 當預設值使用（見 parentRegistrationProfile.js／ProfilePage.jsx），不可再列為無預設的硬性必填，
// 否則舊資料 identity 空值的帳號會永遠卡在「新增學員」動作。
const REQUIRED_Z01_FIELDS = [
  ['name', '家長姓名'],
  ['primary_venue_id', '場館'],
  ['phone', '電話'],
  ['email', 'Email'],
  ['line_uid', 'LINE UID'],
  ['gender', '性別'],
];

function _isMissingVenue(v) {
  const s = String(v || '').trim();
  return !s || s === '待補登';
}

function _isMissingLineUid(v) {
  const s = String(v || '').trim();
  return !s || s.startsWith('demo:') || s.startsWith('DEMOTEST_');
}

function getZ01MissingFields(mapped, { rejectPlaceholderName = true, requireLineUid = true } = {}) {
  const missing = [];
  for (const [key, label] of REQUIRED_Z01_FIELDS) {
    if (key === 'line_uid' && !requireLineUid) continue;
    if (key === 'primary_venue_id') {
      if (_isMissingVenue(mapped?.[key])) missing.push({ key, label });
      continue;
    }
    if (key === 'line_uid') {
      if (_isMissingLineUid(mapped?.[key])) missing.push({ key, label });
      continue;
    }
    if (!String(mapped?.[key] || '').trim()) missing.push({ key, label });
  }
  if (
    rejectPlaceholderName &&
    mapped?.name &&
    ragicAdmin.isPlaceholderParentName(mapped.name) &&
    !missing.some((m) => m.key === 'name')
  ) {
    missing.push({ key: 'name', label: '家長姓名' });
  }
  return missing;
}

function assertZ01Complete(mapped, opts = {}) {
  const missing = getZ01MissingFields(mapped, opts);
  if (missing.length) {
    throw new ParentRefreshError(
      'Z01_INCOMPLETE',
      `Z01 會員資料不完整：${missing.map((m) => m.label).join('、')}`,
      409,
      { missing }
    );
  }
}

function _studentKey(student) {
  const idNum = String(student?.id_number || '').trim().toUpperCase();
  if (idNum) return `id:${idNum}`;
  const rid = String(student?.ragic_record_id || '').trim();
  if (rid) return `rid:${rid}`;
  return `name:${String(student?.name || '').trim()}|birth:${String(student?.birth_date || '').slice(0, 10)}`;
}

function _mergeStudents(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const s of list || []) {
      if (!s?.name) continue;
      const key = _studentKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

async function _lookupZ01({ lineUid, phone }) {
  let row = null;
  if (lineUid) row = await ragic.getParentByLineUid(lineUid);
  if (!row && phone) row = await ragic.getParentByPhone(phone);
  return row;
}

async function _loadLocalStudents(parentId) {
  const r = await pool.query(
    `SELECT id, name, birth_date, gender, id_number, blood_type, student_code, is_active
       FROM students
      WHERE parent_id = $1 AND COALESCE(is_active, TRUE) = TRUE
      ORDER BY created_at ASC`,
    [parentId]
  );
  return r.rows;
}

/**
 * Ragic 寫入後的嚴格刷新門檻：
 *  1. 重新查 Z01，確認 UID/phone 指向剛寫入的乾淨會員資料。
 *  2. 檢查 Z01 必填完整，且姓名不可仍是電話佔位。
 *  3. 重新查 Z02 學員並與 Z01 linked 子表合併，更新本地 parents/students。
 *  4. 若曾進 Z03/quarantine，標記 resolved。
 *  5. 驗證本地鏡射已與本次登入 UID、phone、學生數一致。
 */
async function refreshParentMirrorFromRagic({
  lineUid,
  phone,
  minStudents = 0,
  allowRebind = false,
  reactivate = true,
  preservePending = false,
  requireComplete = true,
  markZ03Resolved = true,
  // 預設 true＝維持既有的嚴格語意（註冊／綁定寫入後必須驗到 UID 已生效）。
  // 只有「背景刷新」這類非安全門檻的呼叫端可以放寬，見下方 UID 檢查處的說明。
  strictUidMatch = true,
  reason = 'auth',
} = {}) {
  if (!lineUid && !phone) {
    throw new ParentRefreshError('REFRESH_LOOKUP_REQUIRED', '缺少 LINE UID 或手機，無法重新整理會員資料', 500);
  }

  let z01Row;
  try {
    z01Row = await _lookupZ01({ lineUid, phone });
  } catch (err) {
    throw new ParentRefreshError(err.code || 'RAGIC_REFRESH_FAILED', `重新讀取 Ragic Z01 失敗：${err.message}`, 502);
  }
  if (!z01Row) {
    throw new ParentRefreshError('RAGIC_REFRESH_NOT_FOUND', 'Ragic Z01 查無剛寫入的會員資料', 502);
  }

  const mapped = ragic.mapZ01Parent(z01Row);
  const effectiveLineUid = lineUid || mapped.line_uid || null;
  if (phone && mapped.phone && mapped.phone !== phone) {
    throw new ParentRefreshError('RAGIC_REFRESH_PHONE_MISMATCH', '重新讀取的 Ragic Z01 手機與本次操作不一致', 502);
  }
  if (effectiveLineUid && mapped.line_uid !== effectiveLineUid) {
    // 區分「UID 尚未回寫」與「UID 綁到別人」——這兩件事後果天差地遠，不能用同一道門擋。
    //
    // 背景：_lookupZ01 先以 UID 查 Z01，查不到才用電話反查。若該筆 Z01 的
    // 「家教系統uid」欄位是空的（回寫失敗／舊資料從未回寫），電話反查會命中「正確的家長」，
    // 但 mapped.line_uid 為空 → 舊邏輯一律判定不一致並拋 502。
    // 對 /parents/me/sync（每次開 App 的背景刷新）而言，這代表該家長「永遠同步失敗」，
    // 而且是持續性的，不是偶發 —— production log 中大量重複的
    // 「重新讀取的 Ragic Z01 LINE UID 與本次操作不一致」即此。
    //
    // 嚴格模式（預設，註冊／綁定的寫入後驗證）：維持原行為，一律擋，
    //   確保剛寫進 Ragic 的 UID 真的生效，否則可能把資料綁到錯的人。
    // 寬鬆模式（背景刷新）：Z01 UID 為空 = 待回寫，放行並續做同步；
    //   Z01 已有「別的」UID 仍然擋 —— 那是真的兩支 LINE 搶同一支電話，必須人工處理。
    const ragicUidEmpty = !String(mapped.line_uid || '').trim();
    if (strictUidMatch || !ragicUidEmpty) {
      throw new ParentRefreshError('RAGIC_REFRESH_UID_MISMATCH', '重新讀取的 Ragic Z01 LINE UID 與本次操作不一致', 502);
    }
    console.warn('[parent-refresh] Z01 LINE UID 尚未回寫，以本地 UID 續行同步（待 outbox 回寫收斂）:', {
      reason, phone: maskPhone(mapped.phone), ragic_record_id: mapped.ragic_record_id || null,
    });
  }
  if (requireComplete) assertZ01Complete(mapped);

  let z02Students = [];
  try {
    z02Students = await ragic.getStudentsByParentPhone(mapped.phone);
  } catch (err) {
    throw new ParentRefreshError(err.code || 'RAGIC_Z02_REFRESH_FAILED', `重新讀取 Ragic Z02 學員失敗：${err.message}`, 502);
  }

  const z01Students = ragic.parseZ01Students(z01Row);
  const students = _mergeStudents(z02Students, z01Students);
  if (minStudents > 0 && students.length < minStudents) {
    throw new ParentRefreshError(
      'RAGIC_REFRESH_STUDENTS_INCOMPLETE',
      '重新讀取 Ragic 學員資料未完成，請稍後再試',
      502,
      { expected_min: minStudents, actual: students.length }
    );
  }

  let local;
  try {
    local = await parentSync._syncWithLock({
      mapped,
      students,
      lineUid: effectiveLineUid,
      reactivate,
      allowRebind,
      preservePending,
    });
  } catch (err) {
    if (err instanceof parentSync.BindConflictError) throw err;
    throw new ParentRefreshError(err.code || 'LOCAL_REFRESH_FAILED', `本地會員鏡射更新失敗：${err.message}`, 500);
  }

  // 場館解析不到（Ragic 館別名稱在本地 venues 查無，多為 H05 尚未同步/改名過渡期）
  // 不再硬擋登入/註冊——擋下只會把「資料層待收斂」升級成「使用者進不來」。
  // 記大聲 log 供追蹤；場館值會由 H05 場館同步 + 每晚 01:30 pull 自動收斂回填。
  if (requireComplete && !local.primary_venue_id) {
    console.error('[parent-refresh] 場館鏡射未解析（不擋登入，待 H05/夜間同步收斂）:', {
      reason, phone: maskPhone(mapped.phone), ragicVenue: mapped.primary_venue_id || null,
    });
  }
  if (effectiveLineUid && local.line_uid !== effectiveLineUid) {
    throw new ParentRefreshError('LOCAL_UID_REFRESH_FAILED', '本地 LINE UID 鏡射更新失敗', 500);
  }

  if (markZ03Resolved && mapped.ragic_record_id && !ragicAdmin.isPlaceholderParentName(mapped.name)) {
    try {
      await ragicAdmin.markPlaceholderNameResolved(mapped.ragic_record_id, mapped.name);
    } catch (err) {
      throw new ParentRefreshError(err.code || 'Z03_RESOLVE_FAILED', `Z03 清理狀態更新失敗：${err.message}`, 500);
    }
  }

  const localStudents = await _loadLocalStudents(local.id);
  if (minStudents > 0 && localStudents.length < minStudents) {
    throw new ParentRefreshError(
      'LOCAL_STUDENT_REFRESH_FAILED',
      '本地學員鏡射更新未完成，請稍後再試',
      500,
      { expected_min: minStudents, actual: localStudents.length }
    );
  }

  console.log('[parent-refresh] ok', {
    reason,
    phone: maskPhone(mapped.phone),
    ragicId: mapped.ragic_record_id,
    students: localStudents.length,
  });

  return {
    local,
    students: localStudents,
    ragicStudents: students,
    mapped,
    z01Row,
  };
}

module.exports = {
  ParentRefreshError,
  REQUIRED_Z01_FIELDS,
  getZ01MissingFields,
  assertZ01Complete,
  refreshParentMirrorFromRagic,
};
