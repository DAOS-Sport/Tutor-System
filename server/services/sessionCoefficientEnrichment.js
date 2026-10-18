'use strict';

const corrections = require('../data/sessionCoefficientCorrections.json');
const { resolveSessionCoefficientContext } = require('./sessionCoefficientContext');

// Read only the purchase evidence for periods already selected by the scoped
// sessions query. No order or historical price is changed by this adapter.
const CONTEXT_SQL = `
  SELECT cp.id::text AS period_id, md5(cp.id::text) AS period_key,
         cp.venue_id, cp.course_type, cp.original_price AS period_original,
         cp.final_price AS period_final, cp.total_sessions AS period_sessions,
         cp.created_at AS period_created_at, cp.is_experience_course,
         cp.purchased_pricing_multiplier AS period_snapshot,
         ae.original_price AS order_original, ae.final_price AS order_final,
         ae.total_sessions AS order_sessions, ae.period_count, ae.order_kind,
         ae.submitted_at AS order_submitted_at, ae.created_at AS order_created_at,
         ae.purchased_pricing_multiplier AS order_snapshot,
         GREATEST(COALESCE(cardinality(ae.student_ids), 0), COALESCE(cardinality(ae.students), 0)) AS order_students,
         (SELECT count(*) FROM course_period_enrollments ce WHERE ce.course_period_id = cp.id) AS period_students,
         v.pricing_zone_id, z.sessions_per_period, cfg.base_price, cfg.tier_prices,
         cfg.trial_price, cfg.max_students,
         go.purchased_pricing_multiplier AS group_snapshot,
         go.purchased_unit_price AS group_unit_price,
         batch.original_total AS batch_original_total, batch.order_count AS batch_order_count
    FROM course_periods cp
    LEFT JOIN admin_enrollments ae ON ae.id = cp.admin_enrollment_id
    LEFT JOIN group_orders go ON go.id = COALESCE(cp.group_order_id, ae.group_order_id)
    LEFT JOIN venues v ON v.id = cp.venue_id
    LEFT JOIN pricing_zones z ON z.id = v.pricing_zone_id
    LEFT JOIN course_type_configs cfg ON cfg.pricing_zone_id = v.pricing_zone_id AND cfg.course_type = cp.course_type
    LEFT JOIN LATERAL (
      SELECT sum(b.original_price) AS original_total, count(*) AS order_count
        FROM admin_enrollments b
       WHERE ae.enrollment_batch_id IS NOT NULL AND b.enrollment_batch_id = ae.enrollment_batch_id
         AND b.course_type = ae.course_type AND b.venue_id = ae.venue_id
         AND b.coach_id IS NOT DISTINCT FROM ae.coach_id
         AND b.students IS NOT DISTINCT FROM ae.students
    ) batch ON TRUE
   WHERE cp.id = ANY($1::uuid[])`;

const HISTORY_SQL = `
  SELECT course_type, pricing_zone_id, at,
         changes->'base_price' AS base_price,
         changes->'tier_prices' AS tier_prices,
         changes->'trial_price' AS trial_price
    FROM course_type_config_audit_logs
   WHERE course_type = ANY($1::int[])
     AND (pricing_zone_id IS NULL OR pricing_zone_id = ANY($2::int[]))
     AND changes ?| ARRAY['base_price', 'tier_prices', 'trial_price']
   ORDER BY at DESC`;

function verifiedCorrection(context) {
  return corrections.corrections.find(entry => entry.period_key === context.period_key
    && String(entry.expected.venue_id) === String(context.venue_id)
    && Number(entry.expected.course_type) === Number(context.course_type)
    && Number(entry.expected.order_original) === Number(context.order_original)) || null;
}

async function enrichSessionCoefficients(rows, db) {
  const ids = [...new Set(rows.filter(row => row.manual_lesson_pricing_multiplier == null)
    .map(row => row.coefficient_period_id).filter(Boolean))];
  const { rows: contexts } = ids.length ? await db.query(CONTEXT_SQL, [ids]) : { rows: [] };
  const types = [...new Set(contexts.map(row => Number(row.course_type)))];
  const zones = [...new Set(contexts.map(row => Number(row.pricing_zone_id)).filter(value => Number.isFinite(value) && value > 0))];
  const { rows: history } = ids.length ? await db.query(HISTORY_SQL, [types, zones]) : { rows: [] };
  const resolved = new Map(contexts.map(context => [String(context.period_id),
    resolveSessionCoefficientContext(context, history, verifiedCorrection(context))]));
  return rows.map(row => {
    if (row.manual_lesson_pricing_multiplier != null) {
      const multiplier = Number(row.manual_lesson_pricing_multiplier);
      const valid = Number.isFinite(multiplier) && multiplier >= 1 && multiplier <= 1.5;
      return { ...row, coach_pricing_multiplier: valid ? multiplier : null,
        coefficient_classification_source: 'manual_lesson_snapshot',
        coefficient_classification_reason: valid ? 'explicit_lesson_snapshot' : 'invalid_lesson_snapshot' };
    }
    if (!row.coefficient_period_id) return row;
    const result = resolved.get(String(row.coefficient_period_id));
    return { ...row, coach_pricing_multiplier: result?.multiplier ?? null,
      coefficient_classification_source: result?.source || null,
      coefficient_classification_reason: result?.reason || 'missing_purchase_context' };
  });
}

module.exports = { CONTEXT_SQL, HISTORY_SQL, verifiedCorrection, enrichSessionCoefficients };
