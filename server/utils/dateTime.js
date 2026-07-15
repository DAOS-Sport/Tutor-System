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

module.exports = {
  TAIPEI_TIME_ZONE,
  formatPlainDate,
  formatRagicDate,
  taipeiToday,
  addCalendarDays,
  taipeiWeekStart,
  formatTaipeiDateTime,
  formatTaipeiTime,
};
