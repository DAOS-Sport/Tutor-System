const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidCivilDate(value) {
  const match = DATE_RE.exec(String(value || ''));
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// YYYY-MM-DD represents a Taipei calendar day here; UTC is used only to avoid host timezone drift.
export function addCalendarMonths(value, months = 3) {
  if (!isValidCivilDate(value) || !Number.isInteger(months)) return '';
  const [year, month, day] = value.split('-').map(Number);
  const targetMonthIndex = year * 12 + month - 1 + months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12 + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

export function isWithinCalendarMonthRange(from, to, months = 3) {
  if (!isValidCivilDate(from) || !isValidCivilDate(to) || to < from) return false;
  return to <= addCalendarMonths(from, months);
}
