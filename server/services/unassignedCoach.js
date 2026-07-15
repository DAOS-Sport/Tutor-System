/**
 * Canonical「待分配」教練。
 *
 * 這不是 seed/demo 資料：它讓尚未分派真人教練的訂單仍可合法保存。固定 employee id
 * 使部署/重跑 bootstrap 可安全收斂；不會掃除、改寫或硬刪既有同名歷史資料。
 */
const { pool } = require('../models/db');

const UNASSIGNED_STAFF_ID = '__SYSTEM_UNASSIGNED_COACH__';
// coaches.phone 沿用既有 VARCHAR(20) NOT NULL/UNIQUE；這是內部 sentinel，
// 不放寬 schema，也不偽裝成真實客戶電話。
const UNASSIGNED_PHONE = '__UNASSIGNED_PHONE__';
const UNASSIGNED_NAME = '待分配';

function isUnassignedCoach(coach) {
  return !!coach && (
    coach.is_placeholder === true
    || String(coach.ragic_employee_id || '') === UNASSIGNED_STAFF_ID
  );
}

async function ensureUnassignedCoach() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [UNASSIGNED_STAFF_ID]);

    await client.query(
      `INSERT INTO admin_staff
         (id, name, role, venue_id, phone, is_senior, multiplier, active,
          is_coach, is_counter, is_lifeguard, is_placeholder)
       VALUES ($1,$2,'coach',NULL,NULL,FALSE,1.00,TRUE,FALSE,FALSE,FALSE,TRUE)
       ON CONFLICT (id) DO UPDATE
          SET name = EXCLUDED.name,
              role = 'coach',
              active = TRUE,
              is_senior = FALSE,
              multiplier = 1.00,
              is_placeholder = TRUE,
              updated_at = NOW()`,
      [UNASSIGNED_STAFF_ID, UNASSIGNED_NAME]
    );

    const coach = await client.query(
      `INSERT INTO coaches
         (ragic_employee_id, name, phone, is_senior, pricing_multiplier, is_active,
          intro_review_status, is_placeholder)
       VALUES ($1,$2,$3,FALSE,1.00,TRUE,'draft',TRUE)
       ON CONFLICT (ragic_employee_id) DO UPDATE
          SET name = EXCLUDED.name,
              phone = EXCLUDED.phone,
              is_senior = FALSE,
              pricing_multiplier = 1.00,
              is_active = TRUE,
              is_placeholder = TRUE,
              updated_at = NOW()
       RETURNING id`,
      [UNASSIGNED_STAFF_ID, UNASSIGNED_NAME, UNASSIGNED_PHONE]
    );
    const coachId = coach.rows[0]?.id;
    if (!coachId) throw new Error('unassigned coach upsert did not return id');

    // 全部啟用場館可選；不刪舊 mapping，避免中途場館設定變更導致既有訂單失去關聯。
    await client.query(
      `INSERT INTO coach_venues (coach_id, venue_id)
       SELECT $1, id FROM venues WHERE is_active = TRUE
       ON CONFLICT DO NOTHING`,
      [coachId]
    );
    await client.query(
      `INSERT INTO admin_staff_venues (staff_id, venue_id)
       SELECT $1, id FROM admin_venues WHERE COALESCE(is_active, TRUE) = TRUE
       ON CONFLICT DO NOTHING`,
      [UNASSIGNED_STAFF_ID]
    );
    await client.query('COMMIT');
    return { id: coachId, ragic_employee_id: UNASSIGNED_STAFF_ID, name: UNASSIGNED_NAME };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  UNASSIGNED_STAFF_ID,
  UNASSIGNED_PHONE,
  UNASSIGNED_NAME,
  isUnassignedCoach,
  ensureUnassignedCoach,
};
