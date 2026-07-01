/**
 * 客戶資料管理 (Z01/Z02) 後端共用工具。
 */

/**
 * 把生日字串轉成可寫入 Postgres DATE 的 ISO 'YYYY-MM-DD'，無法解析回 null。
 * 接受：西元 ISO（2019-04-04 / 2019/04/04）、民國（108/04/04，年 < 1911 視為民國 +1911）。
 * 會做「真實日曆」驗證（02/30、04/31 等不存在的日期回 null，避免 ::date 轉型拋 22008）。
 */
function parseRocOrIso(input) {
  if (!input) return null;
  const s = String(input).trim().replace(/-/g, '/');
  const m = s.match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  let year = parseInt(m[1], 10);
  if (year < 1911) year += 1911; // 民國 → 西元
  const mm = String(parseInt(m[2], 10)).padStart(2, '0');
  const dd = String(parseInt(m[3], 10)).padStart(2, '0');
  // 真實日曆驗證：用 UTC 建構回推，月/日不一致代表溢位（如 2/30 → 3/2）。
  const dt = new Date(`${year}-${mm}-${dd}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() + 1 !== parseInt(mm, 10) || dt.getUTCDate() !== parseInt(dd, 10)) {
    return null;
  }
  return `${year}-${mm}-${dd}`;
}

/**
 * course_type(整數) → 購買紀錄分類標籤。
 * ⚠️ 暫定對應（待課程需求管理確認後可一行修正）：1=常態團體班、2=課後班、其餘=其他課程。
 */
function courseTypeLabel(courseType) {
  const n = Number(courseType);
  if (n === 1) return '常態團體班';
  if (n === 2) return '課後班';
  return '其他課程';
}

// ── 伺服器端 PII 去識別化（與 client utils/pii.js 同邏輯）──────────────────
// 預設遮罩；唯有帶 reveal=1（並寫稽核）才回原值。避免每個前台瀏覽器無條件收到完整身分證。
function maskId(id) {
  if (!id) return '';
  if (String(id).length < 5) return '****';
  return `${String(id).slice(0, 3)}****${String(id).slice(-2)}`;
}
function maskBlood(bt) {
  if (!bt) return '';
  return '••';
}
/** 偵測「看起來已被遮罩」的 PII 值，PATCH 時拒絕用它覆蓋真值（防遮罩字串寫回）。 */
function looksMasked(v) {
  return typeof v === 'string' && /[*•]/.test(v);
}
/** reveal 是否開啟（query ?reveal=1）。開啟時呼叫端應寫一行稽核。 */
function wantReveal(req) {
  return String(req.query.reveal || '') === '1';
}
function auditReveal(req, kind, count) {
  const u = req.adminUser || {};
  console.log('[pii-reveal]', JSON.stringify({ by: u.sub || u.username || '?', role: u.role, kind, count }));
}

// ── 學員資料稽核（student_audit_logs）─────────────────────────────────────
// 只記白名單欄位裡實際變動的部分 → { field: { before, after } }；無變動回 null。
// 數值欄位以數值比較，避免假變動（例如 PG 回傳字串 "1" vs 前端送數字 1）。
// 沿用 routes/admin/courseTypes.js 的 diffChanges 同一套邏輯（course_type_config_audit_logs
// 的既有樣板），供 parents.js / customerStudents.js / customerParents.js 三處共用。
function diffChanges(before, after, fields) {
  const out = {};
  for (const k of fields) {
    const b = before?.[k];
    const a = after?.[k];
    const bn = Number(b);
    const an = Number(a);
    const numeric = b !== null && b !== undefined && b !== '' &&
      a !== null && a !== undefined && a !== '' && Number.isFinite(bn) && Number.isFinite(an);
    const same = numeric ? bn === an : String(b ?? '') === String(a ?? '');
    if (!same) out[k] = { before: b ?? null, after: a ?? null };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 寫一筆學員稽核紀錄。db 可傳 pool 或交易中的 client。
 * byRole：'parent' | 'staff' | 'manager' | 'admin'，用來分辨「家長自己改的」跟「櫃檯/管理員改的」。
 * changes 為 null（例如新建、或 diff 後沒有實際變動）仍會落一筆 action 紀錄，只是 changes 空。
 */
async function writeStudentAudit(db, studentId, action, { byUser, byRole, changes, note } = {}) {
  await db.query(
    `INSERT INTO student_audit_logs (student_id, action, by_user, by_role, changes, note)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [studentId, action, byUser || null, byRole || null, changes ? JSON.stringify(changes) : null, note || null]
  );
}

/** 從 admin JWT payload 取顯示用姓名/帳號（跟 courseTypes.js 的 auditUser 同邏輯）。 */
function adminActorName(req) {
  return req.adminUser?.name || req.adminUser?.username || 'unknown';
}

module.exports = {
  parseRocOrIso, courseTypeLabel, maskId, maskBlood, looksMasked, wantReveal, auditReveal,
  diffChanges, writeStudentAudit, adminActorName,
};
