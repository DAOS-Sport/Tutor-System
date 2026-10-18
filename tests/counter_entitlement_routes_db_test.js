'use strict';
// 櫃檯與家長端入口對「停用學員」的行為契約（真實路由 + 真實 public schema）。
//
// 為什麼不用獨立 schema：admin/manualDeductions.js 與 admin/sessions.js 會碰到
// 十幾張表的完整欄位（含多個 NOT NULL 無預設欄位），手刻 DDL 只會一直缺欄位。
// 這支直接用拋棄式測試庫的真實 public schema，自己建列、try/finally 自己刪乾淨。
//
// 守的契約（2026-09-22 逐一實測建立）：
//   A. 手動扣課 · 單人課期停用學員 → 201，出席仍要寫（既有且刻意的行為，
//      見 admin/manualDeductions.js 的 attendanceRoster 註解。不寫的話扣課會
//      變成沒有出席的幽靈 session）。
//   B. 手動扣課 · 共享課期停用學員 → 409，零寫入（避免出席落到別人家小孩）。
//   C. 櫃檯補簽到 · 共享課期 → 200，出席只寫給未停用的學員。
//   D. 櫃檯補簽到 · 單人課期唯一學員停用 → 409，零寫入。
//   E. 家長預約 · 單人課期唯一學員停用 → 409，槽位不被佔。
//   F. 家長預約 · 共享課期上自家學員停用 → 擋掉，不會借別家有效學員過關。
//   G. 手動扣課 · 共享課期全員停用 → 201，仍可補登（凍結令第 3 條）。
//
// 不起 HTTP server、不碰 LINE / Ragic、不讀寫任何正式資料。
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('../server/node_modules/pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), '必須是 loopback 的拋棄式測試庫');
assert.match(target.pathname, /^\/daos_(test|audit)/, '必須是 daos_test / daos_audit');

const pool = new Pool({ connectionString: url, options: '-c statement_timeout=20000' });

function stub(name, exports) {
  const id = require.resolve('../server/' + name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('models/db', { pool });
stub('services/checkinNotify', { notifyCheckinSafely() {} });
stub('services/websocket', { broadcastAdminEvent() {} });
stub('services/featureFlags', { getFeatureFlag: async () => ({ enabled: true }), flagAllowsPhone: () => true });

function route(mod, path) {
  const m = require('../server/routes/' + mod);
  const layer = m.stack.find((l) => l.route?.path === path && l.route.methods.post);
  assert.ok(layer, `找不到路由 POST ${path}`);
  return layer.route.stack.at(-1).handle;
}
async function call(handler, req) {
  let status = 200; let body;
  const res = { status(c) { status = c; return this; }, json(d) { body = d; return this; } };
  await handler({ params: {}, query: {}, get: () => '',
    adminUser: { role: 'admin', name: 'entitlement-test', sub: 'entitlement-test', username: 'entitlement-test' },
    ...req }, res);
  return { status, body };
}

let passed = 0;
const created = [];
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };

/** 建一個課期。students: [{active}]，第一位是 anchor（手動扣課點名的那一位）。 */
async function fixture({ students, checkinMode = 'booking' }) {
  const venue = (await pool.query(
    'SELECT id FROM admin_venues WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 1')).rows[0];
  const coach = (await pool.query(
    'SELECT id FROM coaches WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 1')).rows[0];
  assert.ok(venue && coach, '測試庫需要至少一個場館與一位教練（bootstrap 會種）');

  const rec = { periodId: randomUUID(), eid: 'entl-test-' + randomUUID(), parents: [], students: [], sessions: [], slots: [] };
  created.push(rec);
  const firstParent = randomUUID();
  const checkout = randomUUID();
  rec.parents.push(firstParent); rec.checkout = checkout;
  await pool.query('INSERT INTO parents(id,phone,name,is_active) VALUES ($1,$2,$3,TRUE)',
    [firstParent, 'entl-' + rec.eid.slice(-12), '測試家長']);
  await pool.query('INSERT INTO checkout_sessions(checkout_id,parent_id) VALUES ($1,$2)', [checkout, firstParent]);

  // 先把 admin_enrollments 與 course_periods 建起來 —— course_period_enrollments
  // 有外鍵指向 course_periods，順序顛倒會直接撞 FK。
  await pool.query(
    `INSERT INTO admin_enrollments
       (id,status,checkout_id,parent_name,parent_phone,coach,coach_id,students,venue_id,course_type,
        original_price,final_price,period_number,total_sessions,used_sessions,submitted_at)
     VALUES ($1,'confirmed',$2,$3,$4,$5,$6,$7,$8,1,1000,1000,1,6,0,NOW())`,
    [rec.eid, checkout, '測試家長', 'entl-phone', '測試教練', coach.id, ['測試學員'], venue.id]);
  await pool.query(
    `INSERT INTO course_periods
       (id,admin_enrollment_id,venue_id,coach_id,course_type,total_sessions,used_sessions,status,
        entitlement_state,checkin_mode,expires_at,original_price,final_price)
     VALUES ($1,$2,$3,$4,1,6,0,'active','ACTIVE',$5,CURRENT_DATE+365,1000,1000)`,
    [rec.periodId, rec.eid, venue.id, coach.id, checkinMode]);

  for (let i = 0; i < students.length; i += 1) {
    // 第二位以後各自屬於不同家長 —— 這樣才構成「跨家庭共享課期」。
    const parentId = i === 0 ? firstParent : randomUUID();
    if (i > 0) {
      rec.parents.push(parentId);
      await pool.query('INSERT INTO parents(id,phone,name,is_active) VALUES ($1,$2,$3,TRUE)',
        [parentId, 'entl2-' + randomUUID().slice(-12), '測試家長' + i]);
    }
    const sid = randomUUID();
    rec.students.push(sid);
    await pool.query('INSERT INTO students(id,parent_id,name,is_active) VALUES ($1,$2,$3,$4)',
      [sid, parentId, '測試學員' + i, students[i].active !== false]);
    await pool.query(
      "INSERT INTO course_period_enrollments(course_period_id,student_id,status) VALUES ($1,$2,'active')",
      [rec.periodId, sid]);
  }

  rec.coachId = coach.id;
  return rec;
}

async function addSlot(rec) {
  const id = randomUUID();
  rec.slots.push(id);
  const venue = (await pool.query('SELECT venue_id FROM course_periods WHERE id = $1', [rec.periodId])).rows[0].venue_id;
  await pool.query(
    `INSERT INTO coach_availability_slots(id,coach_id,venue_id,start_at,duration_minutes,status)
     VALUES ($1,$2,$3,NOW()+interval '2 days',60,'available')`, [id, rec.coachId, venue]);
  return id;
}

async function addSession(rec) {
  const id = randomUUID();
  rec.sessions.push(id);
  await pool.query(
    `INSERT INTO course_sessions(id,course_period_id,coach_id,status,scheduled_at,duration_minutes)
     VALUES ($1,$2,$3,'confirmed',NOW(),60)`, [id, rec.periodId, rec.coachId]);
  return id;
}

/** 獨立重算：這一期名單裡未停用的學員。不經過被測程式的任何邏輯。 */
async function expectedActive(periodId) {
  return (await pool.query(
    `SELECT cpe.student_id FROM course_period_enrollments cpe
       JOIN students s ON s.id = cpe.student_id
      WHERE cpe.course_period_id = $1 AND cpe.status = 'active'
        AND COALESCE(s.is_active, TRUE) = TRUE
      ORDER BY cpe.student_id`, [periodId])).rows.map((r) => r.student_id).sort();
}
async function attendance(periodId) {
  return (await pool.query(
    `SELECT cr.student_id FROM checkin_records cr
       JOIN course_sessions cs ON cs.id = cr.course_session_id
      WHERE cs.course_period_id = $1 ORDER BY cr.student_id`, [periodId])).rows.map((r) => r.student_id).sort();
}
async function periodUsed(periodId) {
  return (await pool.query('SELECT used_sessions FROM course_periods WHERE id = $1', [periodId])).rows[0].used_sessions;
}

(async () => {
  try {
    // ── A：手動扣課 · 單人課期停用學員 → 仍要成功且留下出席 ──────────────
    await t('手動扣課：單人課期停用學員仍可補登，且留下出席（既有語意）', async () => {
      const rec = await fixture({ students: [{ active: false }] });
      const anchor = rec.students[0];
      const r = await call(route('admin/manualDeductions', '/'), {
        body: { course_period_id: rec.periodId, student_id: anchor,
          reason: '補登已上完的課', request_id: randomUUID() },
      });
      assert.equal(r.status, 201, '狀態 ' + r.status + ' body=' + JSON.stringify(r.body));
      assert.deepEqual(await attendance(rec.periodId), [anchor],
        '停用的 anchor 必須留下出席，否則扣課會變成沒有出席的幽靈 session');
      assert.equal(await periodUsed(rec.periodId), 1, '應該扣掉 1 堂');
    });

    // ── B：手動扣課 · 共享課期停用學員 → 擋掉且零寫入 ────────────────────
    await t('手動扣課：共享課期的停用學員被擋，零寫入', async () => {
      const rec = await fixture({ students: [{ active: false }, { active: true }] });
      const suspended = rec.students[0];
      const r = await call(route('admin/manualDeductions', '/'), {
        body: { course_period_id: rec.periodId, student_id: suspended,
          reason: '補登已上完的課', request_id: randomUUID() },
      });
      assert.equal(r.status, 409, '狀態 ' + r.status + ' body=' + JSON.stringify(r.body));
      assert.equal(r.body.code, 'STUDENT_ENTITLEMENT_INACTIVE');
      assert.deepEqual(await attendance(rec.periodId), [], '被擋就不該有任何出席');
      assert.equal(await periodUsed(rec.periodId), 0, '被擋就不該扣堂');
    });

    // ── C：櫃檯補簽到 · 共享課期 → 只寫給未停用的學員 ────────────────────
    await t('櫃檯補簽到：共享課期只寫給未停用的學員，堂數仍只扣一次', async () => {
      const rec = await fixture({ students: [{ active: false }, { active: true }, { active: true }] });
      const sessionId = await addSession(rec);
      const want = await expectedActive(rec.periodId);
      assert.equal(want.length, 2, 'fixture 應該有 2 位有效學員');

      const r = await call(route('admin/sessions', '/:id/backfill-checkin'), {
        params: { id: sessionId }, body: { checkin_at: new Date().toISOString() },
      });
      assert.equal(r.status, 200, '狀態 ' + r.status + ' body=' + JSON.stringify(r.body));
      assert.deepEqual(await attendance(rec.periodId), want,
        '出席名單必須正好等於「未停用」的那幾位');
      assert.ok(!(await attendance(rec.periodId)).includes(rec.students[0]),
        '停用學員不該拿到出席');
      assert.equal(await periodUsed(rec.periodId), 1, '整班一堂＝共扣 1 堂');
    });

    // ── D：櫃檯補簽到 · 單人課期唯一學員停用 → 擋掉且零寫入 ──────────────
    await t('櫃檯補簽到：單人課期唯一學員停用 → 409，零寫入', async () => {
      const rec = await fixture({ students: [{ active: false }] });
      const sessionId = await addSession(rec);
      const r = await call(route('admin/sessions', '/:id/backfill-checkin'), {
        params: { id: sessionId }, body: { checkin_at: new Date().toISOString() },
      });
      assert.equal(r.status, 409, '狀態 ' + r.status + ' body=' + JSON.stringify(r.body));
      assert.equal(r.body.code, 'STUDENT_ENTITLEMENT_INACTIVE');
      assert.deepEqual(await attendance(rec.periodId), []);
      assert.equal(await periodUsed(rec.periodId), 0);
      const st = (await pool.query('SELECT status::text AS s, session_deducted FROM course_sessions WHERE id = $1',
        [sessionId])).rows[0];
      assert.equal(st.s, 'confirmed', '被擋的課堂不該被標 completed');
      assert.equal(st.session_deducted, false, '被擋的課堂不該被標扣堂');
    });

    // ── E／F：家長預約入口（POST /api/slots/:id/book）────────────────────
    await t('家長預約：單人課期唯一學員停用 → 409，槽位不被佔', async () => {
      const rec = await fixture({ students: [{ active: false }] });
      const slotId = await addSlot(rec);
      const r = await call(route('slots', '/:id/book'), {
        parent: { id: rec.parents[0], phone: 'p' },
        params: { id: slotId }, body: { course_period_id: rec.periodId },
      });
      assert.equal(r.status, 409, '狀態 ' + r.status + ' body=' + JSON.stringify(r.body));
      assert.equal(r.body.code, 'STUDENT_ENTITLEMENT_INACTIVE');
      const slot = (await pool.query(
        'SELECT status::text AS s, booked_session_id FROM coach_availability_slots WHERE id = $1', [slotId])).rows[0];
      assert.equal(slot.s, 'available', '被擋的預約不該把槽位標成 booked');
      assert.equal(slot.booked_session_id, null);
      assert.equal((await pool.query(
        'SELECT count(*)::int n FROM course_sessions WHERE course_period_id = $1', [rec.periodId])).rows[0].n, 0,
        '被擋的預約不該建課堂');
    });

    await t('家長預約：共享課期上自家學員停用 → 擋掉，不會借別家有效學員過關', async () => {
      const rec = await fixture({ students: [{ active: false }, { active: true }] });
      const slotId = await addSlot(rec);
      // 第一位屬於 parents[0]（停用），第二位屬於另一位家長（有效）。
      const r = await call(route('slots', '/:id/book'), {
        parent: { id: rec.parents[0], phone: 'p' },
        params: { id: slotId }, body: { course_period_id: rec.periodId },
      });
      assert.ok(r.status === 403 || r.status === 409,
        '應該被擋（403 或 409），實際 ' + r.status + ' ' + JSON.stringify(r.body));
      const slot = (await pool.query(
        'SELECT status::text AS s FROM coach_availability_slots WHERE id = $1', [slotId])).rows[0];
      assert.equal(slot.s, 'available');
      assert.equal((await pool.query(
        'SELECT count(*)::int n FROM course_sessions WHERE course_period_id = $1', [rec.periodId])).rows[0].n, 0);
    });
    // ── G：共享課期「全員停用」仍要能補登（凍結令第 3 條）────────────────
    // 共享課期不得被單獨加硬擋。名單裡還有人有效時擋掉停用學員是對的（案例 B），
    // 但全員都停用時沒有「別人家小孩」可以被錯寫，硬擋只會讓櫃檯補不了課。
    await t('手動扣課：共享課期全員停用時仍可補登（不對共享課期單獨加硬擋）', async () => {
      const rec = await fixture({ students: [{ active: false }, { active: false }] });
      const anchor = rec.students[0];
      const r = await call(route('admin/manualDeductions', '/'), {
        body: { course_period_id: rec.periodId, student_id: anchor,
          reason: '補登已上完的課', request_id: randomUUID() },
      });
      assert.equal(r.status, 201, '狀態 ' + r.status + ' body=' + JSON.stringify(r.body));
      assert.deepEqual(await attendance(rec.periodId), [anchor],
        '出席只記在櫃檯點名的那一位，不會憑空多寫另一位停用學員');
      assert.equal(await periodUsed(rec.periodId), 1, '整期共扣 1 堂');
    });
    console.log(`\n${passed} 個測試全數通過`);
  } finally {
    // 逐筆清掉自己建的列。順序照外鍵相依。
    for (const rec of created) {
      try {
        await pool.query(
          `DELETE FROM checkin_records WHERE course_session_id IN
             (SELECT id FROM course_sessions WHERE course_period_id = $1)`, [rec.periodId]);
        await pool.query('DELETE FROM manual_lesson_deductions WHERE course_period_id = $1', [rec.periodId]).catch(() => {});
        await pool.query('DELETE FROM lesson_deduction_reversals WHERE course_period_id = $1', [rec.periodId]).catch(() => {});
        if (rec.slots.length) await pool.query('UPDATE coach_availability_slots SET booked_session_id = NULL WHERE id = ANY($1::uuid[])', [rec.slots]);
        await pool.query('DELETE FROM course_sessions WHERE course_period_id = $1', [rec.periodId]);
        if (rec.slots.length) await pool.query('DELETE FROM coach_availability_slots WHERE id = ANY($1::uuid[])', [rec.slots]);
        await pool.query('DELETE FROM course_period_enrollments WHERE course_period_id = $1', [rec.periodId]);
        await pool.query('DELETE FROM course_periods WHERE id = $1', [rec.periodId]);
        await pool.query('DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id = $1', [rec.eid]).catch(() => {});
        await pool.query('DELETE FROM admin_enrollments WHERE id = $1', [rec.eid]);
        await pool.query('DELETE FROM checkout_sessions WHERE checkout_id = $1', [rec.checkout]);
        for (const s of rec.students) await pool.query('DELETE FROM students WHERE id = $1', [s]);
        for (const p of rec.parents) await pool.query('DELETE FROM parents WHERE id = $1', [p]);
      } catch (e) {
        console.error('清除 ' + rec.eid + ' 失敗：' + e.message);
        process.exitCode = 1;
      }
    }
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
