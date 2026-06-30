// 客戶資料管理：敏感 PII 去識別化（身分證、血型）。
// reveal=true（管理者按「顯示個資」）才回原值，否則遮罩。

export function maskIdNumber(id, reveal = false) {
  if (!id) return '—';
  if (reveal) return id;
  if (String(id).length < 5) return '****';
  return `${String(id).slice(0, 3)}****${String(id).slice(-2)}`;
}

export function maskBloodType(bt, reveal = false) {
  if (!bt) return '—';
  return reveal ? bt : '••';
}
