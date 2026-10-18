'use strict';

const { resolvePurchasedCoefficient } = require('./sessionPurchasedCoefficient');

const DEFAULT_CATEGORIES = Object.freeze([1, 1.2, 1.5]);
const PRICE_FIELDS = Object.freeze([
  ['base_price', 'basePrice'],
  ['tier_prices', 'tierPrices'],
  ['trial_price', 'trialPrice'],
]);

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function finiteNumber(value) {
  if (!hasValue(value) || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 && Number.isInteger(number) ? number : null;
}

function cloneValue(value) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function unwrapHistory(history) {
  if (Array.isArray(history)) {
    if (history.length === 1 && history[0]?.audit?.price_history) return history[0].audit.price_history;
    return history;
  }
  if (history?.audit?.price_history) return history.audit.price_history;
  if (Array.isArray(history?.price_history)) return history.price_history;
  return [];
}

function sameCourseType(left, right) {
  return hasValue(left) && hasValue(right) && String(left) === String(right);
}

function applicableZone(changeZone, contextZone) {
  if (changeZone === null || changeZone === undefined) return true;
  return hasValue(contextZone) && String(changeZone) === String(contextZone);
}

function addCategory(categories, raw) {
  const multiplier = finiteNumber(raw);
  if (multiplier === null || multiplier <= 0) return;
  if (!categories.some((value) => Math.abs(value - multiplier) < 1e-9)) categories.push(multiplier);
}

function purchaseTimestamp(context) {
  return context.order_submitted_at || context.order_created_at || context.period_created_at || null;
}

/**
 * Reconstruct the course pricing configuration as it existed when the order
 * was created.  Current configuration is rolled backwards through audit
 * entries after the purchase time, newest change first.
 */
function reconstructPurchasePricing(context = {}, history = []) {
  const purchaseAt = purchaseTimestamp(context);
  const purchaseTime = purchaseAt ? new Date(purchaseAt).getTime() : NaN;
  const config = {
    purchaseAt,
    basePrice: cloneValue(context.base_price),
    tierPrices: cloneValue(context.tier_prices),
    trialPrice: cloneValue(context.trial_price),
  };

  if (!Number.isFinite(purchaseTime)) {
    return { ...config, coefficientCategories: [...DEFAULT_CATEGORIES], reason: 'invalid_purchase_time' };
  }

  const changes = unwrapHistory(history)
    .filter((change) => sameCourseType(change?.course_type, context.course_type))
    .filter((change) => applicableZone(change?.pricing_zone_id, context.pricing_zone_id))
    .map((change) => ({ change, time: new Date(change.at).getTime() }))
    .filter(({ time }) => Number.isFinite(time) && time > purchaseTime)
    .sort((left, right) => right.time - left.time);

  for (const { change } of changes) {
    for (const [auditField, configField] of PRICE_FIELDS) {
      const delta = change[auditField];
      if (!delta || typeof delta !== 'object' || !Object.prototype.hasOwnProperty.call(delta, 'before')) continue;
      config[configField] = cloneValue(delta.before);
    }
  }

  const categories = [...DEFAULT_CATEGORIES];
  if (config.tierPrices && typeof config.tierPrices === 'object' && !Array.isArray(config.tierPrices)) {
    for (const key of Object.keys(config.tierPrices)) addCategory(categories, key);
  }
  for (const field of ['period_snapshot', 'order_snapshot', 'group_snapshot']) {
    addCategory(categories, context[field]);
  }
  return { ...config, coefficientCategories: categories, reason: null };
}

function explicitSnapshot(context) {
  for (const [field, source] of [
    ['period_snapshot', 'period_snapshot'],
    ['order_snapshot', 'order_snapshot'],
    ['group_snapshot', 'group_snapshot'],
  ]) {
    if (hasValue(context[field])) return { value: context[field], source };
  }
  return null;
}

function verifiedResult(correction) {
  if (correction === null || correction === undefined) return null;
  const multiplier = finiteNumber(correction?.multiplier);
  if (multiplier === null || multiplier <= 0
      || correction?.source !== 'user_confirmed'
      || typeof correction?.reason !== 'string'
      || correction.reason.trim() === '') {
    return { multiplier: null, source: null, reason: 'invalid_verified_correction' };
  }
  return { multiplier, source: 'user_confirmed', reason: correction.reason };
}

function normalizedOriginalEvidence(context) {
  const useOrder = hasValue(context.order_original);
  const rawOriginal = useOrder ? context.order_original : context.period_original;
  if (!hasValue(rawOriginal)) return { error: 'missing_original_price' };
  const original = finiteNumber(rawOriginal);
  if (original === null || original < 0) return { error: 'invalid_original_price' };

  const sourcePrefix = useOrder ? 'order' : 'period';
  const studentCount = positiveInteger(context[`${sourcePrefix}_students`]);
  if (studentCount === null) return { error: `missing_${sourcePrefix}_students` };

  const isTrial = context.is_experience_course === true
    || ['trial', 'experience', '體驗'].includes(String(context.order_kind || '').trim().toLowerCase());
  if (isTrial) {
    return { originalPrice: original, studentCount, isTrial, sourcePrefix };
  }

  const sessionsField = `${sourcePrefix}_sessions`;
  const sessions = positiveInteger(context[sessionsField]);
  if (sessions === null) return { error: `missing_${sessionsField}` };
  const sessionsPerPeriod = positiveInteger(context.sessions_per_period);
  if (sessionsPerPeriod === null) return { error: 'missing_sessions_per_period' };
  const periodUnits = sessions / sessionsPerPeriod;
  if (!Number.isFinite(periodUnits) || periodUnits <= 0) return { error: 'invalid_order_period_units' };

  return {
    originalPrice: original / periodUnits,
    studentCount,
    isTrial,
    sourcePrefix,
  };
}

function classifyOriginal(evidence, pricing) {
  return resolvePurchasedCoefficient({
    basePrice: pricing.basePrice,
    tierPrices: pricing.tierPrices,
    trialPrice: pricing.trialPrice,
    coefficientCategories: pricing.coefficientCategories,
    originalPrice: evidence.originalPrice,
    studentCount: evidence.studentCount,
    orderKind: evidence.isTrial ? 'trial' : 'standard',
  });
}

function classifyBatch(context, pricing) {
  if (!hasValue(context.batch_original_total)) return null;
  const total = finiteNumber(context.batch_original_total);
  if (total === null || total < 0) return { multiplier: null, source: null, reason: 'invalid_batch_original_total' };
  const orderCount = positiveInteger(context.batch_order_count);
  if (orderCount === null) return { multiplier: null, source: null, reason: 'missing_batch_order_count' };
  const students = positiveInteger(context.order_students);
  if (students === null) return { multiplier: null, source: null, reason: 'missing_order_students' };

  const result = resolvePurchasedCoefficient({
    basePrice: pricing.basePrice,
    tierPrices: pricing.tierPrices,
    trialPrice: pricing.trialPrice,
    coefficientCategories: pricing.coefficientCategories,
    originalPrice: total,
    studentCount: students,
    periodCount: orderCount,
    orderKind: 'standard',
  });
  return result.multiplier === null
    ? result
    : { multiplier: result.multiplier, source: 'order_batch_original_price', reason: result.reason };
}

/**
 * Resolve a session's purchase-time coefficient from already-read context.
 * No current coach multiplier or raw discounted per-lesson unit price is used.
 */
function resolveSessionCoefficientContext(context = {}, history = [], verifiedCorrection = null) {
  const snapshot = explicitSnapshot(context);
  if (snapshot) {
    const result = resolvePurchasedCoefficient({ snapshot: snapshot.value });
    return { multiplier: result.multiplier, source: snapshot.source, reason: result.reason };
  }

  const correction = verifiedResult(verifiedCorrection);
  if (correction) return correction;

  const pricing = reconstructPurchasePricing(context, history);
  if (pricing.reason) return { multiplier: null, source: null, reason: pricing.reason };

  const evidence = normalizedOriginalEvidence(context);
  if (evidence.error) return { multiplier: null, source: null, reason: evidence.error };
  const result = classifyOriginal(evidence, pricing);
  if (result.multiplier !== null) {
    return {
      multiplier: result.multiplier,
      source: `${evidence.sourcePrefix}_original_price`,
      reason: result.reason,
    };
  }

  if (!evidence.isTrial && result.reason === 'no_price_match') {
    const batch = classifyBatch(context, pricing);
    if (batch) return batch;
  }
  return result;
}

module.exports = {
  reconstructPurchasePricing,
  resolveSessionCoefficientContext,
};
