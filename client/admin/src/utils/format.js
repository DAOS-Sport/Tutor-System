const WEEKDAY_TC = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function pad2(n) { return String(n).padStart(2, '0'); }

export function formatTWD(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return 'NT$ 0';
  return `NT$ ${Math.round(Number(amount)).toLocaleString('en-US')}`;
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

export function formatHM(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function isValidTWPhone(phone) {
  return /^09\d{8}$/.test(String(phone || '').trim());
}

export function isValidLast5(s) {
  return /^\d{5}$/.test(String(s || '').trim());
}

export function courseTypeLabel(type) {
  return ({ 1: '1 對 1', 2: '1 對 2', 3: '1 對 3' }[type] || `1 對 ${type}`);
}

export function paymentStatusLabel(status) {
  return ({
    pending_payment: '待對帳',
    confirmed: '已對帳',
    active: '進行中',
    completed: '已結束',
    expired: '已到期',
    cancelled: '已取消',
    refunded: '已退費',
  }[status] || status);
}

export function paymentStatusTone(status) {
  return ({
    pending_payment: 'amber',
    confirmed: 'teal',
    active: 'green',
    completed: 'gray',
    expired: 'gray',
    cancelled: 'gray',
    refunded: 'error',
  }[status] || 'gray');
}

export function roleLabel(role) {
  return ({
    admin: '系統管理員',
    manager: '場館主管',
    staff: '行政櫃檯',
    coach: '教練',
  }[role] || role);
}

export function checkinStatusLabel(s) {
  return ({ checked_in: '已簽到', absent: '未到', not_yet: '尚未開始' }[s] || s);
}
