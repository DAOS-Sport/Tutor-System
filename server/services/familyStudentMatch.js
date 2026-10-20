'use strict';
// 同一位家長名下，一筆 Ragic 學員資料對到本地哪一位（Owner 2026-10-20：中文同名者很多，學員以身分證為主）。
// 順序：Ragic 紀錄編號相同 → 身分證相同 → 同名且身分證不衝突、這一輪還沒被別筆對走。
// 同名但身分證不同是另一個孩子，不對上。沒有身分證可分辨時照舊：同名只有一位就沿用那一位。
// 回傳 { row }（對上）、{ ambiguous: true }（分不出是哪一位，交給人工整理）或 {}（沒有對上，要新建）。
const { normalizeStudentName } = require('./identityNormalizer');

const normalizeId = (value) => String(value || '').trim().toUpperCase();

function matchFamilyStudent(rows, incoming, taken = new Set()) {
  const ragicId = String(incoming?.ragic_record_id || '').trim();
  if (ragicId) {
    const byRagicId = rows.find((row) => String(row.ragic_record_id || '').trim() === ragicId);
    if (byRagicId) return { row: byRagicId };
  }
  const id = normalizeId(incoming?.id_number);
  if (id) {
    const byId = rows.filter((row) => normalizeId(row.id_number) === id);
    if (byId.length > 1) return { ambiguous: true };
    if (byId.length === 1) return { row: byId[0] };
  }
  const name = normalizeStudentName(incoming?.name);
  const sameName = rows.filter((row) => normalizeStudentName(row.name) === name
    && !(id && normalizeId(row.id_number) && normalizeId(row.id_number) !== id));
  const free = sameName.filter((row) => !taken.has(row.id));
  if (free.length > 1) return { ambiguous: true };
  if (free.length === 1) return { row: free[0] };
  if (!id && sameName.length === 1) return { row: sameName[0] };
  if (sameName.length > 1) return { ambiguous: true };
  return {};
}

module.exports = { matchFamilyStudent };
