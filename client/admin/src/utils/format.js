const WEEKDAY_TC = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function pad2(n) { return String(n).padStart(2, '0'); }

// 全站時間一律顯示台北時間（UTC+8，無日光節約時間），不可用 getHours() 等本地時區
// getter — 瀏覽器/伺服器所在時區不一定是台北，會導致顯示時間整整偏差 8 小時。
function toTaipei(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000);
}

export function formatTWD(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return 'NT$ 0';
  return `NT$ ${Math.round(Number(amount)).toLocaleString('en-US')}`;
}

export function formatTWDate(input) {
  const d = toTaipei(input);
  if (!d) return '—';
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}（${WEEKDAY_TC[d.getUTCDay()]}）`;
}

export function formatTWDateTime(input) {
  const d = toTaipei(input);
  if (!d) return '—';
  return `${formatTWDate(input)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatTWDateTimeSeconds(input) {
  const d = toTaipei(input);
  if (!d) return '—';
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

export function toTaipeiDateTimeInput(input) {
  const d = toTaipei(input);
  if (!d) return '';
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatHM(input) {
  const d = toTaipei(input);
  if (!d) return '—';
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function todayISO() {
  const d = toTaipei(new Date());
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// DATE 欄位不代表 timestamp；純字串只正規化分隔符，不做 UTC 轉換。
export function formatPlainDate(input) {
  if (input == null || input === '') return '';
  const raw = String(input).trim();
  const m = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  const d = toTaipei(input);
  return d ? `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` : '';
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
    lifeguard: '救生員',
  }[role] || role);
}

export function checkinStatusLabel(s) {
  return ({ checked_in: '已簽到', absent: '未到', not_yet: '尚未開始' }[s] || s);
}
