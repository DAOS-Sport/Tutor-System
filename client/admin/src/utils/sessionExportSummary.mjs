// Summary source for the FR01 Excel export. A class counts once when checkin_at is present.
// Classification never infers a missing historical coefficient from the coach's current value.
function normalizeMultiplier(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Number(number.toFixed(2));
}

function formatMultiplier(value) {
  return value.toFixed(2);
}

function classificationError(issues) {
  const error = new Error(`有 ${issues.length} 筆上課紀錄尚未對回購入課程係數，請確認訂單價格及教練關聯後再匯出`);
  error.code = 'SESSION_EXPORT_CLASSIFICATION_REQUIRED';
  error.issues = issues;
  return error;
}

function venueLabel(venue) {
  return String(venue?.name || venue?.label || venue?.id || '').trim();
}

// Owner-specified column order (2026-10-13): 新北高中 → 三重商工 → 三民高中, keyed by
// permanent venue ID like venueColors.mjs. Any other active venue follows, sorted by name.
const VENUE_COLUMN_ORDER = ['B', 'K', 'L'];

function venueColumnRank(id) {
  const index = VENUE_COLUMN_ORDER.indexOf(id);
  return index === -1 ? VENUE_COLUMN_ORDER.length : index;
}

function configuredMultiplierList(categories) {
  if (!Array.isArray(categories)) throw new Error('SESSION_EXPORT_COEFFICIENT_CATEGORIES_REQUIRED');
  const values = categories
    .map((item) => normalizeMultiplier(typeof item === 'object' && item !== null ? item.multiplier : item))
    .filter((value) => value !== null);
  return [...new Set(values)].sort((a, b) => a - b);
}

export function coefficientBand(value, coefficientCategories = []) {
  const normalized = normalizeMultiplier(value);
  if (normalized === null) return null;
  return configuredMultiplierList(coefficientCategories).includes(normalized)
    ? formatMultiplier(normalized)
    : null;
}

export function hasSessionCheckin(row) {
  return row.checkin_at !== null && row.checkin_at !== undefined && row.checkin_at !== '';
}

export function buildSessionSummary(sessions, venueName, { venues, coefficientCategories } = {}) {
  if (!Array.isArray(venues)) throw new Error('SESSION_EXPORT_ACTIVE_VENUES_REQUIRED');
  const multipliers = configuredMultiplierList(coefficientCategories);
  const activeVenues = venues
    .filter((venue) => venue?.id != null && venue.is_active === true)
    .map((venue) => ({ id: String(venue.id), name: venueLabel(venue) || String(venue.id) }))
    .sort((a, b) => venueColumnRank(a.id) - venueColumnRank(b.id)
      || a.name.localeCompare(b.name, 'zh-Hant') || a.id.localeCompare(b.id));
  const venueById = new Map(activeVenues.map((venue) => [venue.id, venue]));
  // Columns grow coefficient-first (1.00 → 1.20 → 1.50); venues keep the owner's order inside each coefficient.
  const columns = multipliers.flatMap((multiplier) => activeVenues.map((venue) => ({
    venueId: venue.id,
    multiplier,
    band: formatMultiplier(multiplier),
    label: `${String(venueName?.(venue.id) || venue.name)}${formatMultiplier(multiplier)}`,
  })));
  const columnByKey = new Map(columns.map((column, index) => [`${column.venueId}:${column.multiplier}`, index]));
  const coaches = new Map();
  const unknown = [];
  let attendedCount = 0;

  for (const row of sessions || []) {
    const venueId = String(row.venue_id ?? '').trim();
    if (!venueId) throw new Error('SESSION_EXPORT_VENUE_MISSING');
    const coach = String(row.coach || '未指定教練');
    if (!coaches.has(coach)) coaches.set(coach, { cells: Array(columns.length).fill(0), total: 0 });
    const values = coaches.get(coach);
    const multiplier = normalizeMultiplier(row.coach_pricing_multiplier);
    const activeVenue = venueById.get(venueId);
    let reason = '';
    if (!activeVenue) reason = 'VENUE_NOT_ACTIVE_IN_EXPORT_OPTIONS';
    else if (multiplier === null) reason = 'COEFFICIENT_MISSING';
    else if (!multipliers.includes(multiplier)) reason = 'COEFFICIENT_NOT_CONFIGURED';

    if (reason) {
      unknown.push({
        sessionId: String(row.id ?? ''),
        venueId,
        coach,
        multiplier: multiplier === null ? null : multiplier,
        reason: row.coefficient_classification_reason || reason,
      });
    }
    if (!hasSessionCheckin(row)) continue;
    attendedCount += 1;
    values.total += 1;
    if (reason) {
      continue;
    }
    const index = columnByKey.get(`${venueId}:${multiplier}`);
    values.cells[index] += 1;
  }

  if (unknown.length) throw classificationError(unknown);
  const orderedCoaches = [...coaches].filter(([, values]) => values.total > 0)
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hant'));
  // Only categories with attended classes grow a visible column. All configured
  // categories still take part in validation before zero columns are removed.
  const visibleIndices = columns.flatMap((_, index) => orderedCoaches.some(([, values]) => values.cells[index] > 0) ? [index] : []);
  const visibleColumns = visibleIndices.map((index) => columns[index]);
  const headers = ['列標籤', ...visibleColumns.map((column) => column.label), '總計'];
  const rows = orderedCoaches.map(([coach, values]) => [coach, ...visibleIndices.map((index) => values.cells[index]), values.total]);
  const totals = ['總計', ...visibleIndices.map((index) => orderedCoaches.reduce((sum, [, values]) => sum + values.cells[index], 0)),
    orderedCoaches.reduce((sum, [, values]) => sum + values.total, 0)];
  if (totals.at(-1) !== attendedCount
      || visibleColumns.reduce((sum, _, index) => sum + totals[index + 1], 0) !== attendedCount) {
    throw new Error('SESSION_EXPORT_TOTAL_RECONCILIATION_FAILED');
  }
  const counts = { detailCount: (sessions || []).length, attendedCount, notAttendedCount: (sessions || []).length - attendedCount };
  return { headers, rows, totals, columns: visibleColumns, activeVenues, coefficientCategories: multipliers, unknown, unknownCount: unknown.length, attendedCount, counts };
}

export function sessionPivotCategory(row, venueName, venueOptions, coefficientCategories) {
  const venueId = String(row?.venue_id ?? '').trim();
  const activeVenue = (venueOptions || []).find((venue) => String(venue?.id ?? '') === venueId && venue?.is_active === true);
  const multiplier = normalizeMultiplier(row?.coach_pricing_multiplier);
  if (!activeVenue || multiplier === null || !configuredMultiplierList(coefficientCategories).includes(multiplier)) {
    throw classificationError([{ sessionId: String(row?.id ?? ''), venueId, reason: row?.coefficient_classification_reason || 'COEFFICIENT_OR_VENUE_UNRESOLVED' }]);
  }
  const name = String(venueName?.(venueId) || venueLabel(activeVenue) || venueId);
  return `${name}${formatMultiplier(multiplier)}`;
}
