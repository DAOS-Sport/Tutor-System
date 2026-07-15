/**
 * 團報夥伴代簽稱謂 —— 跨家庭顯示只揭露「姓氏＋稱謂」，不揭露全名／電話。
 * gender 值域為 Ragic 正規化後的 生理男／生理女／不方便透漏（services/ragic.js _toPhysGender），
 * 無法判別（含「不方便透漏」與空值）一律退回中性的「家長」。
 */
function partnerParentTitle(gender) {
  const normalized = String(gender || '').trim().toLowerCase();
  if (['生理女', '女', 'female', 'f'].includes(normalized)) return '媽媽';
  if (['生理男', '男', 'male', 'm'].includes(normalized)) return '爸爸';
  return '家長';
}

function partnerCheckinLabel(name, gender) {
  const surname = Array.from(String(name || '').trim())[0] || '';
  return `團報夥伴${surname}${partnerParentTitle(gender)}`;
}

module.exports = { partnerCheckinLabel, partnerParentTitle };
