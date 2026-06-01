/**
 * U8：個資去敏工具（後端）
 *
 * 用於「跨家庭顯示」的場景（團購加入頁／狀態頁顯示他家長、他學生時），
 * 一律在後端把原始值遮罩後才回傳，避免明文 PII 流到前端。
 *
 * 規則（主管指定）：
 *  - 姓名：遮中間字。三字以上 → 首字 + X… + 末字（莊柏彥 → 莊X彥；歐陽宇哲 → 歐XX哲）；
 *          兩字名 → 首字 + X（王明 → 王X）；一字或空 → 原樣。
 *  - 身分證字號等重要識別碼：全遮（回傳等長星號，空值回空字串）。
 */

function maskName(name) {
  const s = (name == null ? '' : String(name)).trim();
  if (s.length <= 1) return s;
  if (s.length === 2) return s[0] + 'X';
  return s[0] + 'X'.repeat(s.length - 2) + s[s.length - 1];
}

function maskNames(names) {
  if (!Array.isArray(names)) return [];
  return names.map(maskName);
}

function maskIdNumber(id) {
  const s = (id == null ? '' : String(id)).trim();
  if (!s) return '';
  return '*'.repeat(s.length);
}

module.exports = { maskName, maskNames, maskIdNumber };
