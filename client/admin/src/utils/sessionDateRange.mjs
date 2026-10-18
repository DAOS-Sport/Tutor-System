import { addCalendarMonths, isValidCivilDate } from './reconcileDateRange.mjs';

export function sessionEndBounds(anchor) {
  return { min: addCalendarMonths(anchor, -3), max: addCalendarMonths(anchor, 3) };
}

// The first selection remains the calendar anchor, even when the query is sorted.
export function normalizeSessionDateRange(selectedFrom, selectedTo) {
  if (!isValidCivilDate(selectedFrom) || !isValidCivilDate(selectedTo)) return null;
  const { min, max } = sessionEndBounds(selectedFrom);
  if (selectedTo < min || selectedTo > max) return null;
  const [from, to] = [selectedFrom, selectedTo].sort();
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  return { from, to, days, selectedFrom, selectedTo };
}
