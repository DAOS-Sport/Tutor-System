'use strict';
// 家庭帳號（docs/family_accounts_spec_2026-09-23.md）的 DB 層契約：拋棄式測試庫的真實 public schema
// ＋真實路由 handler（略過登入 middleware，直接帶 req.parent／req.adminUser）。
//
// 守的契約（以案例家庭為原型：媽媽報名、孩子在 Ragic 掛媽媽；爸爸重複登記了同一個孩子）：
//   1. 開關開、還沒家庭 → 爸爸只看得到自己；個人頁提示「有重複的孩子」
//   2. 申請：生日不符 → 422 通用訊息、不洩漏資料、記次數
//   3. 申請：相符 → 201 審核中，帶上爸爸那份重複學員；媽媽收到通知
//   4. 同時只能一筆審核中
//   5. 櫃台核准 → 建家庭（擁有者媽媽）、爸爸加入、重複學員依 §9 停用並留學員稽核
//   6. 核准後：爸爸的範圍含媽媽；個人頁看得到媽媽名下的孩子（唯讀）
//   7. 家人的付款單看得到；陌生人仍 403
//   8. 家人的期末評鑑看得到
//   9. 擁有者不能自己退出；成員被移出 → 立刻只剩自己、付款單 403
//  10. 凍結 → 全家只剩自己；解凍恢復
//  11. 預先登記手機 → 對方註冊後自動加入，重複的孩子依 §9 處理
//  12. 開關關閉 → 就算有家庭也只剩自己
//  13. 申請次數：24 小時 5 次上限（含不符的）
//  14. 成員以 LINE userId 綁定：主帳號解綁 LINE → 自己只剩自己、個人頁提示重新綁定；同一支 LINE 重綁恢復；
//      換一支 LINE → 櫃台再加一次＝重新綁定；資料範圍不看別人的綁定（爸爸換 LINE，媽媽照樣看得到他的孩子）
//  15. 移除＝解綁 userId：清成 NULL、稽核只留雜湊；同一支 LINE 之後可以加入別的家庭
//  16. 預先登記的認領（A 最簡單版）：孩子身分證對、生日不對 → 不加入；沒綁 LINE → 不加入
//  17. 重複學員：沒開課但有未對帳訂單的那份不能被停用
//  18. 沒綁 LINE 的家長不能加入家庭（LINE_NOT_BOUND）
//
// 不起 HTTP server、不碰 Ragic、LINE 推播以 stub 攔截；所有資料 try/finally 自己刪乾淨。
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
const pushes = [];
stub('models/db', { pool });
stub('services/line', {
  async pushMessage(uid, messages, channel, opts) { pushes.push({ uid, text: messages[0]?.text, opts }); return { sent: true }; },
});
stub('services/lineRouting', { async resolveChannel() { return { channel: 'test-channel' }; } });

const familySchema = require('../server/bootstrap/familySchema');
const familyScope = require('../server/services/familyScope');
const familyProfile = require('../server/services/familyProfile');
const familyAdmin = require('../server/services/familyAdmin');
const evaluations = require('../server/services/evaluations');

function handler(mod, method, path) {
  const m = require('../server/routes/' + mod);
  const layer = m.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `找不到路由 ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}
async function call(h, req) {
  let status = 200; let body;
  const res = {
    status(c) { status = c; return this; },
    json(d) { body = d; return this; },
    set() { return this; },
  };
  await h({ params: {}, query: {}, body: {}, get: () => '', ...req }, res);
  await new Promise((r) => setTimeout(r, 60)); // 讓 COMMIT 後的通知跑完
  return { status, body };
}
const ADMIN = { role: 'admin', name: 'family-test', sub: 'family-test', username: 'family-test' };

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('PASS ' + name); };

const rnd = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const lineUid = () => 'U' + randomUUID().replace(/-/g, '');
const phone = () => '09' + rnd(8);
const idNo = (g = '1') => 'F' + g + rnd(8);

const parents = [];
const students = [];
const created = { periods: [], enrollments: [], checkouts: [] };

async function addParent(name) {
  const p = { id: randomUUID(), phone: phone(), name, line_uid: lineUid() };
  await pool.query(
    'INSERT INTO parents(id, phone, name, line_uid, is_active) VALUES ($1,$2,$3,$4,TRUE)',
    [p.id, p.phone, p.name, p.line_uid]);
  parents.push(p.id);
  return p;
}
async function addStudent(parentId, { name, idNumber, birth, ragic = false }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO students(id, parent_id, name, id_number, birth_date, is_active, ragic_record_id)
     VALUES ($1,$2,$3,$4,$5,TRUE,$6)`,
    [id, parentId, name, idNumber, birth, ragic ? 'fam-test-' + randomUUID().slice(0, 8) : null]);
  students.push(id);
  return id;
}

