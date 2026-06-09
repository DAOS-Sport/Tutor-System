const WEEKDAY_TC = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
export const TAIPEI_TIME_ZONE = 'Asia/Taipei';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateObj(input) {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function twDateParts(input) {
  const d = dateObj(input);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(d);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}

export function formatTWYMD(input) {
  const p = twDateParts(input);
  if (!p) return '';
  return `${p.year}-${p.month}-${p.day}`;
}

export function todayTaipeiYMD() {
  return formatTWYMD(new Date());
}

export function addDaysToTaipeiYMD(ymd, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return '';
  const d = new Date(`${ymd}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return formatTWYMD(d);
}

export function formatTWD(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return 'NT$ 0';
  const n = Math.round(Number(amount));
  return `NT$ ${n.toLocaleString('en-US')}`;
}

export function formatTWDate(input) {
  const p = twDateParts(input);
  if (!p) return '—';
  return `${p.year}/${p.month}/${p.day}（${p.weekday}）`;
}

export function formatTWTime(input) {
  const d = dateObj(input);
  if (!d) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export function formatTWMonthKey(input) {
  const p = twDateParts(input);
  if (!p) return '';
  return `${p.year}-${p.month}`;
}

export function formatTWDateTime(input) {
  const d = dateObj(input);
  if (!d) return '—';
  return `${formatTWDate(d)} ${formatTWTime(d)}`;
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
  // 顧客端統一顯示 1V1 / 1V2 / 1V3 / 1V4（DB seed label「一對一…」維持給後台用；type 4 容量仍為 4~6 人）。
  return ({ 1: '1V1', 2: '1V2', 3: '1V3', 4: '1V4' }[type] || `1V${type}`);
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
