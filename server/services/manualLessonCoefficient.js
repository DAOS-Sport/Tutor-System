'use strict';

const { resolveSessionCoefficientContext } = require('./sessionCoefficientContext');
const { CONTEXT_SQL, HISTORY_SQL, verifiedCorrection } = require('./sessionCoefficientEnrichment');

const STANDARD_MULTIPLIERS = Object.freeze([1, 1.2, 1.5]);

// Match F-A02's editable range and NUMERIC(5,2), without silently rounding.
function normalizeManualMultiplier(value) {
  if (!['number', 'string'].includes(typeof value)
      || !/^\d+(?:\.\d{1,2})?$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 && number <= 1.5 ? number : null;
}

function isAllowedManualMultiplier(value, original) {
  return STANDARD_MULTIPLIERS.includes(value) || value === original;
}

// The purchase evidence is the same source used by FR01, never today's coach rate.
// Conflicting explicit snapshots cannot be resolved by silently choosing one.
function resolveManualPurchasedCoefficient(context = {}, history = [], correction = null) {
  const snapshots = ['period_snapshot', 'order_snapshot', 'group_snapshot']
    .map(field => context[field]).filter(value => value !== null && value !== undefined && value !== '');
  const normalized = snapshots.map(normalizeManualMultiplier);
  if (normalized.some(value => value === null)) {
    return { multiplier: null, source: null, reason: 'invalid_purchase_snapshot' };
  }
  if (new Set(normalized).size > 1) {
    return { multiplier: null, source: null, reason: 'conflicting_purchase_snapshots' };
  }
  const resolved = resolveSessionCoefficientContext(context, history, correction);
  const multiplier = normalizeManualMultiplier(resolved.multiplier);
  return multiplier === null
    ? { multiplier: null, source: null, reason: resolved.reason || 'invalid_purchased_multiplier' }
    : { ...resolved, multiplier };
}

async function resolveManualPurchaseCoefficients(db, periodIds) {
  const ids = [...new Set(periodIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const { rows: contexts } = await db.query(CONTEXT_SQL, [ids]);
  const needsHistory = contexts.some(context => ['period_snapshot', 'order_snapshot', 'group_snapshot']
    .every(field => context[field] === null || context[field] === undefined || context[field] === ''));
  let history = [];
  if (needsHistory) {
    const types = [...new Set(contexts.map(row => Number(row.course_type)))];
    const zones = [...new Set(contexts.map(row => Number(row.pricing_zone_id))
      .filter(value => Number.isFinite(value) && value > 0))];
    ({ rows: history } = await db.query(HISTORY_SQL, [types, zones]));
  }
  return new Map(contexts.map(context => [String(context.period_id),
    resolveManualPurchasedCoefficient(context, history, verifiedCorrection(context))]));
}

module.exports = { normalizeManualMultiplier, isAllowedManualMultiplier,
  resolveManualPurchasedCoefficient, resolveManualPurchaseCoefficients };
