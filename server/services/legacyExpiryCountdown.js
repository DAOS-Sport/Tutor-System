'use strict';
// 舊家教系統（ABLEPOS）移轉的課程包：匯入時家長還沒加入新系統的，到期日先記成 9999-12-31（尚未起算）。
// Owner 2026-10-20：家長加入系統（第一次以 LINE 登入）那天起算一年；已在新系統的家長匯入時就用統一到期日。
// 只改還是 9999-12-31 的課期，所以重複呼叫不會把已起算的日期往後推。
const { pool } = require('../models/db');

const NOT_STARTED = '9999-12-31';

async function startLegacyExpiryCountdown(parentId, db = pool) {
  const r = await db.query(
    `WITH started AS (
       UPDATE course_periods cp
          SET expires_at = ((NOW() AT TIME ZONE 'Asia/Taipei')::date + INTERVAL '1 year')::date, updated_at = NOW()
        WHERE cp.expires_at = $2::date
          AND EXISTS (SELECT 1 FROM admin_enrollments ae
                       WHERE ae.id = cp.admin_enrollment_id AND ae.external_order_no LIKE 'ABLEPOS:%')
          AND EXISTS (SELECT 1 FROM course_period_enrollments e JOIN students s ON s.id = e.student_id
                       WHERE e.course_period_id = cp.id AND s.parent_id::text = $1)
        RETURNING cp.admin_enrollment_id, cp.expires_at)
     INSERT INTO admin_enrollment_audit_logs (enrollment_id, at, action, by_user, reason)
     SELECT admin_enrollment_id, NOW(), 'legacy_expiry_started', 'system',
            '家長加入新系統，舊系統轉移課程到期日起算至 ' || to_char(expires_at, 'YYYY-MM-DD')
       FROM started
     RETURNING enrollment_id`,
    [String(parentId), NOT_STARTED]
  );
  return r.rowCount;
}

module.exports = { startLegacyExpiryCountdown, NOT_STARTED };
