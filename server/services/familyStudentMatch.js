'use strict';
// 同一位家長名下，一筆 Ragic 學員資料對到本地哪一位（Owner 2026-10-20：中文同名者很多，學員以身分證為主）。
//   1. Ragic 紀錄編號相同 → 就是那一位（Ragic 端改名照改）
//   2. 身分證相同且同名 → 那一位。同一輪已被對走的那位又被同名同號命中：生日、性別也一樣才是同一個孩子重複出現
//      （回 duplicate，只補空白欄位）；不一樣多半是兄弟姊妹的身分證打錯 → 分不出來；
//      身分證相同但不同名（兄弟姊妹撞號、填反）→ 分不出來，不憑身分證改名
//   3. 同名：本地那位沒有身分證 → 就是那一位（同一輪另有一位同名、身分證不同、又對不到本地其他人的，就分不出來）；
//      本地那位身分證不同：它的身分證還在這一輪 Ragic 資料裡 → 另一個孩子，新建；不在了 → 多半是更正，沿用那一位
//   沒有身分證可分辨時照舊：同名只有一位就沿用，多位分不出來。
// batch：這一輪同步的全部 Ragic 學員（判斷「另一位還在不在」）；taken：Map(本地學員 id → 這一輪對上它的那筆 Ragic 資料)；
// normalizeGender：比性別前先統一寫法（「男」與「生理男」是同一個值），由呼叫端傳入 ragic.normalizeGender。
// 回傳 { row }、{ row, duplicate: true }、{ ambiguous: reason }（SAME_NAME_NO_ID 是原本就有的「同名多筆」）或 {}（沒有對上，要新建）。
const { normalizeStudentName } = require('./identityNormalizer');

const normalizeId = (value) => String(value || '').trim().toUpperCase();

function matchFamilyStudent(rows, incoming, { taken = new Map(), batch = [incoming], normalizeGender = (v) => v } = {}) {
  const id = normalizeId(incoming?.id_number);
  const name = normalizeStudentName(incoming?.name);
  const sameName = (row) => normalizeStudentName(row.name) === name;
  const ragicId = String(incoming?.ragic_record_id || '').trim();
  if (ragicId) {
    const byRagicId = rows.find((row) => String(row.ragic_record_id || '').trim() === ragicId);
    const rowId = normalizeId(byRagicId?.id_number);
    if (byRagicId) return id && rowId && rowId !== id && taken.has(byRagicId.id) ? { ambiguous: 'RAGIC_ID_TAKEN' } : { row: byRagicId };
  }
  if (!id) {
    const named = rows.filter(sameName);
    if (named.length > 1) return { ambiguous: 'SAME_NAME_NO_ID' };
    return named.length ? { row: named[0] } : {};
  }
  const free = rows.filter((row) => !taken.has(row.id));
  const byIdNamed = rows.filter((row) => normalizeId(row.id_number) === id && sameName(row));
  const byIdNamedFree = byIdNamed.filter((row) => !taken.has(row.id));
  if (byIdNamedFree.length > 1) return { ambiguous: 'SAME_ID_SAME_NAME' };
  if (byIdNamedFree.length === 1) return { row: byIdNamedFree[0] };
  if (byIdNamed.length) {
    const first = taken.get(byIdNamed[0].id);
    const differs = (key, norm = (v) => v) => {
      const a = String(norm(first?.[key]) || '').trim();
      const b = String(norm(incoming?.[key]) || '').trim();
      return Boolean(a && b && a !== b);
    };
    return differs('birth_date') || differs('gender', normalizeGender)
      ? { ambiguous: 'SAME_ID_CONFLICTING_DATA' } : { row: byIdNamed[0], duplicate: true };
  }
  if (free.some((row) => normalizeId(row.id_number) === id)) return { ambiguous: 'ID_NAME_MISMATCH' };
  const named = free.filter(sameName);
  const withoutId = named.filter((row) => !normalizeId(row.id_number));
  if (withoutId.length) {
    // 同一輪另一位同名、身分證不同的孩子，如果本地已有同名同號那位，就是那位，不影響這裡的判斷。
    const onFile = (otherId) => rows.some((row) => sameName(row) && normalizeId(row.id_number) === otherId);
    const sibling = batch.some((other) => {
      const otherId = normalizeId(other.id_number);
      return other !== incoming && normalizeStudentName(other.name) === name && otherId && otherId !== id && !onFile(otherId);
    });
    return withoutId.length === 1 && !sibling ? { row: withoutId[0] } : { ambiguous: 'SAME_NAME_UNKNOWN_ID' };
  }
  const batchIds = new Set(batch.map((other) => normalizeId(other.id_number)).filter(Boolean));
  const corrected = named.filter((row) => !batchIds.has(normalizeId(row.id_number)));
  if (corrected.length > 1) return { ambiguous: 'SAME_NAME_ID_CORRECTED' };
  if (corrected.length === 1) return { row: corrected[0] };
  return {};
}

// 先處理帶身分證的，再處理沒身分證的：同一個孩子一筆有、一筆沒有身分證時，不會被當成兩位。
const withIdFirst = (students) => [...(students || [])]
  .sort((a, b) => Number(!normalizeId(a?.id_number)) - Number(!normalizeId(b?.id_number)));

module.exports = { matchFamilyStudent, withIdFirst };
