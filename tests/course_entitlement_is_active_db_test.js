'use strict';
// 真實 PostgreSQL + 真實路由處理器；獨立 schema、合成資料。
// 不起 HTTP server、不碰 LINE / Ragic、不讀寫任何正式資料。
//
// 守的是三件事（對應 Issue #4 與「慧娟案」）：
//   T1 名單必須排除停用學員 —— 否則跨家庭共享課期會「守門放行、最終寫入過濾」，
//      回 201 成功但出席寫給別人家小孩，或一筆都沒寫。
//   T2 解析不到來源報名時必須 fail-closed —— 原本 closed.length===0 就一路放行。
//   T4 家庭共班部分退款不得把還在付費的兄弟擋成「你已退費」。
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('../server/node_modules/pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');

const schema = 'entitlement_test_' + randomUUID().replaceAll('-', '');
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public -c statement_timeout=10000` });
const other = new Pool({ connectionString: url, options: `-c search_path=${schema},public -c statement_timeout=10000` });

function stub(name, exports) {
  const id = require.resolve('../server/' + name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('models/db', { pool });
stub('services/checkinNotify', { notifyCheckinSafely() {} });
stub('services/websocket', { broadcastAdminEvent() {} });
stub('services/featureFlags', { getFeatureFlag: async () => ({ enabled: true }), flagAllowsPhone: () => true });

const { assertCourseEntitlement } = require('../server/services/courseEntitlements');

function route(name, path) {
  const mod = require('../server/routes/' + name);
  return mod.stack.find((l) => l.route?.path === path && l.route.methods.post).route.stack.at(-1).handle;
}
async function call(handler, req) {
  let status = 200; let body;
  const res = { status(c) { status = c; return this; }, json(d) { body = d; return this; } };
  await handler({ params: {}, query: {}, body: {}, get: () => '', ...req }, res);
  return { status, body };
}

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };

/** 獨立重算：直接數這一期 active 名單裡「未停用」的學員，不經過被測函式的任何邏輯。 */
async function expectedActiveRoster(periodId) {
  const r = await pool.query(
    `SELECT cpe.student_id FROM course_period_enrollments cpe
       JOIN students s ON s.id = cpe.student_id
      WHERE cpe.course_period_id = $1 AND cpe.status = 'active'
        AND COALESCE(s.is_active, TRUE) = TRUE
      ORDER BY cpe.student_id`, [periodId]);
  return r.rows.map((x) => x.student_id).sort();
}

/** 在一個交易裡跑，跑完一律 ROLLBACK —— 每個案例互不污染。 */
async function inTx(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); return await fn(client); } finally {
    await client.query('ROLLBACK').catch(() => {}); client.release();
  }
}
async function expectConflict(fn, code) {
  try { await fn(); } catch (e) {
    assert.equal(e.status, 409, '狀態應為 409，實際 ' + e.status + '：' + e.message);
    assert.equal(e.code, code, '錯誤碼應為 ' + code + '，實際 ' + e.code);
    return e;
  }
  throw new assert.AssertionError({ message: '應該要拋 ' + code + '，但順利通過了' });
}

/** 建一堂已排定、未簽到的課堂，給預約制簽到用。 */
async function makeSession(periodId) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO course_sessions(id, course_period_id, status, scheduled_at)
     VALUES ($1, $2, 'confirmed', NOW())`, [id, periodId]);
  return id;
}

