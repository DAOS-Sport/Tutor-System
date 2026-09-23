/**
 * 家庭帳號的純規則（不連 DB，tests/family_rules_test.js 直接驗）。
 * 規格：docs/family_accounts_spec_2026-09-23.md §1、§9、§14。
 */

const RELATIONSHIP_LABELS = {
  father: '爸爸',
  mother: '媽媽',
  grandfather: '爺爺',
  grandmother: '奶奶',
  maternal_grandfather: '外公',
  maternal_grandmother: '外婆',
  guardian: '其他照顧者',
};

function relationshipLabel(code) {
  return RELATIONSHIP_LABELS[code] || '家人';
}

function isRelationship(code) {
  return Object.prototype.hasOwnProperty.call(RELATIONSHIP_LABELS, code);
}

/**
 * 同一個孩子在兩個帳號各有一份資料時，怎麼處理（§9）。
 * copy = { id, parentId, inRagic: boolean（有 ragic_record_id）, periods: 掛了幾個課期 }
 * 回傳：
 *   { action: 'deactivate', studentId, keepId } 停用多出來的那份
 *   { action: 'keep_both', reason }            兩份都有課：先都留著，課程結束後再處理
 *   { action: 'manual', reason }               無法自動判斷，交給櫃台
 * 原則：保留 Ragic 上那份；絕不搬課程（會動到扣堂與簽到紀錄，屬凍結範圍）。
 */
function resolveDuplicate(a, b) {
  if (!a || !b || a.id === b.id) return { action: 'manual', reason: 'invalid' };
  const withCourses = [a, b].filter((c) => c.periods > 0);
  const inRagic = [a, b].filter((c) => c.inRagic);
  if (withCourses.length === 2) return { action: 'keep_both', reason: 'both_have_courses' };
  if (withCourses.length === 1) {
    const keep = withCourses[0];
    const drop = keep === a ? b : a;
    if (!keep.inRagic) return { action: 'manual', reason: 'courses_on_non_ragic_copy' };
    return { action: 'deactivate', studentId: drop.id, keepId: keep.id };
  }
  // 兩份都沒課：保留 Ragic 上那份
  if (inRagic.length === 1) {
    const keep = inRagic[0];
    return { action: 'deactivate', studentId: (keep === a ? b : a).id, keepId: keep.id };
  }
  return { action: 'manual', reason: inRagic.length ? 'both_in_ragic' : 'neither_in_ragic' };
}

/**
 * 家庭建議／申請核准時，誰當擁有者（§9 第 1 點）：孩子在 Ragic 上所屬的那位家長。
 * 兩份都在 Ragic 或都不在 → null（交給櫃台指定）。
 */
function ownerParentFor(a, b) {
  const inRagic = [a, b].filter((c) => c && c.inRagic);
  return inRagic.length === 1 ? inRagic[0].parentId : null;
}

module.exports = {
  RELATIONSHIP_LABELS,
  relationshipLabel,
  isRelationship,
  resolveDuplicate,
  ownerParentFor,
};
