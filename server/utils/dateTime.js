const TAIPEI_TIME_ZONE = 'Asia/Taipei';
const PLAIN_DATE_RE = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function partsInTaipei(value, withTime = false) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const options = {
    timeZone: TAIPEI_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  };
  if (withTime) Object.assign(options, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', options)
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
}

// PostgreSQL DATE is a business calendar date, not an instant. Plain strings are parsed
// component-by-component; Date/timestamp values are projected to the Taipei calendar first.
function formatPlainDate(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') {
    const clean = value.trim();
    const exact = clean.match(PLAIN_DATE_RE);
    if (exact) return `${exact[1]}-${pad2(exact[2])}-${pad2(exact[3])}`;
  }
  const p = partsInTaipei(value);
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

function formatRagicDate(value) {
  return formatPlainDate(value).replace(/-/g, '/');
}

function taipeiToday(value = new Date()) {
  return formatPlainDate(value);
}

// Calendar arithmetic stays in a UTC-backed date container so DST or the host
// process timezone can never move a Taipei business date.
function addCalendarDays(value, days) {
  const plain = formatPlainDate(value);
  const match = plain.match(PLAIN_DATE_RE);
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(days || 0)));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function taipeiWeekStart(value = new Date()) {
  const plain = taipeiToday(value);
  const weekday = new Date(`${plain}T12:00:00Z`).getUTCDay();
  return addCalendarDays(plain, -weekday);
}

function formatTaipeiDateTime(value, { seconds = false } = {}) {
  const p = partsInTaipei(value, true);
  if (!p) return '';
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}${seconds ? `:${p.second}` : ''}`;
}

function formatTaipeiTime(value) {
  const p = partsInTaipei(value, true);
  return p ? `${p.hour}:${p.minute}` : '';
}

// 台北「年-月」（YYYY-MM）。不可用 new Date().toISOString().slice(0, 7) ——
// 那是 UTC 的月份，每月 1 日台北 00:00–08:00 會算成上個月。
function taipeiMonthKey(value = new Date()) {
  return taipeiToday(value).slice(0, 7);
}

// ── pg 回傳值解析（無時區型別）────────────────────────────────────────────
// pg 預設把 DATE（1082）與 TIMESTAMP WITHOUT TIME ZONE（1114）以「Node 行程的
// 本地時區」解讀成 Date。正式機 TZ=Asia/Taipei 所以剛好正確，但那是靠
// server/index.js 的 process.env.TZ 撐著；測試、腳本或任何沒載入 index.js 的
// 行程只要 TZ 不同，DATE 就會變成別的時刻（例如 TZ=Asia/Tokyo 時，經台北投影
// 會退回前一天）。這裡固定以台北牆鐘解讀：在 TZ=Asia/Taipei 下與 pg 預設逐位元
// 相同（不改變正式站任何輸出），在其他 TZ 下也得到同一個絕對時刻。
// infinity / BC 等罕見值交回 pg 原本的解析器，不在這裡猜。
const PG_PLAIN_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PG_PLAIN_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?$/;

function parsePgDateAsTaipei(text, fallback) {
  const m = PG_PLAIN_DATE_RE.exec(String(text));
  if (!m) return fallback ? fallback(text) : text;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`);
}

function parsePgTimestampAsTaipei(text, fallback) {
  const m = PG_PLAIN_TIMESTAMP_RE.exec(String(text));
  if (!m) return fallback ? fallback(text) : text;
  // 小數秒最多取到毫秒（JS Date 精度），與 pg 預設行為一致。
  const ms = m[7] ? m[7].slice(0, 4).padEnd(4, '0') : '.000';
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${ms}+08:00`);
}

module.exports = {
  TAIPEI_TIME_ZONE,
  formatPlainDate,
  formatRagicDate,
  taipeiToday,
  addCalendarDays,
  taipeiWeekStart,
  formatTaipeiDateTime,
  formatTaipeiTime,
  taipeiMonthKey,
  parsePgDateAsTaipei,
  parsePgTimestampAsTaipei,
};
