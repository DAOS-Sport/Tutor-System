#!/usr/bin/env node
'use strict';

/**
 * Phone-scoped shared entitlement repair. Dry-run is the default.
 *
 * Current DAOS model intentionally represents a multi-period purchase as one shared
 * course_period per purchased period. It never multiplies lessons by participant,
 * registration, checkout, invoice, or payment row counts.
 *
 * Apply is deliberately narrow: duplicate periods with any historical session,
 * attendance, or manual deduction are MANUAL_REVIEW and are never guessed/moved.
 */
const crypto = require('crypto');
const { Client } = require('../server/node_modules/pg');
const { sanitizedDatabaseIdentity, isDevelopmentDatabase } = require('./preflight_release_20260712');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  }
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

async function snapshot(client, phone) {
  const registrations = await client.query(
    `SELECT ae.id, ae.enrollment_batch_id, ae.group_order_id, COALESCE(ae.period_number, 1) AS period_number,
            ae.period_count, ae.total_sessions, ae.course_type, ae.venue_id, ae.coach_id,
            ae.parent_name, ae.parent_phone, ae.students, ae.checkout_id,
            ae.original_price, ae.final_price, ae.status AS payment_status, ae.invoice_number
       FROM admin_enrollments ae
      WHERE regexp_replace(COALESCE(ae.parent_phone, ''), '[^0-9]', '', 'g') = $1
      ORDER BY ae.enrollment_batch_id NULLS LAST, ae.period_number, ae.id`,
    [phone]
  );
  const registrationIds = registrations.rows.map((row) => row.id);
  const batchIds = [...new Set(registrations.rows.map((row) => row.enrollment_batch_id).filter(Boolean))];
  const groupIds = [...new Set(registrations.rows.map((row) => row.group_order_id).filter(Boolean))];
  const periods = registrationIds.length ? await client.query(
    `SELECT DISTINCT cp.id, cp.admin_enrollment_id, cp.enrollment_batch_id, cp.group_order_id,
            COALESCE(cp.period_number, 1) AS period_number, cp.course_type, cp.venue_id, cp.coach_id,
            cp.total_sessions, cp.used_sessions, cp.status::text AS status,
            COALESCE(cp.entitlement_state, 'ACTIVE') AS entitlement_state,
            cp.superseded_by_course_period_id, cp.created_at
       FROM course_periods cp
      WHERE cp.admin_enrollment_id = ANY($1::text[])
         OR cp.enrollment_batch_id = ANY($2::uuid[])
         OR cp.group_order_id = ANY($3::uuid[])
      ORDER BY cp.period_number, cp.created_at, cp.id`,
    [registrationIds, batchIds, groupIds]
  ) : { rows: [] };
  const periodIds = periods.rows.map((row) => row.id);
  const participants = periodIds.length ? await client.query(
    `SELECT cpe.course_period_id, cpe.student_id, s.name, cpe.status
       FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id
      WHERE cpe.course_period_id = ANY($1::uuid[])
      ORDER BY cpe.course_period_id, s.name, cpe.student_id`, [periodIds]
  ) : { rows: [] };
  const usages = periodIds.length ? await client.query(
    `SELECT cs.id, cs.course_period_id, cs.status::text AS status, cs.scheduled_at,
            COUNT(cr.id)::int AS attendance_count,
            COUNT(*) FILTER (WHERE COALESCE(cr.attendance_status, 'ATTENDED') = 'ATTENDED')::int AS active_attendance_count
       FROM course_sessions cs LEFT JOIN checkin_records cr ON cr.course_session_id = cs.id
      WHERE cs.course_period_id = ANY($1::uuid[])
      GROUP BY cs.id ORDER BY cs.scheduled_at, cs.id`, [periodIds]
  ) : { rows: [] };
  const deductions = periodIds.length ? await client.query(
    `SELECT id, course_period_id, course_session_id, request_id, status, created_at
       FROM manual_lesson_deductions WHERE course_period_id = ANY($1::uuid[])
      ORDER BY created_at, id`, [periodIds]
  ) : { rows: [] };
  const financial = registrations.rows.map((row) => ({
    id: row.id, checkout_id: row.checkout_id, original_price: row.original_price,
    final_price: row.final_price, payment_status: row.payment_status, invoice_number: row.invoice_number,
  }));
  const rights = { periods: periods.rows, participants: participants.rows, usages: usages.rows, deductions: deductions.rows };
  return {
    phone,
    registrations: registrations.rows,
    source_purchase_ids: { enrollment_batch_ids: batchIds, group_order_ids: groupIds },
    periods: periods.rows,
    participants: participants.rows,
    usages: usages.rows,
    deductions: deductions.rows,
    rights_hash: hash(rights),
    financial_hash: hash(financial),
  };
}

