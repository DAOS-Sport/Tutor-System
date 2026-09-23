'use strict';
// Real PostgreSQL + actual route handlers; isolated schema and synthetic rows.
// No HTTP server, application startup, LINE, Ragic, or production data access.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('../server/node_modules/pg');
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname), 'disposable loopback test DB required');
const schema = 'refund_test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public -c statement_timeout=10000` });
function stub(name, exports) {
  const id = require.resolve('../server/' + name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('models/db', { pool });
stub('services/checkinNotify', { notifyCheckinSafely() {} });
stub('services/websocket', { broadcastAdminEvent() {} });
stub('services/featureFlags', { getFeatureFlag: async () => ({ enabled: true }), flagAllowsPhone: () => true });
const { lockRefundPeriods, revokeRefundedPeriods, assertCourseEntitlement, lockEnrollmentOperation } = require('../server/services/courseEntitlements');
const { reverseLessonDeduction } = require('../server/services/deductionRevival');
const routes = {};
function route(name, path) {
  routes[name] ||= require('../server/routes/' + name);
  return routes[name].stack.find(layer => layer.route?.path === path && layer.route.methods.post).route.stack.at(-1).handle;
}
async function call(handler, req) {
  let status = 200, body;
  const res = { status(code) { status = code; return this; }, json(data) { body = data; return this; } };
  await handler({ params: {}, query: {}, body: {}, get: () => '', adminUser: { role: 'admin', name: 'test', sub: 'test' }, ...req }, res);
  return { status, body };
}
async function fixture({ group = false, family = false, state = 'confirmed' } = {}) {
  const p = randomUUID(), s = randomUUID(), period = randomUUID(), coach = randomUUID();
  const eid = 'test-' + randomUUID(), checkout = randomUUID(), batch = family ? randomUUID() : null, gid = group ? randomUUID() : null;
  await pool.query('INSERT INTO parents(id,phone,name) VALUES ($1,$2,$3)', [p, eid, 'parent']);
  await pool.query('INSERT INTO students(id,parent_id,name) VALUES ($1,$2,$3)', [s, p, 'student']);
  await pool.query('INSERT INTO checkout_sessions(checkout_id,parent_id) VALUES ($1,$2)', [checkout,p]);
  await pool.query(`INSERT INTO admin_enrollments(id,status,checkout_id,parent_phone,students,final_price,total_sessions,used_sessions,group_order_id,enrollment_batch_id)
    VALUES ($1,$2,$3,$4,ARRAY['student'],600,6,0,$5,$6)`, [eid,state,checkout,eid,gid,batch]);
  await pool.query(`INSERT INTO course_periods(id,admin_enrollment_id,coach_id,group_order_id,enrollment_batch_id)
    VALUES ($1,$2,$3,$4,$5)`, [period,eid,coach,gid,batch]);
  await pool.query('INSERT INTO course_period_enrollments(course_period_id,student_id) VALUES ($1,$2)', [period,s]);
  if (group) await pool.query('INSERT INTO group_order_members(group_order_id,parent_id,student_ids) VALUES ($1,$2,$3)',[gid,p,[s]]);
  const session = (await pool.query('INSERT INTO course_sessions(course_period_id,coach_id) VALUES ($1,$2) RETURNING id', [period,coach])).rows[0].id;
  return { p,s,period,coach,eid,session,checkout,gid,batch };
}
const refundReq = x => ({ params: { id: x.eid }, body: { reason: 'synthetic regression', fee_rate: 0 } });
const checkReq = x => ({ parent: { id: x.p, phone: 'test' }, body: { sessionId: x.session, studentId: x.s } });

(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await pool.query(`
      CREATE TABLE parents(id uuid PRIMARY KEY, phone text, name text, is_active boolean DEFAULT true, line_uid text);
      CREATE TABLE students(id uuid PRIMARY KEY,parent_id uuid,name text,is_active boolean DEFAULT true);
      CREATE TABLE coaches(id uuid PRIMARY KEY,name text);
      CREATE TABLE admin_venues(id text PRIMARY KEY,name text);
      CREATE TABLE venues(id text PRIMARY KEY,name text);
      CREATE TABLE admin_users(id uuid PRIMARY KEY,name text);
      CREATE TABLE parent_line_profiles(line_uid text,display_name text,source text);
      CREATE TABLE checkout_sessions(checkout_id uuid PRIMARY KEY,parent_id uuid);
      CREATE TABLE group_order_members(group_order_id uuid,parent_id uuid,student_ids uuid[]);
      CREATE TABLE admin_settings(key text,value text);
      CREATE TABLE admin_enrollments(id text PRIMARY KEY,status text,checkout_id uuid,parent_phone text,parent_name text,
        students text[],created_by uuid,venue_id text,coach text,coach_id uuid,course_type int,submitted_at timestamptz DEFAULT now(),
        group_order_id uuid,enrollment_batch_id uuid,period_number int DEFAULT 1,order_kind text DEFAULT 'standard',
        total_sessions int,used_sessions int,final_price numeric,original_price numeric,refund_amount numeric,refunded_at timestamptz,updated_at timestamptz DEFAULT now());
      CREATE TABLE admin_enrollment_audit_logs(id uuid DEFAULT gen_random_uuid(),enrollment_id text,action text,by_user text,reason text,refund_amount numeric,at timestamptz DEFAULT now());
      CREATE TABLE promotion_usages(admin_enrollment_id text,group_order_id uuid,group_order_member_id uuid,promotion_id uuid,used_periods int);
      CREATE TABLE course_periods(id uuid PRIMARY KEY,admin_enrollment_id text,group_order_id uuid,enrollment_batch_id uuid,
        coach_id uuid,venue_id text,course_type int DEFAULT 1,period_number int DEFAULT 1,total_sessions int DEFAULT 6,
        used_sessions int DEFAULT 0,status text DEFAULT 'active',entitlement_state text DEFAULT 'ACTIVE',
        checkin_mode text DEFAULT 'self',expires_at date DEFAULT CURRENT_DATE+365,updated_at timestamptz DEFAULT now());
      CREATE TABLE course_period_enrollments(course_period_id uuid,student_id uuid,status text DEFAULT 'active',UNIQUE(course_period_id,student_id));
      CREATE TABLE course_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),course_period_id uuid,coach_id uuid,status text DEFAULT 'confirmed',
        scheduled_at timestamptz DEFAULT now(),completed_at timestamptz,cancelled_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
        created_via text,self_checkin_date date,duration_minutes int DEFAULT 60,session_deducted boolean DEFAULT false);
      CREATE TABLE checkin_records(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),course_session_id uuid,student_id uuid,
        checked_in_by_student_id uuid,checked_in_by_parent_id uuid,checked_in_source text,checked_in_at timestamptz DEFAULT now(),
        attendance_status text DEFAULT 'ATTENDED',reversed_by text,reversal_reason text,reversed_at timestamptz,UNIQUE(course_session_id,student_id));
      CREATE TABLE coach_availability_slots(id uuid DEFAULT gen_random_uuid(),status text,booked_session_id uuid,updated_at timestamptz);
      CREATE TABLE manual_lesson_deductions(id uuid,course_period_id uuid,request_id text,payload_fingerprint text,
        course_session_id uuid,status text,reversed_by text,reversal_reason text,reversed_at timestamptz);
      CREATE TABLE lesson_deduction_reversals(id uuid DEFAULT gen_random_uuid(),course_session_id uuid UNIQUE,course_period_id uuid,
        reason text,reversed_by text,reversed_at timestamptz DEFAULT now());
    `);
    const check = route('checkins', '/');
    const refund = route('admin/enrollments', '/:id/refund');
    const backfill = route('admin/sessions', '/:id/backfill-checkin');
    const create = route('admin/enrollments', '/');
    for (const coach of [{ id: randomUUID(), name: 'coach' }, '[object Object]']) {
      const rejected = await call(create,{body:{request_id:randomUUID(),coach}});
      assert.equal(rejected.status,400);assert.equal(rejected.body.code,'COACH_NAME_INVALID');
    }
    console.log('PASS manual enrollment rejects object and object-string coach values');

    const a = await fixture();
    const checked = await Promise.all([call(check, checkReq(a)),call(check, checkReq(a))]);
    assert.deepEqual(checked.map(r => r.status), [200,200]);
    assert.equal(checked[0].body.checkin_id, checked[1].body.checkin_id);
    assert.deepEqual((await pool.query('SELECT status,session_deducted FROM course_sessions WHERE id=$1',[a.session])).rows[0], {status:'completed',session_deducted:true});
    assert.equal((await pool.query('SELECT used_sessions FROM course_periods WHERE id=$1',[a.period])).rows[0].used_sessions,1);
    console.log('PASS duplicate/concurrent attendance consumes once and completes session');

    // Stored usage deliberately stale: refund must count attendance under lock.
    await pool.query('UPDATE admin_enrollments SET used_sessions=0 WHERE id=$1',[a.eid]);
    const refunds = await Promise.all([call(refund,refundReq(a)),call(refund,refundReq(a))]);
    assert.equal(refunds.filter(r=>r.status===200).length,1);
    assert.equal(refunds.find(r=>r.status===200).body.refund_amount,500);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM admin_enrollment_audit_logs WHERE enrollment_id=$1',[a.eid])).rows[0].n,1);
    assert.equal((await call(check,checkReq(a))).status,409);
    assert.equal((await call(backfill,{params:{id:a.session},body:{checkin_at:new Date().toISOString()}})).status,409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM checkin_records WHERE course_session_id=$1',[a.session])).rows[0].n,1);
    console.log('PASS concurrent/replayed refund writes once, counts real usage, blocks attendance/backfill');

    // Legacy mismatches must fail closed before any attendance write.
    const legacy = await fixture({state:'refunded'});
    assert.equal((await call(check,checkReq(legacy))).status,409);
    const self = route('checkins','/self');
    assert.equal((await call(self,{parent:{id:legacy.p,phone:'test'},body:{course_period_id:legacy.period,student_ids:[legacy.s]}})).status,409);
    const deduct = route('admin/manualDeductions','/');
    const rejectedDeduction = await call(deduct,{body:{course_period_id:legacy.period,student_id:legacy.s,request_id:randomUUID(),reason:'test'}});
    assert.equal(rejectedDeduction.status,409);assert.equal(rejectedDeduction.body.code,'ENROLLMENT_ENTITLEMENT_INACTIVE');
    await pool.query("UPDATE admin_enrollments SET status='confirmed' WHERE id=$1",[legacy.eid]);
    await pool.query("UPDATE course_periods SET entitlement_state='SUPERSEDED' WHERE id=$1",[legacy.period]);
    assert.equal((await call(check,checkReq(legacy))).status,409);
    console.log('PASS legacy refunded source and inactive entitlement rejected');

    const future = await fixture();
    await pool.query("INSERT INTO coach_availability_slots(status,booked_session_id) VALUES ('booked',$1)",[future.session]);
    assert.equal((await call(refund,refundReq(future))).status,200);
    assert.deepEqual((await pool.query('SELECT status,entitlement_state FROM course_periods WHERE id=$1',[future.period])).rows[0], {status:'refunded',entitlement_state:'MANUAL_REVIEW'});
    assert.equal((await pool.query('SELECT status FROM course_sessions WHERE id=$1',[future.session])).rows[0].status,'cancelled_normal');
    assert.equal((await pool.query('SELECT status FROM coach_availability_slots')).rows[0].status,'available');
    console.log('PASS refund closes period and releases unused booking');

    const family = await fixture({family:true});
    await pool.query(`INSERT INTO admin_enrollments(id,status,final_price,total_sessions,used_sessions,enrollment_batch_id)
      VALUES ($1,'confirmed',600,6,0,$2)`,[family.eid+'-sibling',family.batch]);
    const fr = await call(refund,refundReq(family));
    assert.equal(fr.status,200); assert.equal(fr.body.refund_amount,1200); assert.equal(fr.body.refunded_enrollment_ids.length,2);
    console.log('PASS family shared refund closes all same-period sibling orders atomically');

    const group = await fixture({group:true}), other = await fixture();
    await pool.query('UPDATE admin_enrollments SET group_order_id=$2 WHERE id=$1',[other.eid,group.gid]);
    await pool.query('INSERT INTO group_order_members(group_order_id,parent_id,student_ids) VALUES ($1,$2,$3)',[group.gid,other.p,[other.s]]);
    await pool.query('INSERT INTO course_period_enrollments(course_period_id,student_id) VALUES ($1,$2)',[group.period,other.s]);
    assert.equal((await call(refund,refundReq(group))).status,200);
    assert.equal((await call(check,checkReq(group))).status,409);
    await pool.query('UPDATE students SET parent_id=$2 WHERE id=$1',[group.s,other.p]);
    assert.equal((await call(check,{parent:{id:other.p,phone:'test'},body:{sessionId:group.session,studentId:group.s}})).status,409,
      'changing parent ownership must not revive a refunded group membership');
    const gc = await call(check,{parent:{id:other.p,phone:'test'},body:{sessionId:group.session,studentId:other.s}});
    assert.equal(gc.status,200);
    assert.deepEqual((await pool.query('SELECT student_id FROM checkin_records WHERE course_session_id=$1',[group.session])).rows.map(r=>r.student_id),[other.s]);
    assert.equal((await pool.query('SELECT used_sessions FROM admin_enrollments WHERE id=$1',[group.eid])).rows[0].used_sessions,0);
    console.log('PASS partial group refund excludes refunded household, preserves other family');

    const ambiguous = await fixture({group:true});
    await pool.query(`INSERT INTO admin_enrollments(id,status,checkout_id,group_order_id,final_price,total_sessions,used_sessions)
      VALUES ($1,'confirmed',$2,$3,600,6,0)`,[ambiguous.eid+'-duplicate',ambiguous.checkout,ambiguous.gid]);
    const ambiguousResult = await call(refund,refundReq(ambiguous));
    assert.equal(ambiguousResult.status,409);assert.equal(ambiguousResult.body.code,'REFUND_IDENTITY_REVIEW_REQUIRED');
    assert.equal((await pool.query('SELECT status FROM admin_enrollments WHERE id=$1',[ambiguous.eid])).rows[0].status,'confirmed');
    const missing = await fixture({group:true});
    await pool.query('UPDATE checkout_sessions SET parent_id=NULL WHERE checkout_id=$1',[missing.checkout]);
    const missingResult = await call(refund,refundReq(missing));
    assert.equal(missingResult.status,409);assert.equal(missingResult.body.code,'REFUND_IDENTITY_REVIEW_REQUIRED');
    console.log('PASS ambiguous/missing group parent identity refuses refund without mutation');

    // Hold real refund lock, queue attendance, then commit: attendance must see
    // the final refunded state rather than the pre-wait query snapshot.
    const race = await fixture(), tx = await pool.connect();
    try {
      await tx.query('BEGIN'); const periods = await lockRefundPeriods(tx,race.eid);
      await tx.query("UPDATE admin_enrollments SET status='refunded' WHERE id=$1",[race.eid]);
      const waiting = call(check,checkReq(race));
      await revokeRefundedPeriods(tx,periods); await tx.query('COMMIT');
      assert.equal((await waiting).status,409);
    } finally { await tx.query('ROLLBACK');tx.release(); }
    console.log('PASS refund-versus-attendance race observes final committed entitlement');

    const rollback = await fixture(), rb = await pool.connect();
    try {
      await rb.query('BEGIN'); const periods = await lockRefundPeriods(rb,rollback.eid);
      await rb.query("UPDATE admin_enrollments SET status='refunded' WHERE id=$1",[rollback.eid]);
      await revokeRefundedPeriods(rb,periods); await rb.query('ROLLBACK');
      await rb.query('BEGIN'); assert.ok((await assertCourseEntitlement(rb,rollback.period,rollback.s)).includes(rollback.s));
      await rb.query('ROLLBACK');
    } finally { rb.release(); }
    assert.equal((await pool.query('SELECT status FROM admin_enrollments WHERE id=$1',[rollback.eid])).rows[0].status,'confirmed');
    console.log('PASS transaction rollback restores order and entitlement together');

    // Reconciliation operation lock is shared with refunds, so creation cannot
    // slip between the period lookup and enrollment lock.
    const recon = await fixture(), rc = await pool.connect();
    try {
      await rc.query('BEGIN'); await lockEnrollmentOperation(rc,recon.eid);
      const waiting = call(refund,refundReq(recon));
      await rc.query('COMMIT'); assert.equal((await waiting).status,200);
    } finally { await rc.query('ROLLBACK'); rc.release(); }
    console.log('PASS reconcile/refund operation lock serializes safely');

    const reverse = await fixture();
    assert.equal((await call(check,checkReq(reverse))).status,200);
    const holder = await pool.connect(), reverser = await pool.connect();
    try {
      await holder.query('BEGIN'); await holder.query('SELECT id FROM course_periods WHERE id=$1 FOR UPDATE',[reverse.period]);
      await reverser.query('BEGIN');
      const pending = reverseLessonDeduction(reverser,{sessionId:reverse.session,reason:'test',reversedBy:'test'});
      let blocked = false;
      for(let i=0;i<100;i++) {
        blocked = (await pool.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[reverser.processID])).rows[0]?.blocked;
        if(blocked) break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.equal(blocked,true,'reversal must wait at the period lock');
      // The old session->period lock order deadlocks here.
      await holder.query('SELECT id FROM course_sessions WHERE id=$1 FOR UPDATE',[reverse.session]);
      await holder.query('COMMIT');
      assert.equal((await pending).reversedAttendances,1);await reverser.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK');await reverser.query('ROLLBACK');holder.release();reverser.release();
    }
    console.log('PASS reversal and attendance/refund use consistent period-before-session lock order');
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
})().catch(error => { console.error(error); process.exitCode=1; });
