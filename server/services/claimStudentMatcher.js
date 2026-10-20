'use strict';
// 家長認領時的學員核對（Owner 2026-10-20）。電話已對上之後，下列任一項就算證明是這位孩子的家長：
//   ID    送來的身分證與登記的相同（姓名打錯也過）
//   EXACT 姓名正規化後完全相同；但登記有身分證、送來的不同就不算
//   NEAR  至少三個字、同姓、只差一個字，且只對到一位孩子（例：林語桐／林語彤）
// 沒有手機簡訊驗證，所以不接受「只有電話」；兩個字的姓名只差一字等於只要猜一個字，不算 NEAR。
// 兄弟姊妹常只差最後一字（陳冠宇／陳冠廷）：會新增學員的路徑要關掉 NEAR（allowNear: false），
// 而 NEAR 對到的那位若登記了不同的身分證，就是另一個孩子，回 null 而不是衝突。
const { normalizeStudentName } = require('./identityNormalizer');

const normalizeId = (value) => String(value || '').trim().toUpperCase();

function differsByOneChar(a, b) {
  const x = [...a], y = [...b];
  if (x.length !== y.length || x.length < 3 || x[0] !== y[0]) return false;
  let diff = 0;
  for (let i = 1; i < x.length; i += 1) if (x[i] !== y[i]) diff += 1;
  return diff === 1;
}

// candidates：[{ name, id_number, ...任意欄位 }]；回傳 null（沒對上）、{ conflict: true }，
// 或 { method, name（登記的正規化姓名）, candidates（同名的登記列，同名重複會有多列） }。
function matchStudent(candidates, submitted, { allowNear = true } = {}) {
  const name = normalizeStudentName(submitted?.name);
  const id = normalizeId(submitted?.id_number);
  const rows = (candidates || []).map((c) => ({ c, name: normalizeStudentName(c.name), id: normalizeId(c.id_number) }));
  const pick = (method, list) => ({ method, name: list[0].name, candidates: list.map((r) => r.c) });
  const idConflict = (list) => Boolean(id) && list.some((r) => r.id && r.id !== id);

  // 先比同名：送來的身分證若剛好是兄弟姊妹的，不能把人對到兄弟姊妹身上。
  const exact = rows.filter((r) => r.name && r.name === name);
  if (exact.length) return idConflict(exact) ? { conflict: true } : pick('EXACT', exact);
  if (id) {
    const byId = rows.filter((r) => r.id === id);
    if (byId.length && new Set(byId.map((r) => r.name)).size === 1) return pick('ID', byId);
  }
  if (!allowNear) return null;
  const near = rows.filter((r) => r.name && differsByOneChar(r.name, name));
  if (near.length && new Set(near.map((r) => r.name)).size === 1 && !idConflict(near)) return pick('NEAR', near);
  return null;
}

module.exports = { matchStudent, differsByOneChar };
