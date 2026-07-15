const { Client } = require('../../server/node_modules/pg');
const { ensureUnassignedCoach, UNASSIGNED_SYSTEM_KEY } = require('../../server/services/unassignedCoach');
const { assert, step } = require('./_lib');

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  step('system-managed unassigned coach is idempotent and non-login/non-payroll');
  const first = await ensureUnassignedCoach();
  const second = await ensureUnassignedCoach();
  assert(first.id === second.id, 'bootstrap retry returns the same coach');
  const rows = await pg.query(
    `SELECT id, name, system_key, is_active, is_placeholder, system_managed, visible,
            assignable, login_allowed, payroll_eligible, percentage_eligible, line_uid
       FROM coaches WHERE system_key = $1`,
    [UNASSIGNED_SYSTEM_KEY]
  );
  assert(rows.rowCount === 1, 'UNIQUE(system_key) leaves exactly one UNASSIGNED_COACH');
  const coach = rows.rows[0];
  assert(coach.name === '待分配' && coach.is_active && coach.is_placeholder
    && coach.system_managed && coach.visible && coach.assignable, 'placeholder remains active, visible, and assignable');
  assert(!coach.login_allowed && !coach.payroll_eligible && !coach.percentage_eligible && !coach.line_uid,
    'placeholder cannot login, needs no LINE UID, and is excluded from pay/percentage');
  const adminLogin = await pg.query(
    `SELECT COUNT(*)::int AS n FROM admin_users WHERE username = $1 OR id = $1`,
    [UNASSIGNED_SYSTEM_KEY]
  );
  assert(adminLogin.rows[0].n === 0, 'no login account is created for the placeholder');
  await pg.end();
})().catch((error) => { console.error(error); process.exit(1); });
