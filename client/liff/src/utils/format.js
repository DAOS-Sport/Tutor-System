const WEEKDAY_TC = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatTWD(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return 'NT$ 0';
  const n = Math.round(Number(amount));
  return `NT$ ${n.toLocaleString('en-US')}`;
}

export function formatTWDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}（${WEEKDAY_TC[d.getDay()]}）`;
}

export function formatTWDateTime(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return `${formatTWDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function isValidTWPhone(phone) {
  return /^09\d{8}$/.test(String(phone || '').trim());
}

export function isValidLast5(s) {
  return /^\d{5}$/.test(String(s || '').trim());
}

export function isValidTWId(id) {
  return /^[A-Z][12]\d{8}$/.test(String(id || '').trim().toUpperCase());
}

export function courseTypeLabel(type) {
  return ({ 1: '1 對 1', 2: '1 對 2', 3: '1 對 3' }[type] || `1 對 ${type}`);
}

export function paymentStatusLabel(status) {
  return ({
    pending_payment: '待對帳',
    active: '進行中',
    completed: '已結束',
    expired: '已到期',
    refunded: '已退費',
  }[status] || status);
}

export function paymentStatusColor(status) {
  return ({
    pending_payment: 'bg-brand-amber text-white',
    active: 'bg-brand-green text-white',
    completed: 'bg-gray-400 text-white',
    expired: 'bg-gray-400 text-white',
    refunded: 'bg-gray-400 text-white',
  }[status] || 'bg-gray-300 text-gray-700');
}
