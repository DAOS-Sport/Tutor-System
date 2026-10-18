'use strict';

// Owner policy 2026-10-07: a purchase (all parents and phases), never a customer,
// is the unit of the parent daily limit. Staff extra lessons remain independent.
function conflict(code, message) {
  return Object.assign(new Error(message), { status: 409, code });
}

// Aliases are internal constants, not request input. A group spans its members'
// separate checkout batches; historical CP batch omissions use the source order.
function purchaseKeySql(cp, ae) {
  return `(CASE
    WHEN COALESCE(${cp}.group_order_id, ${ae}.group_order_id) IS NOT NULL
      THEN 'group:' || COALESCE(${cp}.group_order_id, ${ae}.group_order_id)::text
    WHEN COALESCE(${ae}.enrollment_batch_id, ${cp}.enrollment_batch_id) IS NOT NULL
      THEN 'batch:' || COALESCE(${ae}.enrollment_batch_id, ${cp}.enrollment_batch_id)::text
    WHEN ${ae}.id IS NOT NULL THEN 'order:' || ${ae}.id
    ELSE NULL END)`;
}

function todayAttendanceSql(session) {
  return `${session}.status::text NOT LIKE 'cancelled%'
    AND ${session}.scheduled_at >= (date_trunc('day', NOW() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei')
    AND ${session}.scheduled_at < ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Taipei') + INTERVAL '1 day') AT TIME ZONE 'Asia/Taipei')
    AND EXISTS (SELECT 1 FROM checkin_records day_cr
      WHERE day_cr.course_session_id = ${session}.id AND day_cr.attendance_status = 'ATTENDED')`;
}

function purchaseTodaySql(cp, ae) {
  return `EXISTS (SELECT 1 FROM course_sessions day_cs
    JOIN course_periods day_cp ON day_cp.id = day_cs.course_period_id
    LEFT JOIN admin_enrollments day_ae ON day_ae.id = day_cp.admin_enrollment_id
    WHERE ${purchaseKeySql('day_cp', 'day_ae')} = ${purchaseKeySql(cp, ae)}
      AND ${todayAttendanceSql('day_cs')})`;
}

async function purchaseContext(client, periodId, lockSource = false) {
  const row = (await client.query(
    `SELECT cp.id, cp.coach_id, cp.group_order_id, cp.enrollment_batch_id,
            ae.id AS source_id, ae.group_order_id AS source_group,
            ae.enrollment_batch_id AS source_batch, ae.period_number AS source_period_number,
            ${purchaseKeySql('cp', 'ae')} AS purchase_key
       FROM course_periods cp ${lockSource ? 'JOIN' : 'LEFT JOIN'} admin_enrollments ae ON ae.id = cp.admin_enrollment_id
      WHERE cp.id = $1 ${lockSource ? 'FOR SHARE OF ae' : ''}`, [periodId]
  )).rows[0];
  if (!row) return null;
  if (!row.source_id || !row.purchase_key) {
    throw conflict('ENROLLMENT_SOURCE_UNRESOLVED', '找不到本課程的購買訂單，請洽櫃檯核對後再簽到');
  }
  if ((row.group_order_id && row.source_group && row.group_order_id !== row.source_group)
      || (row.enrollment_batch_id && row.source_batch && row.enrollment_batch_id !== row.source_batch)) {
    throw conflict('PURCHASE_IDENTITY_REVIEW_REQUIRED', '課程與購買訂單關聯不一致，請洽櫃檯核對');
  }
  return row;
}

async function lockParentPurchase(client, periodId) {
  const hint = await purchaseContext(client, periodId);
  if (!hint) return null;
  // Match existing booking/manual lock order before acquiring the period row.
  if (hint.coach_id) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(hint.coach_id)]);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`parent-purchase-checkin:${hint.purchase_key}`]);
  return hint;
}

async function assertLockedPurchase(client, periodId, hint) {
  // Caller already holds CP FOR UPDATE. Hold the source order through COMMIT,
  // and refuse an identity/coach change observed while waiting for either lock.
  const fresh = await purchaseContext(client, periodId, true);
  if (!fresh || !hint || fresh.purchase_key !== hint.purchase_key || fresh.coach_id !== hint.coach_id) {
    throw conflict('PURCHASE_IDENTITY_REVIEW_REQUIRED', '購買訂單或授課教練剛有異動，請重新整理後再簽到');
  }
  return fresh;
}

function withPurchaseSource(period, source) {
  return source ? { ...period,
    group_order_id: source.source_group || period.group_order_id || null,
    enrollment_batch_id: source.source_batch || period.enrollment_batch_id || null,
    period_number: source.source_period_number || period.period_number || 1,
  } : period;
}

async function findPurchaseAttendance(client, purchaseKey) {
  return (await client.query(
    `SELECT day_cs.id, day_cs.course_period_id, day_cs.scheduled_at, day_cs.created_via
       FROM course_sessions day_cs
       JOIN course_periods day_cp ON day_cp.id = day_cs.course_period_id
       LEFT JOIN admin_enrollments day_ae ON day_ae.id = day_cp.admin_enrollment_id
      WHERE ${purchaseKeySql('day_cp', 'day_ae')} = $1 AND ${todayAttendanceSql('day_cs')}
      ORDER BY (day_cs.created_via = 'self_checkin') DESC, day_cs.scheduled_at, day_cs.id`, [purchaseKey]
  )).rows;
}

function dailyConflict() {
  return conflict('ALREADY_CHECKED_IN_TODAY', '本筆購買訂單今日已簽到（每日限一堂）；追加課堂請洽櫃檯補登');
}

module.exports = { purchaseKeySql, purchaseTodaySql, lockParentPurchase, assertLockedPurchase, withPurchaseSource, findPurchaseAttendance, dailyConflict };
