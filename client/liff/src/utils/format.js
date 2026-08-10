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

// PostgreSQL DATE / birthday serializer: do not reinterpret a plain calendar date as UTC.
export function formatPlainDate(input) {
  if (input == null || input === '') return '';
  const raw = String(input).trim();
  const m = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  return formatTWYMD(input);
}

// Calendar-only Date container. Always use UTC getters/setters with this value.
export function taipeiCalendarDate(input = new Date()) {
  const ymd = formatPlainDate(input);
  return ymd ? new Date(`${ymd}T00:00:00Z`) : null;
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

// 性別正規化：統一為 Ragic/DB 選項值「生理男 / 生理女 / 不方便透漏」。
// 用於：表單送出前、以及讀取既有資料（舊值可能是 男/女）填回下拉時。
export function normalizeGender(g) {
  const v = String(g || '').trim();
  if (!v) return '';
  if (v.startsWith('生理')) return v;
  if (['男', 'M', 'male', 'Male'].includes(v)) return '生理男';
  if (['女', 'F', 'female', 'Female'].includes(v)) return '生理女';
  if (v.includes('不方便') || v.includes('不便') || v.includes('不願') || v.includes('不透')) return '不方便透漏';
  return v;
}

export function courseTypeLabel(type) {
  // 顧客端統一顯示 1對N（DB seed label「一對一…」維持給後台用）；未知 type 也以 1對N 呈現。
  return ({ 1: '1對1', 2: '1對2', 3: '1對3', 4: '1對4', 5: '1對5', 6: '1對6' }[type] || `1對${type}`);
}

export function paymentStatusLabel(status) {
  return ({
    pending_payment: '待對帳',
    pending_reconcile: '待櫃檯確認',
    active: '進行中',
    completed: '已結束',
    expired: '已到期',
    refunded: '已退費',
  }[status] || status);
}

// 教練端卡片的簽到標籤。
//
// 自助簽到建立的 session，scheduled_at＝created_at＝checked_in_at 完全相同
// （正式庫近 60 天實測 315/315），兩個都印會讓同一個數字在同一張卡上出現兩次，
// 而且那個「課程時間」是假的 —— 教練沒排那個時間的課，那只是家長按下簽到的瞬間。
// 預約制的課兩者平均差 192 分鐘，附上簽到時間才有資訊量。
// 用「兩個時間是否接近」判斷而非 created_via：預約制若剛好準時簽到，同樣不必重複顯示。
const CHECKIN_TIME_NOISE_MS = 2 * 60 * 1000;
export function checkinLabel(scheduledAt, checkedInAt) {
  if (!checkedInAt) return '已簽到';
  const a = new Date(scheduledAt).getTime();
  const b = new Date(checkedInAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '已簽到';
  if (Math.abs(b - a) < CHECKIN_TIME_NOISE_MS) return '已簽到';
  return '已簽到 ' + formatTWTime(checkedInAt);
}

export function paymentStatusColor(status) {
  return ({
    pending_payment: 'bg-brand-amber text-white',
    pending_reconcile: 'bg-brand-amber text-white',
    active: 'bg-brand-green text-white',
    completed: 'bg-gray-400 text-white',
    expired: 'bg-gray-400 text-white',
    refunded: 'bg-gray-400 text-white',
  }[status] || 'bg-gray-300 text-gray-700');
}
