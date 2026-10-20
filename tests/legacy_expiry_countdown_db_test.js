'use strict';
// 舊家教系統移轉課程的到期起算（Owner 2026-10-20）：匯入時還沒加入新系統的家長，
// 課期到期日記成 9999-12-31；家長加入（第一次登入）那天起算一年。
//
// 守的契約（startLegacyExpiryCountdown）：
//   1. 這位家長名下、ABLEPOS 訂單、尚未起算的課期 → 改成台北今天＋1 年，並寫訂單稽核。
//   2. 再呼叫一次不會把日期往後推、不多寫稽核。
//   3. 已有到期日的 ABLEPOS 課期、非 ABLEPOS 的 9999 課期、別位家長的課期都不動。
//   4. 家人先登入也算加入：買課家長已綁 LINE 但沒登入過時，同家庭成員登入，他的舊課一起起算。
//
// 真實 public schema、合成資料、try/finally 自己刪乾淨。
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('../server/node_modules/pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), '必須是 loopback 的拋棄式測試庫');
assert.match(target.pathname, /^\/daos_(test|audit)/, '必須是 daos_test / daos_audit');

const pool = new Pool({ connectionString: url, options: '-c statement_timeout=20000' });
const dbId = require.resolve('../server/models/db');
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { pool } };
const { startLegacyExpiryCountdown } = require('../server/services/legacyExpiryCountdown');

