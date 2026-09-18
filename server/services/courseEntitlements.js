'use strict';

function conflict(code, message) {
  return Object.assign(new Error(message), { status: 409, code });
}

// The period row is the common lock for attendance, usage and refunds. Always
// acquire it before enrollment rows, matching syncStoredUsage's write order.
async function linkedEnrollments(client, period) {
  return (await client.query(
    `SELECT ae.*, checkout.parent_id AS source_parent_id,
            (SELECT array_agg(DISTINCT sid)
               FROM group_order_members gom CROSS JOIN LATERAL unnest(gom.student_ids) sid
              WHERE gom.group_order_id = ae.group_order_id AND gom.parent_id = checkout.parent_id) AS source_student_ids
       FROM admin_enrollments ae
       LEFT JOIN checkout_sessions checkout ON checkout.checkout_id = ae.checkout_id
      WHERE ($2::uuid IS NOT NULL AND ae.group_order_id = $2 AND COALESCE(ae.period_number,1) = $4)
         OR ($2::uuid IS NULL AND $3::uuid IS NOT NULL AND ae.enrollment_batch_id = $3
             AND ae.group_order_id IS NULL AND COALESCE(ae.period_number,1) = $4)
         OR ($2::uuid IS NULL AND $3::uuid IS NULL AND ae.id = $1)
      ORDER BY ae.id`,
    [period.admin_enrollment_id || '', period.group_order_id || null,
      period.enrollment_batch_id || null, period.period_number || 1]
  )).rows;
}

async function lockEnrollmentOperation(client, enrollmentId) {
  const hint = (await client.query('SELECT * FROM admin_enrollments WHERE id = $1', [enrollmentId])).rows[0];
  if (!hint) return null;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `enrollment-entitlement:${hint.group_order_id || hint.enrollment_batch_id || hint.id}`,
  ]);
  return hint;
}

async function lockRefundPeriods(client, enrollmentId) {
  const hint = await lockEnrollmentOperation(client, enrollmentId);
  if (!hint) return [];
  const periods = (await client.query(
    `SELECT cp.* FROM course_periods cp
      WHERE cp.admin_enrollment_id = $1
         OR ($2::uuid IS NOT NULL AND cp.group_order_id = $2 AND COALESCE(cp.period_number,1) = $4)
         OR ($2::uuid IS NULL AND $3::uuid IS NOT NULL AND cp.enrollment_batch_id = $3
             AND COALESCE(cp.period_number,1) = $4)
      ORDER BY cp.id FOR UPDATE OF cp`,
    [hint.id, hint.group_order_id || null, hint.enrollment_batch_id || null, hint.period_number || 1]
  )).rows;
  const ids = new Set([enrollmentId]);
  for (const period of periods) {
    const linked = await linkedEnrollments(client, period);
    linked.forEach(row => ids.add(row.id));
    // Partial group refunds need stable parent identity. Never guess from names
    // or phone numbers and accidentally revoke another family's lessons.
    if (period.group_order_id && linked.some(row => !row.source_parent_id || !row.source_student_ids?.length)) {
      throw conflict('REFUND_IDENTITY_REVIEW_REQUIRED', '團報訂單缺少家長識別，請先人工核對課程權益');
    }
    const target = linked.find(row => row.id === enrollmentId);
    if (period.group_order_id && target && linked.some(row => row.id !== enrollmentId
        && (row.source_parent_id === target.source_parent_id
          || row.source_student_ids.some(id => target.source_student_ids.includes(id)))
        && !['refunded', 'cancelled'].includes(row.status))) {
      throw conflict('REFUND_IDENTITY_REVIEW_REQUIRED', '同一家長本期有多筆團報訂單，請先核對學員權益');
    }
  }
  await client.query('SELECT id FROM admin_enrollments WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [[...ids]]);
  return periods;
}

async function assertCourseEntitlement(client, periodId, studentId = null) {
  const period = (await client.query('SELECT * FROM course_periods WHERE id = $1 FOR UPDATE', [periodId])).rows[0];
  if (!period || period.status !== 'active' || period.entitlement_state !== 'ACTIVE') {
    throw conflict('PERIOD_ENTITLEMENT_INACTIVE', '此課程期已停用或退費，無法簽到或扣課');
  }
  const linked = await linkedEnrollments(client, period);
  const closed = linked.filter(row => ['refunded', 'cancelled'].includes(row.status));
  if (!period.group_order_id && closed.length) {
    throw conflict('ENROLLMENT_ENTITLEMENT_INACTIVE', '來源報名已退費或取消，請先核對課程權益');
  }
  let studentIds = null;
  if (period.group_order_id && closed.length) {
    if (linked.some(row => !row.source_parent_id || !row.source_student_ids?.length)) {
      throw conflict('REFUND_IDENTITY_REVIEW_REQUIRED', '團報訂單缺少家長識別，請先人工核對課程權益');
    }
    const active = linked.filter(row => !['refunded', 'cancelled'].includes(row.status));
    studentIds = active.flatMap(row => row.source_student_ids);
    if (closed.some(row => active.some(other => other.source_parent_id === row.source_parent_id)
        || row.source_student_ids.some(id => studentIds.includes(id)))) {
      throw conflict('REFUND_IDENTITY_REVIEW_REQUIRED', '同一家長有部分退費訂單，請先核對學員權益');
    }
  }
  const roster = (await client.query(
    `SELECT cpe.student_id FROM course_period_enrollments cpe
       JOIN students s ON s.id = cpe.student_id
      WHERE cpe.course_period_id = $1 AND cpe.status = 'active'
        AND ($2::uuid[] IS NULL OR cpe.student_id = ANY($2::uuid[]))`, [periodId, studentIds]
  )).rows.map(row => row.student_id);
  if (!roster.length || (studentId && !roster.includes(studentId))) {
    throw conflict('STUDENT_ENTITLEMENT_INACTIVE', '學員已退費或不在有效課程名單中');
  }
  return roster;
}

async function revokeRefundedPeriods(client, periods) {
  for (const period of periods) {
    const linked = await linkedEnrollments(client, period);
    if (!linked.length || linked.some(row => !['refunded', 'cancelled'].includes(row.status))) continue;
    // MANUAL_REVIEW is the existing inactive entitlement state. The definitive
    // business status remains refunded; historical attendance is retained.
    await client.query(`UPDATE course_periods SET status = 'refunded',
      entitlement_state = CASE WHEN entitlement_state = 'ACTIVE' THEN 'MANUAL_REVIEW' ELSE entitlement_state END,
      updated_at = NOW() WHERE id = $1`, [period.id]);
    const cancelled = await client.query(
      `UPDATE course_sessions cs SET status = 'cancelled_normal', cancelled_at = NOW(), updated_at = NOW()
        WHERE course_period_id = $1 AND status IN ('confirmed','pending_group_confirm')
          AND NOT EXISTS (SELECT 1 FROM checkin_records cr WHERE cr.course_session_id = cs.id AND cr.attendance_status = 'ATTENDED')
        RETURNING id`, [period.id]);
    await client.query(`UPDATE coach_availability_slots SET status = 'available', booked_session_id = NULL, updated_at = NOW()
      WHERE booked_session_id = ANY($1::uuid[])`, [cancelled.rows.map(row => row.id)]);
  }
}

module.exports = { assertCourseEntitlement, lockRefundPeriods, revokeRefundedPeriods, linkedEnrollments, lockEnrollmentOperation };
