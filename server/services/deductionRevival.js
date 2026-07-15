/**
 * Reverse one lesson usage event without deleting attendance history.
 * The caller owns the transaction. Lock order is course_session -> course_period,
 * then attendance/ledger updates, so concurrent retries serialize safely.
 */
async function reverseLessonDeduction(client, {
  sessionId,
  reason,
  reversedBy,
  allowCreatedVia = null,
} = {}) {
  const cleanReason = String(reason || '').trim().slice(0, 1000);
  const actor = String(reversedBy || '').trim().slice(0, 120) || 'unknown';
  if (!cleanReason) {
    const err = new Error('請填寫歸還原因');
    err.code = 'REASON_REQUIRED';
    err.http = 400;
    throw err;
  }

  const sr = await client.query(
    `SELECT cs.id, cs.course_period_id, cs.status::text AS status, cs.created_via,
            cp.venue_id, cp.admin_enrollment_id, cp.group_order_id,
            cp.enrollment_batch_id, cp.period_number, cp.total_sessions
       FROM course_sessions cs
       JOIN course_periods cp ON cp.id = cs.course_period_id
      WHERE cs.id = $1
      FOR UPDATE OF cs`,
    [sessionId]
  );
  if (!sr.rowCount) {
    const err = new Error('找不到課堂');
    err.code = 'SESSION_NOT_FOUND';
    err.http = 404;
    throw err;
  }
  const session = sr.rows[0];
  await client.query(`SELECT id FROM course_periods WHERE id = $1 FOR UPDATE`, [session.course_period_id]);

  if (allowCreatedVia && session.created_via !== allowCreatedVia) {
    const err = new Error('此課堂不可由這個入口撤銷');
    err.code = 'SESSION_SOURCE_NOT_ALLOWED';
    err.http = 400;
    throw err;
  }

  const prior = await client.query(
    `SELECT id, reason, reversed_by, reversed_at
       FROM lesson_deduction_reversals
      WHERE course_session_id = $1
      FOR UPDATE`,
    [sessionId]
  );
  if (prior.rowCount) {
    return { idempotent: true, session, reversal: prior.rows[0], reversedAttendances: 0 };
  }

  const activeAttendance = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM checkin_records
      WHERE course_session_id = $1 AND attendance_status = 'ATTENDED'`,
    [sessionId]
  );
  if (!activeAttendance.rows[0].n) {
    const err = new Error('此課堂沒有可歸還的扣堂出席紀錄');
    err.code = 'NO_APPLIED_ATTENDANCE';
    err.http = 409;
    throw err;
  }

  const reversal = await client.query(
    `INSERT INTO lesson_deduction_reversals
       (course_session_id, course_period_id, reason, reversed_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (course_session_id) DO NOTHING
     RETURNING id, reason, reversed_by, reversed_at`,
    [sessionId, session.course_period_id, cleanReason, actor]
  );
  if (!reversal.rowCount) {
    const existing = await client.query(
      `SELECT id, reason, reversed_by, reversed_at
         FROM lesson_deduction_reversals WHERE course_session_id = $1`,
      [sessionId]
    );
    return { idempotent: true, session, reversal: existing.rows[0], reversedAttendances: 0 };
  }

  const attendance = await client.query(
    `UPDATE checkin_records
        SET attendance_status = 'REVERSED', reversed_by = $2,
            reversal_reason = $3, reversed_at = NOW()
      WHERE course_session_id = $1 AND attendance_status = 'ATTENDED'`,
    [sessionId, actor, cleanReason]
  );
  await client.query(
    `UPDATE course_sessions
        SET status = 'cancelled_normal', cancelled_at = COALESCE(cancelled_at, NOW()),
            session_deducted = FALSE, self_checkin_date = NULL, updated_at = NOW()
      WHERE id = $1`,
    [sessionId]
  );
  await client.query(
    `UPDATE manual_lesson_deductions
        SET status = 'REVERSED', reversed_by = $2, reversal_reason = $3, reversed_at = NOW()
      WHERE course_session_id = $1 AND status = 'APPLIED'`,
    [sessionId, actor, cleanReason]
  );

  const usage = await client.query(
    `SELECT COUNT(DISTINCT cs.id)::int AS n
       FROM course_sessions cs
       JOIN checkin_records cr ON cr.course_session_id = cs.id
      WHERE cs.course_period_id = $1
        AND cs.status::text NOT LIKE 'cancelled%'
        AND cr.attendance_status = 'ATTENDED'`,
    [session.course_period_id]
  );
  const used = Number(usage.rows[0]?.n || 0);
  await client.query(
    `UPDATE course_periods SET used_sessions = $2, updated_at = NOW() WHERE id = $1`,
    [session.course_period_id, used]
  );
  await client.query(
    `UPDATE admin_enrollments ae
        SET used_sessions = $5, updated_at = NOW()
      WHERE ae.id = $1
         OR ($2::uuid IS NOT NULL AND ae.group_order_id = $2::uuid
             AND COALESCE(ae.period_number, 1) = COALESCE($4::int, 1))
         OR ($3::uuid IS NOT NULL AND ae.enrollment_batch_id = $3::uuid
             AND COALESCE(ae.period_number, 1) = COALESCE($4::int, 1))`,
    [session.admin_enrollment_id || '', session.group_order_id || null,
     session.enrollment_batch_id || null, session.period_number || 1, used]
  );
  if (session.admin_enrollment_id) {
    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
       SELECT id, $2, $3 FROM admin_enrollments WHERE id = $1`,
      [session.admin_enrollment_id, `扣課復活（課堂 ${sessionId}，歸還 1 堂；原因：${cleanReason}）`, actor]
    );
  }

  return {
    idempotent: false,
    session,
    reversal: reversal.rows[0],
    reversedAttendances: attendance.rowCount,
    usedSessions: used,
    remainingSessions: Math.max(0, Number(session.total_sessions || 0) - used),
  };
}

module.exports = { reverseLessonDeduction };