/** 建一個課期。kind: 'single' | 'group' | 'batch' */
async function makePeriod({ kind = 'single', orders = [{ status: 'confirmed' }], checkinMode = 'self' } = {}) {
  const periodId = randomUUID();
  const groupId = kind === 'group' ? randomUUID() : null;
  const batchId = kind === 'batch' ? randomUUID() : null;
  const made = [];
  for (const o of orders) {
    const parentId = o.parentId || randomUUID();
    const eid = 'test-' + randomUUID();
    const checkout = randomUUID();
    if (!o.parentId) {
      await pool.query('INSERT INTO parents(id,phone,name) VALUES ($1,$2,$3)', [parentId, 'p-' + eid, 'parent']);
    }
    await pool.query('INSERT INTO checkout_sessions(checkout_id,parent_id) VALUES ($1,$2)', [checkout, parentId]);
    const students = [];
    for (const st of o.students || [{ active: true }]) {
      const sid = randomUUID();
      await pool.query('INSERT INTO students(id,parent_id,name,is_active) VALUES ($1,$2,$3,$4)',
        [sid, parentId, st.name || 'student', st.active !== false]);
      await pool.query('INSERT INTO course_period_enrollments(course_period_id,student_id,status) VALUES ($1,$2,$3)',
        [periodId, sid, 'active']);
      students.push(sid);
    }
    await pool.query(
      `INSERT INTO admin_enrollments(id,status,checkout_id,parent_phone,students,group_order_id,enrollment_batch_id,
         period_number,total_sessions,used_sessions,final_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,6,0,1000)`,
      [eid, o.status, checkout, 'p-' + eid, ['n'], groupId, batchId]);
    if (groupId) {
      await pool.query('INSERT INTO group_order_members(group_order_id,parent_id,student_ids) VALUES ($1,$2,$3)',
        [groupId, parentId, students]);
    }
    made.push({ eid, parentId, students });
  }
  await pool.query(
    `INSERT INTO course_periods(id,admin_enrollment_id,group_order_id,enrollment_batch_id,coach_id,venue_id,checkin_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [periodId, made[0].eid, groupId, batchId, null, 'B', checkinMode]);
  return { periodId, orders: made };
}

(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await pool.query(`
      CREATE TABLE parents(id uuid PRIMARY KEY, phone text, name text, is_active boolean DEFAULT true, line_uid text);
      CREATE TABLE students(id uuid PRIMARY KEY,parent_id uuid,name text,is_active boolean DEFAULT true);
      CREATE TABLE coaches(id uuid PRIMARY KEY,name text);
      CREATE TABLE admin_venues(id text PRIMARY KEY,name text);
      CREATE TABLE venues(id text PRIMARY KEY,name text);
      CREATE TABLE checkout_sessions(checkout_id uuid PRIMARY KEY,parent_id uuid);
      CREATE TABLE group_order_members(group_order_id uuid,parent_id uuid,student_ids uuid[]);
      CREATE TABLE admin_enrollments(id text PRIMARY KEY,status text,checkout_id uuid,parent_phone text,
        students text[],group_order_id uuid,enrollment_batch_id uuid,period_number int DEFAULT 1,
        total_sessions int,used_sessions int,final_price numeric,updated_at timestamptz DEFAULT now());
      CREATE TABLE course_periods(id uuid PRIMARY KEY,admin_enrollment_id text,group_order_id uuid,enrollment_batch_id uuid,
        coach_id uuid,venue_id text,course_type int DEFAULT 1,period_number int DEFAULT 1,total_sessions int DEFAULT 6,
        used_sessions int DEFAULT 0,status text DEFAULT 'active',entitlement_state text DEFAULT 'ACTIVE',
        checkin_mode text DEFAULT 'self',expires_at date DEFAULT CURRENT_DATE+365,updated_at timestamptz DEFAULT now());
      CREATE TABLE course_period_enrollments(course_period_id uuid,student_id uuid,status text DEFAULT 'active',
        UNIQUE(course_period_id,student_id));
      CREATE TABLE course_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),course_period_id uuid,coach_id uuid,
        status text DEFAULT 'confirmed',scheduled_at timestamptz DEFAULT now(),completed_at timestamptz,
        cancelled_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
        created_via text,self_checkin_date date,duration_minutes int DEFAULT 60,session_deducted boolean DEFAULT false);
      CREATE TABLE checkin_records(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),course_session_id uuid,student_id uuid,
        checked_in_by_student_id uuid,checked_in_by_parent_id uuid,checked_in_source text,
        checked_in_at timestamptz DEFAULT now(),attendance_status text DEFAULT 'ATTENDED',
        UNIQUE(course_session_id,student_id));
      CREATE TABLE coach_availability_slots(id uuid DEFAULT gen_random_uuid(),status text,booked_session_id uuid,updated_at timestamptz);
    `);
    await pool.query("INSERT INTO admin_venues(id,name) VALUES ('B','測試館')");
    await pool.query("INSERT INTO venues(id,name) VALUES ('B','測試館')");

    // ── T1：跨家庭共享課期，B 家小孩停學 ────────────────────────────────
    const shared = await makePeriod({
      kind: 'group',
      orders: [
        { status: 'confirmed', students: [{ name: 'A家小孩', active: true }] },
        { status: 'confirmed', students: [{ name: 'B家小孩', active: false }] },
      ],
    });
    const activeChild = shared.orders[0].students[0];
    const suspendedChild = shared.orders[1].students[0];

    await t('T1 名單排除停用學員，且與獨立重算一致', async () => {
      const want = await expectedActiveRoster(shared.periodId);
      const got = await inTx((c) => assertCourseEntitlement(c, shared.periodId));
      assert.deepEqual([...got].sort(), want);
      assert.ok(!got.includes(suspendedChild), '停用學員不該出現在名單裡');
      assert.ok(got.includes(activeChild), '正常學員必須留在名單裡');
    });

    await t('T1 指名停用學員 → 直接擋掉（不再是「放行後寫 0 筆」）', async () => {
      await inTx((c) => expectConflict(
        () => assertCourseEntitlement(c, shared.periodId, suspendedChild),
        'STUDENT_ENTITLEMENT_INACTIVE'));
    });

    await t('T1 入口實證：自助簽到路由對停用學員回 409，不是 201', async () => {
      const self = route('checkins', '/self');
      const r = await call(self, {
        parent: { id: shared.orders[1].parentId, phone: 'p' },
        body: { course_period_id: shared.periodId, student_ids: [suspendedChild] },
      });
      assert.equal(r.status, 409, '狀態碼 ' + r.status + ' body=' + JSON.stringify(r.body));
      assert.equal(r.body.code, 'STUDENT_ENTITLEMENT_INACTIVE');
      const wrote = await pool.query(
        `SELECT count(*)::int n FROM checkin_records WHERE student_id = $1`, [suspendedChild]);
      assert.equal(wrote.rows[0].n, 0, '被擋下來就不該留下任何出席紀錄');
      const ghost = await pool.query(
        `SELECT count(*)::int n FROM course_sessions WHERE course_period_id = $1`, [shared.periodId]);
      assert.equal(ghost.rows[0].n, 0, '被擋下來就不該補建幽靈課堂');
    });

    await t('T1 例外：單人課期指名停用學員仍放行（櫃檯手動扣課的既有語意）', async () => {
      const solo = await makePeriod({ orders: [{ status: 'confirmed', students: [{ active: false }] }] });
      const only = solo.orders[0].students[0];
      const got = await inTx((c) => assertCourseEntitlement(c, solo.periodId, only));
      assert.deepEqual(got, [only], '指名的停用學員必須保留，否則補登出席會變成無出席的幽靈 session');
      // 要嚴格語意的呼叫端可以自己關掉這個例外
      await inTx((c) => expectConflict(
        () => assertCourseEntitlement(c, solo.periodId, only, { requireActiveStudent: true }),
        'STUDENT_ENTITLEMENT_INACTIVE'));
    });

    // ── T2：解析不到來源報名 ────────────────────────────────────────────
    await t('T2 來源報名解析不到 → fail-closed，不再放行', async () => {
      const orphan = await makePeriod();
      await pool.query('DELETE FROM admin_enrollments WHERE id = $1', [orphan.orders[0].eid]);
      await inTx((c) => expectConflict(
        () => assertCourseEntitlement(c, orphan.periodId),
        'ENROLLMENT_SOURCE_UNRESOLVED'));
    });

    // ── T4：家庭共班部分退款 ────────────────────────────────────────────
    await t('T4 家庭共班部分退款 → 人工覆核，不是把付費的兄弟也擋成已退費', async () => {
      const batch = await makePeriod({
        kind: 'batch',
        orders: [{ status: 'refunded' }, { status: 'confirmed' }],
      });
      const e = await inTx((c) => expectConflict(
        () => assertCourseEntitlement(c, batch.periodId),
        'REFUND_IDENTITY_REVIEW_REQUIRED'));
      assert.ok(!/已退費或取消/.test(e.message), '訊息不能對還在付費的家庭說「你已退費」');
    });

    await t('T4 家庭共班全部退款 → 照舊擋掉（權益確實沒了）', async () => {
      const batch = await makePeriod({
        kind: 'batch',
        orders: [{ status: 'refunded' }, { status: 'refunded' }],
      });
      await inTx((c) => expectConflict(
        () => assertCourseEntitlement(c, batch.periodId),
        'ENROLLMENT_ENTITLEMENT_INACTIVE'));
    });

    await t('T4 單筆課期退款 → 照舊擋掉（沒有被新分支改掉）', async () => {
      const solo = await makePeriod({ orders: [{ status: 'refunded' }] });
      await inTx((c) => expectConflict(
        () => assertCourseEntitlement(c, solo.periodId),
        'ENROLLMENT_ENTITLEMENT_INACTIVE'));
    });

    await t('回歸：全員正常的共享課期照舊全數放行', async () => {
      const ok = await makePeriod({
        kind: 'group',
        orders: [
          { status: 'confirmed', students: [{ active: true }] },
          { status: 'confirmed', students: [{ active: true }] },
        ],
      });
      const want = await expectedActiveRoster(ok.periodId);
      const got = await inTx((c) => assertCourseEntitlement(c, ok.periodId));
      assert.deepEqual([...got].sort(), want);
      assert.equal(got.length, 2);
    });

    // ---- 並行：停學與自助簽到互撞 ----
    await t('並行：簽到進行中把學員停學 → 出席只寫給仍有效的學員', async () => {
      const race = await makePeriod({
        kind: 'group',
        orders: [
          { status: 'confirmed', students: [{ name: '照簽的', active: true }] },
          { status: 'confirmed', students: [{ name: '被停學的', active: true }] },
        ],
      });
      const keep = race.orders[0].students[0];
      const drop = race.orders[1].students[0];

      // tx1 先把 drop 停學但不 commit —— 佔住 students 那一列的寫鎖。
      const susp = await other.connect();
      await susp.query('BEGIN');
      await susp.query('UPDATE students SET is_active = FALSE WHERE id = $1', [drop]);

      // 同時打自助簽到。路由的 activeParticipants 有 FOR SHARE OF cpe, s，
      // 會卡在 tx1 的寫鎖上；tx1 commit 後才往下走，看到的是已提交的結果。
      const self = route('checkins', '/self');
      const checkin = call(self, {
        parent: { id: race.orders[0].parentId, phone: 'p' },
        body: { course_period_id: race.periodId, student_ids: [keep] },
      });
      await new Promise((r) => setTimeout(r, 400));
      await susp.query('COMMIT');
      susp.release();

      const r = await checkin;
      assert.ok(r.status === 200 || r.status === 201, '正常學員的簽到不該被牽連：' + JSON.stringify(r.body));
      const wrote = await pool.query(
        `SELECT cr.student_id FROM checkin_records cr
           JOIN course_sessions cs ON cs.id = cr.course_session_id
          WHERE cs.course_period_id = $1 ORDER BY cr.student_id`, [race.periodId]);
      const ids = wrote.rows.map((x) => x.student_id);
      assert.ok(ids.includes(keep), '仍有效的學員必須拿到出席');
      assert.ok(!ids.includes(drop), '已提交停學的學員不該拿到出席（實際：' + ids.join(',') + '）');
    });

    // ---- 重送：被擋掉的請求重複送 ----
    await t('重送：被擋掉的請求送兩次都 409，且零殘留', async () => {
      const self = route('checkins', '/self');
      const req = {
        parent: { id: shared.orders[1].parentId, phone: 'p' },
        body: { course_period_id: shared.periodId, student_ids: [suspendedChild] },
      };
      const a = await call(self, req);
      const b = await call(self, req);
      assert.equal(a.status, 409); assert.equal(b.status, 409);
      assert.equal(a.body.code, b.body.code, '重送要拿到同一個錯誤碼，不能變成模糊的 500');
      const n = await pool.query(
        `SELECT (SELECT count(*)::int FROM course_sessions WHERE course_period_id = $1) sessions,
                (SELECT count(*)::int FROM checkin_records cr JOIN course_sessions cs
                   ON cs.id = cr.course_session_id WHERE cs.course_period_id = $1) records`,
        [shared.periodId]);
      assert.deepEqual(n.rows[0], { sessions: 0, records: 0 }, '兩次都被擋，不該有任何課堂或出席殘留');
    });

    // ---- 故障：守門拋錯後交易必須乾淨 ----
    await t('故障：守門拋 409 後交易回滾，used_sessions 不動', async () => {
      const solo = await makePeriod({ orders: [{ status: 'refunded' }] });
      const before = (await pool.query('SELECT used_sessions FROM course_periods WHERE id = $1',
        [solo.periodId])).rows[0].used_sessions;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE course_periods SET used_sessions = used_sessions + 1 WHERE id = $1', [solo.periodId]);
        await assertCourseEntitlement(client, solo.periodId).then(
          () => { throw new Error('should have thrown'); },
          async (e) => { assert.equal(e.code, 'ENROLLMENT_ENTITLEMENT_INACTIVE'); await client.query('ROLLBACK'); });
      } finally { client.release(); }
      const after = (await pool.query('SELECT used_sessions FROM course_periods WHERE id = $1',
        [solo.periodId])).rows[0].used_sessions;
      assert.equal(after, before, '守門擋下來之後，同交易的扣堂必須跟著回滾');
    });

    // ---- 預約制簽到：停用學員不得「扣了堂卻沒有出席」 ----
    // 2026-09-22 在隔離環境重現過的既有缺陷：路由先 COMMIT（課堂標 completed、
    // session_deducted=TRUE），之後才讀 ins.rows[0].id 撞 undefined 拋 500。
    // 出席一筆都沒寫、堂數卻扣掉、家長看到錯誤。這支就是那個缺陷的迴歸鎖。
    await t('預約制：停用學員回 409，不扣堂、不留幽靈出席', async () => {
      const solo = await makePeriod({
        checkinMode: 'booking',
        orders: [{ status: 'confirmed', students: [{ name: '停用的', active: false }] }],
      });
      const sid = solo.orders[0].students[0];
      const sessionId = await makeSession(solo.periodId);

      const post = route('checkins', '/');
      const r = await call(post, {
        parent: { id: solo.orders[0].parentId, phone: 'p' },
        body: { sessionId, studentId: sid },
      });
      assert.equal(r.status, 409, '狀態碼 ' + r.status + ' body=' + JSON.stringify(r.body));
      assert.equal(r.body.code, 'STUDENT_ENTITLEMENT_INACTIVE');

      const after = (await pool.query(
        `SELECT status, session_deducted FROM course_sessions WHERE id = $1`, [sessionId])).rows[0];
      assert.equal(after.status, 'confirmed', '被擋下來的課堂不該被標成 completed');
      assert.equal(after.session_deducted, false, '被擋下來就不該扣堂（這正是原本的缺陷）');
      const recs = (await pool.query(
        `SELECT count(*)::int n FROM checkin_records WHERE course_session_id = $1`, [sessionId])).rows[0].n;
      assert.equal(recs, 0, '不該留下任何出席紀錄');
    });

    await t('預約制：正常學員照舊簽得進去（確認守門沒擋錯人）', async () => {
      const solo = await makePeriod({
        checkinMode: 'booking',
        orders: [{ status: 'confirmed', students: [{ name: '正常的', active: true }] }],
      });
      const sid = solo.orders[0].students[0];
      const sessionId = await makeSession(solo.periodId);

      const post = route('checkins', '/');
      const r = await call(post, {
        parent: { id: solo.orders[0].parentId, phone: 'p' },
        body: { sessionId, studentId: sid },
      });
      assert.ok(r.status === 200 || r.status === 201, '正常學員被擋了：' + r.status + ' ' + JSON.stringify(r.body));
      const after = (await pool.query(
        `SELECT status, session_deducted FROM course_sessions WHERE id = $1`, [sessionId])).rows[0];
      assert.equal(after.status, 'completed');
      assert.equal(after.session_deducted, true);
      const recs = (await pool.query(
        `SELECT student_id FROM checkin_records WHERE course_session_id = $1`, [sessionId])).rows;
      assert.deepEqual(recs.map((x) => x.student_id), [sid], '出席必須正好寫給這一位');
    });
    // ── 兄弟姊妹：一個在學一個停學，不能因此把整家擋掉 ────────────────────
    // 前端 SelfCheckinModal 已刻意移除勾選框，一律送出這位家長在本期的全部學員。
    // 正式庫 45% 的家長有 2 個以上小孩、54% 的 active 課期是「同一家長多個小孩
    // 在同一期」—— 整批拒絕等於「一個孩子停學，全家每天都簽不進去」。
    await t('自助簽到：兄弟一停一在學 → 在學的照樣簽得進去，回傳名單不含停學的', async () => {
      const fam = await makePeriod({
        orders: [{ status: 'confirmed', students: [
          { name: '在學的哥哥', active: true },
          { name: '停學的弟弟', active: false },
        ] }],
      });
      const [keep, drop] = fam.orders[0].students;
      const self = route('checkins', '/self');
      const r = await call(self, {
        parent: { id: fam.orders[0].parentId, phone: 'p' },
        // 前端會把兩個都送上來
        body: { course_period_id: fam.periodId, student_ids: [keep, drop] },
      });
      assert.ok(r.status === 200 || r.status === 201,
        '在學的兄弟被整家擋掉了：' + r.status + ' ' + JSON.stringify(r.body));
      assert.deepEqual(r.body.checked_in_students, ['在學的哥哥'],
        '回傳名單誤報了沒被寫入出席的停學學員：' + JSON.stringify(r.body.checked_in_students));
      const wrote = await pool.query(
        `SELECT s.name FROM checkin_records cr
           JOIN course_sessions cs ON cs.id = cr.course_session_id
           JOIN students s ON s.id = cr.student_id
          WHERE cs.course_period_id = $1 ORDER BY s.name`, [fam.periodId]);
      assert.deepEqual(wrote.rows.map((x) => x.name), ['在學的哥哥'],
        '出席寫錯人：' + JSON.stringify(wrote.rows.map((x) => x.name)));
    });

    await t('自助簽到：全家都停學 → 409，零寫入', async () => {
      const fam = await makePeriod({
        orders: [{ status: 'confirmed', students: [
          { name: '停學甲', active: false },
          { name: '停學乙', active: false },
        ] }],
      });
      const self = route('checkins', '/self');
      const r = await call(self, {
        parent: { id: fam.orders[0].parentId, phone: 'p' },
        body: { course_period_id: fam.periodId, student_ids: fam.orders[0].students },
      });
      assert.equal(r.status, 409, '狀態 ' + r.status + ' ' + JSON.stringify(r.body));
      assert.equal(r.body.code, 'STUDENT_ENTITLEMENT_INACTIVE');
      const n = await pool.query(
        `SELECT count(*)::int AS n FROM course_sessions WHERE course_period_id = $1`, [fam.periodId]);
      assert.equal(n.rows[0].n, 0, '被擋下來就不該補建課堂');
    });

    await t('自助簽到：送了別家小孩的 id → 仍然 403（越權防線沒被收斂弱化）', async () => {
      const shared2 = await makePeriod({
        kind: 'group',
        orders: [
          { status: 'confirmed', students: [{ name: 'A家', active: true }] },
          { status: 'confirmed', students: [{ name: 'B家', active: true }] },
        ],
      });
      const mine = shared2.orders[0].students[0];
      const others = shared2.orders[1].students[0];
      const self = route('checkins', '/self');
      const r = await call(self, {
        parent: { id: shared2.orders[0].parentId, phone: 'p' },
        body: { course_period_id: shared2.periodId, student_ids: [mine, others] },
      });
      assert.equal(r.status, 403, '狀態 ' + r.status + ' ' + JSON.stringify(r.body));
      assert.equal(r.body.code, 'STUDENT_NOT_IN_PERIOD');
    });
    console.log(`\n${passed} 個測試全數通過`);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    await other.end();
    await admin.end();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
