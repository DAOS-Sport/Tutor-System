// Disposable local database only: stale schedule reads must never overwrite newer edits.
const assert = require('node:assert/strict');
const { pool } = require('../server/models/db');
const { applyDueScheduledCourseTypeChanges: apply } = require('../server/services/courseTypeSchedule');

(async () => {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && /audit|test/.test(url.pathname));
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const zone = (await db.query("INSERT INTO pricing_zones(name) VALUES ($1) RETURNING id", ['schedule-audit-' + Date.now()])).rows[0].id;
    const ct = 987654;
    await db.query('INSERT INTO course_types(course_type) VALUES ($1) ON CONFLICT DO NOTHING', [ct]);
    await db.query(`INSERT INTO course_type_configs(pricing_zone_id,course_type,label,max_students,base_price,
      scheduled_effective_date,pending_changes) VALUES ($1,$2,'schedule test',1,100,NOW()-INTERVAL '1 minute','{"base_price":200}')`, [zone, ct]);
    const wrapper = (afterRead) => ({ query: async (sql, args) => {
      if (/^\s*SELECT course_type,/.test(sql)) {
        const r = await db.query(sql + ' AND pricing_zone_id = ' + zone, args);
        await afterRead();
        return r;
      }
      return db.query(sql, args);
    }});
    const changed = await apply(wrapper(() => db.query(`UPDATE course_type_configs SET
      pending_changes='{"base_price":300}', scheduled_effective_date=NOW()+INTERVAL '1 day'
      WHERE pricing_zone_id=$1 AND course_type=$2`, [zone, ct])));
    assert.equal(changed, 0, 'stale worker must skip a replaced schedule');
    let row = (await db.query('SELECT * FROM course_type_configs WHERE pricing_zone_id=$1 AND course_type=$2', [zone, ct])).rows[0];
    assert.equal(Number(row.base_price), 100);
    assert.equal(row.pending_changes.base_price, 300);
    await db.query("UPDATE course_type_configs SET scheduled_effective_date=NOW()-INTERVAL '1 minute' WHERE pricing_zone_id=$1", [zone]);
    const replay = await apply(wrapper(() => apply(wrapper(async () => {}))));
    assert.equal(replay, 0, 'second worker must skip an already applied schedule');
    row = (await db.query('SELECT base_price,pending_changes FROM course_type_configs WHERE pricing_zone_id=$1 AND course_type=$2', [zone, ct])).rows[0];
    assert.equal(Number(row.base_price), 300);
    assert.equal(row.pending_changes, null);
    const audits = await db.query("SELECT COUNT(*)::int AS n FROM course_type_config_audit_logs WHERE pricing_zone_id=$1 AND action='排程套用'", [zone]);
    assert.equal(audits.rows[0].n, 1);
    console.log('PASS: replaced schedule preserved; competing workers apply and audit once');
  } finally {
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
