'use strict';

const { normalizeTierPrices, resolveUnitPrice } = require('./coursePricing');

const SUPPORTED_MULTIPLIERS = Object.freeze([1, 1.2, 1.5]);
const MONEY_TOLERANCE = 0.01;
const SNAPSHOT_FIELDS = Object.freeze([
  'purchased_pricing_multiplier',
  'purchased_coefficient',
  'purchasedCoefficient',
]);

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function finiteNumber(value) {
  if (!hasValue(value) || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSnapshot(value) {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  return number;
}

function snapshotEvidence(snapshot, orderSnapshot) {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    for (const field of SNAPSHOT_FIELDS) {
      if (hasValue(snapshot[field])) return { present: true, value: snapshot[field], source: 'snapshot' };
    }
  } else if (hasValue(snapshot)) {
    return { present: true, value: snapshot, source: 'snapshot' };
  }

  if (orderSnapshot && typeof orderSnapshot === 'object' && !Array.isArray(orderSnapshot)) {
    for (const field of SNAPSHOT_FIELDS) {
      if (hasValue(orderSnapshot[field])) {
        return { present: true, value: orderSnapshot[field], source: 'order_snapshot' };
      }
    }
  }
  return { present: false };
}

function isTrialOrder(orderKind) {
  const normalized = String(orderKind || '').trim().toLowerCase();
  return normalized === 'trial' || normalized === 'experience' || normalized === '體驗';
}

function coefficientCategories(input) {
  if (!hasValue(input.coefficientCategories)) return { values: [...SUPPORTED_MULTIPLIERS] };
  if (!Array.isArray(input.coefficientCategories) || input.coefficientCategories.length === 0) {
    return { error: 'invalid_coefficient_categories' };
  }
  const values = [];
  for (const entry of input.coefficientCategories) {
    const raw = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry.multiplier
      : entry;
    const multiplier = finiteNumber(raw);
    if (multiplier === null || multiplier <= 0) return { error: 'invalid_coefficient_categories' };
    if (!values.some((value) => Math.abs(value - multiplier) < 1e-9)) values.push(multiplier);
  }
  return { values };
}

function priceCandidates(input) {
  const categories = coefficientCategories(input);
  if (categories.error) return categories;
  if (isTrialOrder(input.orderKind)) {
    const trialPrice = finiteNumber(input.trialPrice);
    if (trialPrice === null || trialPrice < 0) {
      return { error: hasValue(input.trialPrice) ? 'invalid_trial_price' : 'missing_trial_price' };
    }
    return {
      values: categories.values.map((multiplier) => ({
        multiplier,
        price: Math.round(trialPrice * multiplier),
      })),
    };
  }

  const basePrice = finiteNumber(input.basePrice);
  if (basePrice === null || basePrice < 0) {
    return { error: hasValue(input.basePrice) ? 'invalid_base_price' : 'missing_base_price' };
  }
  const tierPrices = normalizeTierPrices(input.tierPrices);
  return {
    values: categories.values.map((multiplier) => ({
      multiplier,
      price: resolveUnitPrice(basePrice, multiplier, tierPrices),
    })),
  };
}

function parseCount(value, name) {
  if (!hasValue(value)) return { value: null };
  const number = finiteNumber(value);
  if (number === null || number <= 0 || !Number.isInteger(number)) {
    return { error: `invalid_${name}` };
  }
  return { value: number };
}

function matchPrice(observations, candidates) {
  const matches = [];
  for (const observation of observations) {
    for (const candidate of candidates) {
      if (Math.abs(observation.price - candidate.price) <= MONEY_TOLERANCE) {
        matches.push({ multiplier: candidate.multiplier, source: observation.source });
      }
    }
  }
  const multipliers = [...new Set(matches.map((match) => match.multiplier))];
  if (multipliers.length > 1) return { error: 'ambiguous_price_match' };
  if (multipliers.length === 0) return { error: 'no_price_match' };
  const selected = matches.find((match) => match.multiplier === multipliers[0]);
  return { multiplier: multipliers[0], source: selected.source };
}

function totalPriceObservations(price, field, studentCount, periodCount) {
  const divisors = [{ divisor: 1, source: field }];
  if (periodCount !== null && periodCount !== 1) {
    divisors.push({ divisor: periodCount, source: `${field}_per_period` });
  }
  if (studentCount !== null && studentCount !== 1) {
    divisors.push({ divisor: studentCount, source: `${field}_per_student` });
  }
  if (studentCount !== null && periodCount !== null && studentCount * periodCount !== 1) {
    divisors.push({
      divisor: studentCount * periodCount,
      source: `${field}_per_student_period`,
    });
  }

  const seen = new Set();
  return divisors.filter(({ divisor }) => {
    if (seen.has(divisor)) return false;
    seen.add(divisor);
    return true;
  }).map(({ divisor, source }) => ({ price: price / divisor, source }));
}

function hasPositiveDiscount(input) {
  return [input.discountAmount, input.discountRate].some((value) => {
    const number = finiteNumber(value);
    return number !== null && number > 0;
  });
}

function resultFromEvidence(input, field, sourceName, candidates) {
  const raw = input[field];
  const price = finiteNumber(raw);
  if (price === null || price < 0) return { multiplier: null, source: null, reason: `invalid_${sourceName}` };

  if (field === 'unitPrice') {
    const matched = matchPrice([{ price, source: sourceName }], candidates);
    return matched.error
      ? { multiplier: null, source: null, reason: matched.error }
      : { multiplier: matched.multiplier, source: matched.source, reason: 'unique_price_match' };
  }

  const students = parseCount(input.studentCount, 'student_count');
  if (students.error) return { multiplier: null, source: null, reason: students.error };
  const periods = parseCount(input.periodCount, 'period_count');
  if (periods.error) return { multiplier: null, source: null, reason: periods.error };
  const matched = matchPrice(
    totalPriceObservations(price, sourceName, students.value, periods.value),
    candidates,
  );
  return matched.error
    ? { multiplier: null, source: null, reason: matched.error }
    : { multiplier: matched.multiplier, source: matched.source, reason: 'unique_price_match' };
}

/**
 * Resolve the purchase-time pricing multiplier for one historical order.
 *
 * This function is deliberately pure and fail-closed.  Callers must supply
 * pricing data already joined to the order's own course type and venue zone.
 */
function resolvePurchasedCoefficient(input = {}) {
  const snapshot = snapshotEvidence(input.snapshot, input.orderSnapshot);
  if (snapshot.present) {
    const multiplier = normalizeSnapshot(snapshot.value);
    if (multiplier === null) return { multiplier: null, source: snapshot.source, reason: 'invalid_snapshot' };
    return { multiplier, source: snapshot.source, reason: 'explicit_snapshot' };
  }

  const candidates = priceCandidates(input);
  if (candidates.error) return { multiplier: null, source: null, reason: candidates.error };

  if (hasValue(input.unitPrice)) {
    return resultFromEvidence(input, 'unitPrice', 'unit_price', candidates.values);
  }
  if (hasValue(input.originalPrice)) {
    return resultFromEvidence(input, 'originalPrice', 'original_price', candidates.values);
  }
  if (hasValue(input.finalPrice)) {
    if (hasPositiveDiscount(input)) {
      return { multiplier: null, source: null, reason: 'discounted_price_without_original' };
    }
    return resultFromEvidence(input, 'finalPrice', 'final_price', candidates.values);
  }
  return { multiplier: null, source: null, reason: 'missing_price_evidence' };
}

module.exports = {
  MONEY_TOLERANCE,
  SUPPORTED_MULTIPLIERS,
  resolvePurchasedCoefficient,
};
