/**
 * U8：個資去敏工具（後端）
 *
 * 用於「跨家庭顯示」的場景（團購加入頁／狀態頁顯示他家長、他學生時），
 * 一律在後端把原始值遮罩後才回傳，避免明文 PII 流到前端。
 *
 * 規則（主管指定）：
 *  - 家長姓名：遮中間字。三字以上 → 首字 + X… + 末字（莊柏彥 → 莊X彥；歐陽宇哲 → 歐XX哲）；
 *          兩字名 → 首字 + X（王明 → 王X）；一字或空 → 原樣。
 *  - 學生姓名（跨家庭顯示）：只露姓氏首字 + 「同學」（張小明 → 張同學；測試一 → 測同學）；空 → 原樣。
 *  - 身分證字號等重要識別碼：全遮（回傳等長星號，空值回空字串）。
 */

// 一律以 Unicode code point 切字，不用 s[0] / s.length。
//
// 2026-09-07 正式站事故：家長名字開頭是 emoji（LINE 顯示名很常見）。emoji 在 JS 字串裡是
// 代理對（兩個 UTF-16 code unit），s[0] 只拿到前半個孤立高代理。JSON.stringify 照樣輸出，
// 但 Postgres ::jsonb 拒收（22P02: Unicode low surrogate must follow a high surrogate）。
// 這句發生在 outbox _markFailure → createParentIdentityBackofficeTask 的 $2::jsonb，交易整個
// rollback、錯誤碼永遠空白、錯誤再往上炸 → 夜間排空中止。兩位家長卡 45 天、其他 pending 陪葬，
// log 只有一行 22P02。dev 用中文假名重現三次都不炸，最後對正式站那一筆實跑一次才抓到 stack。
const cps = (v) => Array.from(v);   // 以 code point 為單位，emoji / 罕見字不會被切半

function maskName(name) {
  const s = (name == null ? '' : String(name)).trim();
  const c = cps(s);
  if (c.length <= 1) return s;
  if (c.length === 2) return c[0] + 'X';
  return c[0] + 'X'.repeat(c.length - 2) + c[c.length - 1];
}

// 學生姓名跨家庭顯示：姓氏第一個字 + 「同學」（保護隱私，且家長一眼看得懂是學生）。
function maskStudentName(name) {
  const s = (name == null ? '' : String(name)).trim();
  if (!s) return s;
  return cps(s)[0] + '同學';
}

function maskNames(names) {
  if (!Array.isArray(names)) return [];
  return names.map(maskStudentName);
}

function maskIdNumber(id) {
  const s = (id == null ? '' : String(id)).trim();
  if (!s) return '';
  return '*'.repeat(s.length);
}

// 電話：供 server log 追蹤用途（非跨家庭顯示）——保留頭尾各一小段供人工比對，
// 中間遮罩，避免完整號碼明文落地（docs/ragic_sync_audit.md §3 PII-in-logs 修復）。
// 太短（<=6 碼）就全遮：頭 4 + 尾 2 的切法在短字串上會重疊，等於沒遮到。
function maskPhone(phone) {
  const s = (phone == null ? '' : String(phone)).trim();
  if (!s) return '';
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(s.length - 6)}${s.slice(-2)}`;
}

module.exports = { maskName, maskStudentName, maskNames, maskIdNumber, maskPhone };