(async () => {
  let failed = false;
  try {
    await familySchema.bootstrap(pool); // 可重跑
    // 第二階段的訂單學員 id（bootstrap/admin.js ensureSchema 同一句；這支測試只跑 familySchema）
    await pool.query('ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS student_ids UUID[]');

    const venue = (await pool.query('SELECT id FROM admin_venues WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 1')).rows[0];
    const coach = (await pool.query('SELECT id FROM coaches WHERE COALESCE(is_active, TRUE) ORDER BY id LIMIT 1')).rows[0];
    assert.ok(venue && coach, '測試庫需要至少一個場館與一位教練（bootstrap 會種）');

    const mom = await addParent('測試媽媽');
    const dad = await addParent('測試爸爸');
    const stranger = await addParent('陌生人');
    const kidId = idNo('1');
    const kidA = await addStudent(mom.id, { name: '測試孩子', idNumber: kidId, birth: '2019-12-10', ragic: true });
    const kidDup = await addStudent(dad.id, { name: '測試孩子', idNumber: kidId, birth: '2026-08-16' });
    await addStudent(dad.id, { name: '爸爸的另一個孩子', idNumber: idNo('2'), birth: '2021-03-03', ragic: true });

    // 媽媽的訂單＋課期（孩子 A 在名單上）＋付款單
    const eid = 'fam-test-' + randomUUID();
    const checkoutId = randomUUID();
    const periodId = randomUUID();
    created.enrollments.push(eid); created.checkouts.push(checkoutId); created.periods.push(periodId);
    await pool.query('INSERT INTO checkout_sessions(checkout_id, parent_id) VALUES ($1,$2)', [checkoutId, mom.id]);
    await pool.query(
      `INSERT INTO admin_enrollments
         (id,status,checkout_id,parent_name,parent_phone,coach,coach_id,students,venue_id,course_type,
          original_price,final_price,period_number,total_sessions,used_sessions,submitted_at)
       VALUES ($1,'confirmed',$2,$3,$4,'測試教練',$5,$6,$7,1,1000,1000,1,6,0,NOW())`,
      [eid, checkoutId, mom.name, mom.phone, coach.id, ['測試孩子'], venue.id]);
    await pool.query(
      `INSERT INTO course_periods
         (id,admin_enrollment_id,venue_id,coach_id,course_type,total_sessions,used_sessions,status,
          entitlement_state,checkin_mode,expires_at,original_price,final_price)
       VALUES ($1,$2,$3,$4,1,6,0,'active','ACTIVE','booking',CURRENT_DATE+365,1000,1000)`,
      [periodId, eid, venue.id, coach.id]);
    await pool.query(
      "INSERT INTO course_period_enrollments(course_period_id, student_id, status) VALUES ($1,$2,'active')",
      [periodId, kidA]);
    await pool.query(
      'INSERT INTO course_evaluations(course_period_id, parent_id, coach_id) VALUES ($1,$2,$3)',
      [periodId, mom.id, coach.id]);

    const createRequest = handler('family', 'post', '/requests');
    const leave = handler('family', 'post', '/leave');
    const approve = handler('admin/families', 'post', '/requests/:id/approve');
    const suggestions = handler('admin/families', 'get', '/suggestions');
    const byParent = handler('admin/families', 'get', '/by-parent/:parentId');
    const revoke = handler('admin/families', 'post', '/:id/members/:parentId/revoke');
    const freeze = handler('admin/families', 'post', '/:id/freeze');
    const checkoutGet = handler('checkout', 'get', '/:checkoutId');

    process.env.FAMILY_ACCOUNTS_V1 = 'all';

    await t('1. 還沒家庭 → 爸爸只有自己；個人頁提示重複的孩子', async () => {
      const s = await familyScope.scopeFor(dad);
      assert.deepEqual(s.parentIds, [dad.id]);
      const block = await familyProfile.familyBlock(dad);
      assert.equal(block.family, null);
      assert.deepEqual(block.duplicates.map((d) => d.student_id), [kidDup]);
      const sug = await call(suggestions, { adminUser: ADMIN });
      assert.ok(sug.body.items.some((i) => [i.a.student_id, i.b.student_id].sort().join() === [kidA, kidDup].sort().join()),
        '家庭建議要列出這一對');
    });

    await t('2. 生日不符 → 422 通用訊息，不洩漏、記次數', async () => {
      const r = await call(createRequest, { parent: dad, body: { id_number: kidId, birth_date: '2019-01-01', relationship: 'father' } });
      assert.equal(r.status, 422);
      assert.equal(r.body.code, 'FAMILY_REQUEST_NOT_MATCHED');
      assert.deepEqual(Object.keys(r.body).sort(), ['code', 'error']);
      const n = (await pool.query('SELECT COUNT(*)::int n FROM family_join_attempts WHERE parent_id=$1 AND matched=FALSE', [dad.id])).rows[0].n;
      assert.equal(n, 1);
    });

    let requestId;
    await t('3. 相符 → 201 審核中、帶上重複學員；媽媽收到通知', async () => {
      pushes.length = 0;
      const r = await call(createRequest, { parent: dad, body: { id_number: kidId.toLowerCase(), birth_date: '2019-12-10', relationship: 'father' } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      requestId = r.body.request.id;
      const row = (await pool.query('SELECT * FROM family_join_requests WHERE id=$1', [requestId])).rows[0];
      assert.equal(row.status, 'pending');
      assert.equal(row.target_student_id, kidA);
      assert.equal(row.duplicate_student_id, kidDup);
      assert.ok(pushes.some((p) => p.uid === mom.line_uid && /申請加入您的家庭/.test(p.text)), '媽媽要收到通知');
      assert.ok(!pushes.some((p) => p.text.includes(dad.phone)), '通知不透露申請人電話');
    });

    await t('4. 同時只能一筆審核中', async () => {
      const r = await call(createRequest, { parent: dad, body: { id_number: kidId, birth_date: '2019-12-10', relationship: 'father' } });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'FAMILY_REQUEST_PENDING');
    });

    let familyId;
    await t('5. 櫃台核准 → 建家庭、爸爸加入、重複學員依 §9 停用並留稽核', async () => {
      pushes.length = 0;
      const r = await call(approve, { adminUser: ADMIN, params: { id: requestId } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      familyId = r.body.result.family_id;
      const members = (await pool.query(
        `SELECT parent_id, role, relationship FROM family_members WHERE family_id=$1 AND status='active' ORDER BY role`, [familyId])).rows;
      assert.deepEqual(members.map((m) => [m.parent_id, m.role]).sort(), [[dad.id, 'member'], [mom.id, 'owner']].sort());
      assert.equal(members.find((m) => m.parent_id === dad.id).relationship, 'father');
      assert.equal((await pool.query('SELECT is_active FROM students WHERE id=$1', [kidDup])).rows[0].is_active, false);
      assert.equal((await pool.query('SELECT is_active FROM students WHERE id=$1', [kidA])).rows[0].is_active, true);
      const sa = await pool.query(`SELECT 1 FROM student_audit_logs WHERE student_id=$1 AND note='family-merge-duplicate'`, [kidDup]);
      assert.equal(sa.rowCount, 1, '停用重複學員要留學員稽核');
      const logs = (await pool.query('SELECT action FROM family_audit_logs WHERE family_id=$1', [familyId])).rows.map((x) => x.action);
      for (const a of ['family_created', 'member_added', 'duplicate_resolved', 'request_approved']) assert.ok(logs.includes(a), a);
      assert.equal((await pool.query('SELECT status FROM family_join_requests WHERE id=$1', [requestId])).rows[0].status, 'approved');
      assert.ok(pushes.some((p) => p.uid === dad.line_uid && /申請已通過/.test(p.text)), '爸爸要收到核准通知');
    });

    await t('6. 核准後：爸爸的範圍含媽媽；個人頁看得到媽媽名下的孩子（唯讀）', async () => {
      const s = await familyScope.scopeFor(dad);
      assert.deepEqual([...s.parentIds].sort(), [dad.id, mom.id].sort());
      const block = await familyProfile.familyBlock(dad);
      assert.equal(block.family.role, 'member');
      assert.ok(block.family.students.some((k) => k.id === kidA && k.owner_parent_id === mom.id));
      assert.ok(block.family.students.every((k) => !('id_number' in k)), '家人的孩子不回身分證');
      assert.deepEqual(block.duplicates, []);
      const admin = await call(byParent, { adminUser: ADMIN, params: { parentId: dad.id } });
      assert.equal(admin.body.family.members.length, 2);
    });

    await t('7. 家人的付款單看得到；陌生人仍 403', async () => {
      assert.equal((await call(checkoutGet, { parent: dad, params: { checkoutId } })).status, 200);
      assert.equal((await call(checkoutGet, { parent: stranger, params: { checkoutId } })).status, 403);
    });

    await t('8. 家人的期末評鑑看得到', async () => {
      const list = await evaluations.listForParent(await familyScope.actingParentIds({ parent: dad }));
      assert.ok(list.some((e) => e.course_period_id === periodId));
      assert.equal((await evaluations.listForParent([stranger.id])).length, 0);
    });

    await t('9. 擁有者不能自己退出；成員被移出 → 立刻只剩自己', async () => {
      const selfLeave = await call(leave, { parent: mom });
      assert.equal(selfLeave.status, 409);
      assert.equal(selfLeave.body.code, 'OWNER_CANNOT_LEAVE');
      const r = await call(revoke, { adminUser: ADMIN, params: { id: familyId, parentId: dad.id }, body: { reason: '測試' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual((await familyScope.scopeFor(dad)).parentIds, [dad.id]);
      assert.equal((await call(checkoutGet, { parent: dad, params: { checkoutId } })).status, 403);
      // 重新加回來，給後面的測試用
      const back = await pool.connect();
      try {
        await back.query('BEGIN');
        await familyAdmin.addMember(back, { familyId, parentId: dad.id, relationship: 'father', actor: 'test' });
        await back.query('COMMIT');
      } finally { back.release(); }
      assert.equal((await familyScope.scopeFor(dad)).parentIds.length, 2);
    });

    await t('10. 凍結 → 全家只剩自己；解凍恢復', async () => {
      assert.equal((await call(freeze, { adminUser: ADMIN, params: { id: familyId }, body: { frozen: true } })).status, 200);
      assert.deepEqual((await familyScope.scopeFor(dad)).parentIds, [dad.id]);
      assert.deepEqual((await familyScope.scopeFor(mom)).parentIds, [mom.id]);
      assert.equal((await call(freeze, { adminUser: ADMIN, params: { id: familyId }, body: { frozen: false } })).status, 200);
      assert.equal((await familyScope.scopeFor(mom)).parentIds.length, 2);
    });

    await t('11. 預先登記手機 → 註冊後自動加入，重複的孩子依 §9 處理', async () => {
      const grandmaPhone = phone();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await familyAdmin.addPendingMember(c, { familyId, phone: grandmaPhone, relationship: 'grandmother', actor: 'test' });
        await c.query('COMMIT');
      } finally { c.release(); }
      // 奶奶註冊：照常要填孩子 → 她填了同一個孩子（沒進 Ragic、沒有課）
      const grandma = { id: randomUUID(), phone: grandmaPhone, name: '測試奶奶', line_uid: lineUid() };
      await pool.query('INSERT INTO parents(id, phone, name, line_uid, is_active) VALUES ($1,$2,$3,$4,TRUE)',
        [grandma.id, grandma.phone, grandma.name, grandma.line_uid]);
      parents.push(grandma.id);
      const grandmaDup = await addStudent(grandma.id, { name: '測試孩子', idNumber: kidId, birth: '2019-12-10' });
      const c2 = await pool.connect();
      let out;
      try {
        await c2.query('BEGIN');
        out = await familyAdmin.claimPendingForParent(c2, { parentId: grandma.id, phone: grandma.phone });
        await c2.query('COMMIT');
      } finally { c2.release(); }
      assert.equal(out.result.family_id, familyId);
      assert.equal((await pool.query(`SELECT relationship FROM family_members WHERE parent_id=$1 AND status='active'`, [grandma.id])).rows[0].relationship, 'grandmother');
      assert.equal((await pool.query('SELECT is_active FROM students WHERE id=$1', [grandmaDup])).rows[0].is_active, false);
      assert.equal((await pool.query('SELECT claimed_parent_id FROM family_pending_members WHERE phone_canonical=$1', [grandmaPhone])).rows[0].claimed_parent_id, grandma.id);
    });

    await t('12. 開關關閉 → 就算有家庭也只剩自己', async () => {
      delete process.env.FAMILY_ACCOUNTS_V1;
      const s = await familyScope.scopeFor(dad);
      assert.deepEqual(s.parentIds, [dad.id]);
      assert.equal(await familyProfile.familyBlock(dad), null);
      assert.equal((await call(checkoutGet, { parent: dad, params: { checkoutId } })).status, 403);
      process.env.FAMILY_ACCOUNTS_V1 = 'all';
    });

    await t('13. 申請次數：24 小時 5 次上限（含不符的）', async () => {
      for (let i = 0; i < 5; i += 1) {
        const r = await call(createRequest, { parent: stranger, body: { id_number: idNo('1'), birth_date: '2019-01-01', relationship: 'guardian' } });
        assert.equal(r.status, 422);
      }
      const blocked = await call(createRequest, { parent: stranger, body: { id_number: kidId, birth_date: '2019-12-10', relationship: 'guardian' } });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.code, 'FAMILY_REQUEST_TOO_MANY');
    });

    const tx = async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { c.release(); }
    };

    await t('14. 成員以 LINE userId 綁定：主帳號解綁／換綁 LINE 的效果', async () => {
      const row = (await pool.query(`SELECT line_uid FROM family_members WHERE parent_id=$1 AND status='active'`, [dad.id])).rows[0];
      assert.equal(row.line_uid, dad.line_uid, '加入時記下當下綁定的 userId');
      // 櫃台解除爸爸主帳號的 LINE（customerParents unbind-line 的效果）
      await pool.query('UPDATE parents SET line_uid = NULL WHERE id=$1', [dad.id]);
      assert.deepEqual((await familyScope.scopeFor(dad)).parentIds, [dad.id], '解綁後爸爸只剩自己');
      assert.equal((await familyProfile.familyBlock(dad)).rebind_required, true, '個人頁提示請櫃台重新綁定');
      assert.ok((await familyScope.scopeFor(mom)).parentIds.includes(dad.id), '資料範圍不看別人的綁定：媽媽照樣看得到爸爸名下的孩子');
      const rec = await familyScope.familyRecipients([mom.id]);
      assert.ok(!rec.some((r) => r.parent_id === dad.id), '綁定失效的家人不收家庭通知');
      // 同一支 LINE 重綁 → 自動恢復
      await pool.query('UPDATE parents SET line_uid = $2 WHERE id=$1', [dad.id, dad.line_uid]);
      assert.equal((await familyScope.scopeFor(dad)).parentIds.length, 3, '同一支 LINE 重綁就恢復（爸爸、媽媽、奶奶）');
      // 換一支 LINE → 失效，櫃台再加一次＝重新綁定
      const newUid = lineUid();
      await pool.query('UPDATE parents SET line_uid = $2 WHERE id=$1', [dad.id, newUid]);
      assert.deepEqual((await familyScope.scopeFor(dad)).parentIds, [dad.id]);
      const rebound = await tx((c) => familyAdmin.addMember(c, { familyId, parentId: dad.id, relationship: 'father', actor: 'test' }));
      assert.equal(rebound.result.rebound, true);
      assert.equal((await familyScope.scopeFor(dad)).parentIds.length, 3, '重新綁定後恢復');
      const log = (await pool.query(
        `SELECT detail FROM family_audit_logs WHERE family_id=$1 AND action='member_rebound' ORDER BY id DESC LIMIT 1`, [familyId])).rows[0];
      assert.ok(log && /^[0-9a-f]{64}$/.test(log.detail.new_uid_hash), '稽核記雜湊');
      assert.ok(!JSON.stringify(log.detail).includes(newUid), '稽核不存 userId 原文');
      dad.line_uid = newUid;
    });

    await t('15. 移除＝解綁 userId：清成 NULL、稽核只留雜湊；之後可以加入別的家庭', async () => {
      const r = await call(revoke, { adminUser: ADMIN, params: { id: familyId, parentId: dad.id }, body: { reason: '測試解綁' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = (await pool.query(
        `SELECT status, line_uid FROM family_members WHERE parent_id=$1 ORDER BY revoked_at DESC NULLS LAST LIMIT 1`, [dad.id])).rows[0];
      assert.equal(row.status, 'revoked');
      assert.equal(row.line_uid, null, '解綁後 userId 清空');
      const log = (await pool.query(
        `SELECT detail FROM family_audit_logs WHERE family_id=$1 AND action='member_revoked' ORDER BY id DESC LIMIT 1`, [familyId])).rows[0];
      assert.match(log.detail.uid_hash, /^[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(log.detail).includes(dad.line_uid));
      // 同一支 LINE 可以自己當擁有者開一個家庭（UNIQUE 放開了）
      const own = await tx((c) => familyAdmin.createFamily(c, { ownerParentId: dad.id, actor: 'test' }));
      assert.ok(own.result.id);
      // 收尾：把那個家庭拆掉，爸爸回到原家庭（給後面的測試用）
      await pool.query('DELETE FROM families WHERE id=$1', [own.result.id]);
      await tx((c) => familyAdmin.addMember(c, { familyId, parentId: dad.id, relationship: 'father', actor: 'test' }));
      assert.equal((await familyScope.scopeFor(dad)).parentIds.length, 3);
    });

    await t('16. 預先登記的認領（A）：生日不對、沒綁 LINE → 不加入', async () => {
      const addPending = (p) => tx((c) => familyAdmin.addPendingMember(c, { familyId, phone: p, relationship: 'guardian', actor: 'test' }));
      const claim = (who) => tx((c) => familyAdmin.claimPendingForParent(c, { parentId: who.id, phone: who.phone }));
      // 身分證對、生日不對
      const auntPhone = phone();
      await addPending(auntPhone);
      const aunt = { id: randomUUID(), phone: auntPhone, name: '測試阿姨', line_uid: lineUid() };
      await pool.query('INSERT INTO parents(id, phone, name, line_uid, is_active) VALUES ($1,$2,$3,$4,TRUE)', [aunt.id, aunt.phone, aunt.name, aunt.line_uid]);
      parents.push(aunt.id);
      await addStudent(aunt.id, { name: '測試孩子', idNumber: kidId, birth: '2019-12-11' });
      assert.equal(await claim(aunt), null, '生日不對不加入');
      assert.equal((await pool.query(`SELECT 1 FROM family_members WHERE parent_id=$1`, [aunt.id])).rowCount, 0);
      // 資料完全對，但還沒綁 LINE
      const uncPhone = phone();
      await addPending(uncPhone);
      const uncle = { id: randomUUID(), phone: uncPhone, name: '測試舅舅' };
      await pool.query('INSERT INTO parents(id, phone, name, is_active) VALUES ($1,$2,$3,TRUE)', [uncle.id, uncle.phone, uncle.name]);
      parents.push(uncle.id);
      await addStudent(uncle.id, { name: '測試孩子', idNumber: kidId, birth: '2019-12-10' });
      assert.equal(await claim(uncle), null, '沒綁 LINE 不加入');
      // 綁好 LINE、開個人頁 → 自動認領（個人頁是認領入口）
      await pool.query('UPDATE parents SET line_uid=$2 WHERE id=$1', [uncle.id, lineUid()]);
      const block = await familyProfile.familyBlock(uncle);
      assert.equal(block.family && block.family.id, familyId, '綁好 LINE 後打開個人頁就加入');
    });

    await t('17. 重複學員：沒開課但有未對帳訂單的那份不能被停用', async () => {
      const p1 = await addParent('重複測試甲');
      const p2 = await addParent('重複測試乙');
      const dupId = idNo('1');
      const ragicCopy = await addStudent(p1.id, { name: '重複孩子', idNumber: dupId, birth: '2018-05-05', ragic: true });
      const orderCopy = await addStudent(p2.id, { name: '重複孩子', idNumber: dupId, birth: '2018-05-05' });
      const eid2 = 'fam-test-' + randomUUID();
      created.enrollments.push(eid2);
      await pool.query(
        `INSERT INTO admin_enrollments
           (id,status,parent_name,parent_phone,coach,coach_id,students,venue_id,course_type,
            original_price,final_price,period_number,total_sessions,used_sessions,submitted_at,student_ids)
         VALUES ($1,'pending_payment',$2,$3,'測試教練',$4,$5,$6,1,1000,1000,1,6,0,NOW(),$7)`,
        [eid2, p2.name, p2.phone, coach.id, ['重複孩子'], venue.id, [orderCopy]]);
      const out = await tx((c) => familyAdmin.applySuggestion(c, {
        studentAId: ragicCopy, studentBId: orderCopy, memberRelationship: 'mother', actor: 'test', actorRole: 'admin' }));
      assert.notEqual(out.result.duplicate.action, 'deactivate', JSON.stringify(out.result.duplicate));
      assert.equal((await pool.query('SELECT is_active FROM students WHERE id=$1', [orderCopy])).rows[0].is_active, true,
        '有未對帳訂單的那份要留著（對帳時會綁到它）');
    });

    await t('18. 沒綁 LINE 的家長不能加入家庭', async () => {
      const noLine = { id: randomUUID(), phone: phone(), name: '沒綁LINE' };
      await pool.query('INSERT INTO parents(id, phone, name, is_active) VALUES ($1,$2,$3,TRUE)', [noLine.id, noLine.phone, noLine.name]);
      parents.push(noLine.id);
      const addMemberRoute = handler('admin/families', 'post', '/:id/members');
      const r = await call(addMemberRoute, { adminUser: ADMIN, params: { id: familyId }, body: { parent_id: noLine.id, relationship: 'guardian' } });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, 'LINE_NOT_BOUND');
    });
  } catch (err) {
    failed = true;
    console.error('FAIL', err && err.stack ? err.stack : err);
  } finally {
    delete process.env.FAMILY_ACCOUNTS_V1;
    const q = (sql, args) => pool.query(sql, args).catch((e) => console.warn('cleanup:', e.message));
    await q('DELETE FROM family_join_attempts WHERE parent_id = ANY($1::uuid[])', [parents]);
    await q('DELETE FROM family_join_requests WHERE applicant_parent_id = ANY($1::uuid[])', [parents]);
    await q(`DELETE FROM families WHERE id IN (SELECT family_id FROM family_members WHERE parent_id = ANY($1::uuid[]))
              OR owner_parent_id = ANY($1::uuid[])`, [parents]);
    await q('DELETE FROM course_evaluations WHERE course_period_id = ANY($1::uuid[])', [created.periods]);
    await q('DELETE FROM course_period_enrollments WHERE course_period_id = ANY($1::uuid[])', [created.periods]);
    await q('DELETE FROM course_periods WHERE id = ANY($1::uuid[])', [created.periods]);
    await q('DELETE FROM admin_enrollments WHERE id = ANY($1::text[])', [created.enrollments]);
    await q('DELETE FROM checkout_sessions WHERE checkout_id = ANY($1::uuid[])', [created.checkouts]);
    await q('DELETE FROM student_audit_logs WHERE student_id = ANY($1::uuid[])', [students]);
    await q('DELETE FROM students WHERE id = ANY($1::uuid[])', [students]);
    await q('DELETE FROM parents WHERE id = ANY($1::uuid[])', [parents]);
    await pool.end();
  }
  if (failed) {
    console.error(`family_accounts_db_test: FAILED（${passed} 項通過後中斷）`);
    process.exit(1);
  }
  console.log(`family_accounts_db_test: ${passed}/18 PASS`);
})();