let passed = 0;
const made = { parents: [], orders: [], periods: [], coaches: [], families: [] };
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };
const suffix = randomUUID().slice(0, 8);
const phone = () => `09${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

async function family(venue, coach, orders) {
  const parent = (await pool.query(
    `INSERT INTO parents (phone, name, primary_venue_id, is_active) VALUES ($1,'到期測試家長',$2,TRUE) RETURNING id`,
    [phone(), venue])).rows[0].id;
  made.parents.push(parent);
  const kid = (await pool.query(
    `INSERT INTO students (parent_id, name, is_active) VALUES ($1,'到期測試學員',TRUE) RETURNING id`, [parent])).rows[0].id;
  const periods = [];
  for (const [i, o] of orders.entries()) {
    const orderId = `T${suffix}${made.orders.length}${i}`.toUpperCase();
    made.orders.push(orderId);
    await pool.query(
      `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
                                      original_price, final_price, status, submitted_at, student_ids, external_order_no)
       VALUES ($1,'到期測試家長','0900000000',$2,'到期測試教練',$3,$4,1,0,0,'confirmed',NOW(),$5,$6)`,
      [orderId, ['到期測試學員'], coach, venue, [kid], o.external]);
    const period = (await pool.query(
      `INSERT INTO course_periods (coach_id, venue_id, course_type, total_sessions, expires_at, original_price, final_price, status, admin_enrollment_id)
       VALUES ($1,$2,1,6,$3::date,0,0,'active',$4) RETURNING id`, [coach, venue, o.expires, orderId])).rows[0].id;
    made.periods.push(period);
    await pool.query(`INSERT INTO course_period_enrollments (course_period_id, student_id, status) VALUES ($1,$2,'active')`, [period, kid]);
    periods.push(period);
  }
  return { parent, periods };
}

const expiry = async (id) => (await pool.query(`SELECT to_char(expires_at,'YYYY-MM-DD') d FROM course_periods WHERE id=$1`, [id])).rows[0].d;
const audits = async (orderId) => (await pool.query(
  `SELECT reason FROM admin_enrollment_audit_logs WHERE enrollment_id=$1 AND action='legacy_expiry_started'`, [orderId])).rows;

(async () => {
  try {
    const venue = (await pool.query(`SELECT id FROM venues ORDER BY id LIMIT 1`)).rows[0].id;
    const coach = randomUUID();
    made.coaches.push(coach);
    await pool.query(`INSERT INTO coaches (id, ragic_employee_id, name, phone, pricing_multiplier, is_active)
                      VALUES ($1,$2,'到期測試教練',$3,1,TRUE)`, [coach, `T${suffix}`, phone()]);
    const today = (await pool.query(`SELECT to_char((NOW() AT TIME ZONE 'Asia/Taipei')::date + INTERVAL '1 year','YYYY-MM-DD') d`)).rows[0].d;

    const a = await family(venue, coach, [
      { external: `ABLEPOS:${suffix}1`, expires: '9999-12-31' },
      { external: `ABLEPOS:${suffix}2`, expires: '2027-10-23' },
      { external: null, expires: '9999-12-31' },
    ]);
    const b = await family(venue, coach, [{ external: `ABLEPOS:${suffix}3`, expires: '9999-12-31' }]);

    await t('加入的家長：尚未起算的舊系統課期從今天起算一年，並寫稽核', async () => {
      assert.equal(await startLegacyExpiryCountdown(a.parent, pool), 1);
      assert.equal(await expiry(a.periods[0]), today);
      const logs = await audits(made.orders[0]);
      assert.equal(logs.length, 1);
      assert.match(logs[0].reason, new RegExp(today));
    });

    await t('再呼叫一次不會往後推、不多寫稽核', async () => {
      assert.equal(await startLegacyExpiryCountdown(a.parent, pool), 0);
      assert.equal(await expiry(a.periods[0]), today);
      assert.equal((await audits(made.orders[0])).length, 1);
    });

    await t('已有到期日的舊系統課期、非舊系統的課期、別位家長的課期都不動', async () => {
      assert.equal(await expiry(a.periods[1]), '2027-10-23');
      assert.equal(await expiry(a.periods[2]), '9999-12-31');
      assert.equal(await expiry(b.periods[0]), '9999-12-31');
    });

    await t('家人先登入：同家庭成員登入，買課家長的舊課一起起算', async () => {
      process.env.FAMILY_ACCOUNTS_V1 = 'all';
      const c = await family(venue, coach, [{ external: `ABLEPOS:${suffix}4`, expires: '9999-12-31' }]);
      const member = (await pool.query(
        `INSERT INTO parents (phone, name, primary_venue_id, is_active, line_uid) VALUES ($1,'到期測試家人',$2,TRUE,$3) RETURNING id, line_uid`,
        [phone(), venue, `Utest${suffix}m`])).rows[0];
      made.parents.push(member.id);
      // 買課家長的 LINE 是被同步或後台綁上的，本人沒登入過（家庭 active 成員一定已綁 LINE）。
      await pool.query(`UPDATE parents SET line_uid=$2 WHERE id=$1`, [c.parent, `Utest${suffix}o`]);
      const fam = (await pool.query(`INSERT INTO families (owner_parent_id, name) VALUES ($1,'到期測試家庭') RETURNING id`, [c.parent])).rows[0].id;
      made.families.push(fam);
      await pool.query(`INSERT INTO family_members (family_id, parent_id, line_uid, role, status) VALUES ($1,$2,$3,'owner','active')`,
        [fam, c.parent, `Utest${suffix}o`]);
      await pool.query(`INSERT INTO family_members (family_id, parent_id, line_uid, role, status) VALUES ($1,$2,$3,'member','active')`,
        [fam, member.id, member.line_uid]);
      assert.equal(await startLegacyExpiryCountdown(member.id, pool), 1);
      assert.equal(await expiry(c.periods[0]), today);
    });

    console.log(`\n${passed} 個測試全數通過`);
  } finally {
    delete process.env.FAMILY_ACCOUNTS_V1;
    try {
      await pool.query(`DELETE FROM families WHERE id = ANY($1::uuid[])`, [made.families]);
      await pool.query(`DELETE FROM course_period_enrollments WHERE course_period_id = ANY($1::uuid[])`, [made.periods]);
      await pool.query(`DELETE FROM course_periods WHERE id = ANY($1::uuid[])`, [made.periods]);
      await pool.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = ANY($1::text[])`, [made.orders]);
      await pool.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [made.orders]);
      await pool.query(`DELETE FROM students WHERE parent_id = ANY($1::uuid[])`, [made.parents]);
      await pool.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [made.parents]);
      await pool.query(`DELETE FROM coaches WHERE id = ANY($1::uuid[])`, [made.coaches]);
    } catch (e) {
      console.error('清除失敗：' + e.message);
      process.exitCode = 1;
    }
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