function plan(snapshot) {
  const activePeriods = snapshot.periods.filter((row) => row.entitlement_state === 'ACTIVE');
  const groups = new Map();
  for (const period of activePeriods) {
    const registration = snapshot.registrations.find((row) => row.id === period.admin_enrollment_id);
    const sourceId = period.group_order_id || period.enrollment_batch_id
      || registration?.group_order_id || registration?.enrollment_batch_id;
    if (!sourceId) continue;
    const key = `${sourceId}:${period.period_number}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(period);
  }
  return [...groups.entries()].filter(([, periods]) => periods.length > 1).map(([source_key, periods]) => {
    const sorted = [...periods].sort((a, b) => {
      if (!!a.enrollment_batch_id !== !!b.enrollment_batch_id) return a.enrollment_batch_id ? -1 : 1;
      return String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));
    });
    const canonical = sorted[0];
    const duplicates = sorted.slice(1);
    const duplicateIds = new Set(duplicates.map((row) => row.id));
    const historical = snapshot.usages.filter((row) => duplicateIds.has(row.course_period_id));
    const deductions = snapshot.deductions.filter((row) => duplicateIds.has(row.course_period_id));
    const inconsistent = periods.some((row) => row.course_type !== canonical.course_type
      || row.venue_id !== canonical.venue_id || row.coach_id !== canonical.coach_id
      || Number(row.total_sessions) !== Number(canonical.total_sessions));
    const manualReview = inconsistent || historical.length > 0 || deductions.length > 0;
    return {
      source_key,
      period_number: Number(canonical.period_number),
      canonical_entitlement_id: canonical.id,
      superseded_entitlement_ids: duplicates.map((row) => row.id),
      lessons_per_period: Number(canonical.total_sessions),
      participant_ids: [...new Set(snapshot.participants
        .filter((row) => periods.some((period) => period.id === row.course_period_id))
        .map((row) => row.student_id))],
      status: manualReview ? 'MANUAL_REVIEW' : 'READY',
      reason: inconsistent ? 'period metadata differs' : historical.length || deductions.length
        ? 'duplicate entitlement contains historical usage/attendance/deduction' : null,
    };
  });
}

async function applyPlan(client, snapshot, repairPlan, actor) {
  for (const item of repairPlan) {
    if (item.status !== 'READY') continue;
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [item.source_key]);
    await client.query(
      `INSERT INTO course_period_enrollments (course_period_id, student_id, status)
       SELECT $1, unnest($2::uuid[]), 'active'
       ON CONFLICT (course_period_id, student_id) DO UPDATE SET status = 'active'`,
      [item.canonical_entitlement_id, item.participant_ids]
    );
    await client.query(
      `UPDATE course_periods
          SET entitlement_state = 'SUPERSEDED', status = 'completed',
              superseded_by_course_period_id = $2, superseded_at = NOW(),
              superseded_by = $3, superseded_reason = 'duplicate financial registration entitlement',
              updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND entitlement_state = 'ACTIVE'`,
      [item.superseded_entitlement_ids, item.canonical_entitlement_id, actor]
    );
  }
}

async function main() {
  const phone = String(arg('--phone') || '').replace(/\D/g, '');
  const apply = process.argv.includes('--apply');
  const expectedHash = arg('--confirm-rights-hash');
  const productionConfirmed = process.argv.includes('--production-confirmed');
  const connectionString = process.env.DATABASE_URL;
  const database = sanitizedDatabaseIdentity(connectionString || '');
  const base = { script: 'repair_shared_entitlements', mode: apply ? 'apply' : 'dry-run', database, phone };
  if (!phone || !connectionString) {
    console.log(JSON.stringify({ ...base, status: 'BLOCKED', reason: !phone ? '--phone is required' : 'DATABASE_URL is missing' }, null, 2));
    process.exitCode = 2; return;
  }
  if (apply && (!expectedHash || (!isDevelopmentDatabase(database) && !productionConfirmed))) {
    console.log(JSON.stringify({ ...base, status: 'BLOCKED', reason: 'apply requires --confirm-rights-hash and production requires --production-confirmed' }, null, 2));
    process.exitCode = 2; return;
  }
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query('BEGIN');
    const before = await snapshot(client, phone);
    const repairPlan = plan(before);
    if (apply && before.rights_hash !== expectedHash) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ ...base, status: 'BLOCKED', reason: 'rights hash changed since dry-run', before, repair_plan: repairPlan }, null, 2));
      process.exitCode = 2; return;
    }
    if (apply) await applyPlan(client, before, repairPlan, process.env.REPAIR_ACTOR || 'repair_shared_entitlements');
    const after = await snapshot(client, phone);
    if (before.financial_hash !== after.financial_hash) throw new Error('financial invariant changed; rolling back');
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({
      ...base,
      status: before.registrations.length ? 'DONE' : 'TARGET_REGISTRATIONS_NOT_FOUND',
      expected_total_lessons: [...new Set(before.registrations.map((row) => row.period_number))].length
        * (Number(before.registrations[0]?.total_sessions) || 0),
      before,
      repair_plan: repairPlan,
      after: apply ? after : null,
      changed: apply && before.rights_hash !== after.rights_hash,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.log(JSON.stringify({ ...base, status: 'BLOCKED', reason: error.message }, null, 2));
    process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
