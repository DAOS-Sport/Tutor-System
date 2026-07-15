/*
 * F-M02 route-lock integration test.
 *
 * Verifies the high-risk contract with isolated rows that are removed in finally:
 * - staff/manager venue_ids scope is fail-closed for mixed-venue checkouts;
 * - a multi-venue staff can see the complete checkout only when every child is authorized;
 * - direct URL / venueId manipulation cannot reveal another venue;
 * - cancel requires a reason and persists operator/reason/original state exactly once.
 *
 * Run: NODE_PATH=server/node_modules node tests/e2e/admin_checkout_scope_cancel.js
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const bcrypt = require('../../server/node_modules/bcryptjs');
const { signToken } = require('../../server/middlewares/adminAuth');
const checkoutRouter = require('../../server/routes/admin/checkouts');
const authRouter = require('../../server/routes/admin/auth');
const { assert, step } = require('./_lib');

function makeToken({ role, venueIds, name }) {
  return signToken({
    sub: `E2E-${role}-${randomUUID()}`,
    username: `e2e-${role}`,
    name,
    role,
    venue_id: venueIds[0] || null,
    venue_ids: venueIds,
  });
}

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin/auth', authRouter);
  app.use('/api/admin/checkouts', checkoutRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[admin_checkout_scope_cancel test route]', err);
    res.status(500).json({ error: err.message || 'test route error' });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function call(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let data;
  try { data = await res.json(); } catch { data = await res.text(); }
  return { status: res.status, data };
}

function idsFromList(data) {
  return (Array.isArray(data) ? data : []).map((row) => row.checkout_id);
}

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for this integration test');

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const routeServer = await startRouteServer();
  const suffix = Date.now().toString(36).slice(-6);
  const venueB = `T${suffix}B`;
  const venueC = `T${suffix}C`;
  const venueX = `T${suffix}X`;
  const ids = {
    ownedB: randomUUID(),
    mixed: randomUUID(),
    onlyC: randomUUID(),
    onlyX: randomUUID(),
    cancelB: randomUUID(),
    managerStaff: `E2E-M-${suffix}`,
    managerUser: `E2E-U-${suffix}`,
  };
  const checkoutIds = [ids.ownedB, ids.mixed, ids.onlyC, ids.onlyX, ids.cancelB];
  const enrollmentIds = [];
  const managerUsername = `e2e-manager-${suffix}`;

  const staffB = makeToken({ role: 'staff', venueIds: [venueB], name: 'E2E 櫃檯 B' });
  const staffBC = makeToken({ role: 'staff', venueIds: [venueB, venueC], name: 'E2E 多館櫃檯' });
  const admin = makeToken({ role: 'admin', venueIds: [], name: 'E2E 管理員' });
  const unauthorizedRole = makeToken({ role: 'coach', venueIds: [venueB], name: 'E2E 教練' });

  async function addEnrollment(checkoutId, venueId, label) {
    const id = `E2E-FM02-${suffix}-${label}-${enrollmentIds.length + 1}`;
    enrollmentIds.push(id);
    await pg.query(
      `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, coach, venue_id, course_type,
          original_price, final_price, status, submitted_at, checkout_id)
       VALUES ($1, $2, $3, ARRAY[$4]::text[], $5, $6, 1, 1000, 1000,
               'pending_payment', NOW(), $7)`,
      [id, `E2E 家長 ${label}`, `09${String(Date.now()).slice(-8)}`, `E2E 學員 ${label}`, 'E2E 教練', venueId, checkoutId]
    );
  }

  try {
    await pg.connect();
    step('F-M02 setup: isolated venues and pending checkouts');
    await pg.query(`INSERT INTO venues (id, name, is_active) VALUES ($1, $2, TRUE), ($3, $4, TRUE), ($5, $6, TRUE)`, [
      venueB, 'E2E 場館 B', venueC, 'E2E 場館 C', venueX, 'E2E 場館 X',
    ]);
    await pg.query(`INSERT INTO admin_venues (id, code, name, is_active) VALUES ($1, $1, $2, TRUE), ($3, $3, $4, TRUE), ($5, $5, $6, TRUE)`, [
      venueB, 'E2E 場館 B', venueC, 'E2E 場館 C', venueX, 'E2E 場館 X',
    ]);
    const managerHash = await bcrypt.hash('e2e-manager-password', 8);
    await pg.query(
      `INSERT INTO admin_staff (id, name, role, venue_id, phone, active)
       VALUES ($1, 'E2E 主管 B', 'manager', $2, '0900000000', TRUE)`,
      [ids.managerStaff, venueB]
    );
    await pg.query(
      `INSERT INTO admin_staff_venues (staff_id, venue_id) VALUES ($1, $2), ($1, $3)`,
      [ids.managerStaff, venueB, venueC]
    );
    await pg.query(
      `INSERT INTO admin_users (id, username, password_hash, name, role, venue_id, is_active, staff_id)
       VALUES ($1, $2, $3, 'E2E 主管 B', 'manager', $4, TRUE, $5)`,
      [ids.managerUser, managerUsername, managerHash, venueB, ids.managerStaff]
    );
    for (const checkoutId of checkoutIds) {
      await pg.query(
        `INSERT INTO checkout_sessions (checkout_id, total_amount, payment_status, current_route_state)
         VALUES ($1, 1000, 'pending_payment', 'pending_payment')`,
        [checkoutId]
      );
    }
    await addEnrollment(ids.ownedB, venueB, 'owned');
    await addEnrollment(ids.mixed, venueB, 'mixed-b');
    await addEnrollment(ids.mixed, venueC, 'mixed-c');
    await addEnrollment(ids.onlyC, venueC, 'only-c');
    await addEnrollment(ids.onlyX, venueX, 'only-x');
    await addEnrollment(ids.cancelB, venueB, 'cancel');

    step('authentication rejects anonymous and non-backoffice tokens');
    const anonymous = await call(routeServer.base, 'GET', '/api/admin/checkouts?status=pending');
    assert(anonymous.status === 401, `未登入不得讀 F-M02（${anonymous.status}）`);
    const coach = await call(routeServer.base, 'GET', '/api/admin/checkouts?status=pending', { token: unauthorizedRole });
    assert(coach.status === 403, `非後台角色不得讀 F-M02（${coach.status}）`);

    step('single-venue staff and manager cannot list a mixed or foreign checkout');
    const staffList = await call(routeServer.base, 'GET', '/api/admin/checkouts?status=pending', { token: staffB });
    assert(staffList.status === 200, `單館櫃檯清單回 200，實際 ${staffList.status}`);
    const staffIds = idsFromList(staffList.data);
    assert(staffIds.includes(ids.ownedB), '單館櫃檯可看見完全屬於 B 的 checkout');
    assert(staffIds.includes(ids.cancelB), '單館櫃檯可看見完全屬於 B 的待取消 checkout');
    assert(!staffIds.includes(ids.mixed), '單館櫃檯看不到含 C 子單的 mixed checkout');
    assert(!staffIds.includes(ids.onlyC), '單館櫃檯看不到 C checkout');
    assert(!staffIds.includes(ids.onlyX), '單館櫃檯看不到 X checkout');

    const managerLogin = await call(routeServer.base, 'POST', '/api/admin/auth/login', {
      body: { username: managerUsername, password: 'e2e-manager-password' },
    });
    assert(managerLogin.status === 200 && managerLogin.data?.token && managerLogin.data?.role === 'manager', '主管可登入且取得 manager token');
    assert((managerLogin.data?.venue_ids || []).includes(venueB) && (managerLogin.data?.venue_ids || []).includes(venueC), '主管登入 token 帶完整 venue_ids');
    const managerList = await call(routeServer.base, 'GET', '/api/admin/checkouts?status=pending', { token: managerLogin.data.token });
    assert(managerList.status === 200, `主管 token 經共用裁判可載入 F-M02，實際 ${managerList.status}`);
    const managerIds = idsFromList(managerList.data);
    assert(managerIds.includes(ids.ownedB) && managerIds.includes(ids.mixed) && managerIds.includes(ids.onlyC) && !managerIds.includes(ids.onlyX), '主管仍依 venue_ids 受限，不被提升為全館');
    const adminList = await call(routeServer.base, 'GET', '/api/admin/checkouts?status=pending', { token: admin });
    const adminIds = idsFromList(adminList.data);
    assert(adminList.status === 200 && adminIds.includes(ids.ownedB) && adminIds.includes(ids.mixed) && adminIds.includes(ids.onlyC) && adminIds.includes(ids.onlyX), '管理員依既有規則可跨館檢視全部 checkout');

    step('multi-venue scope sees the complete mixed checkout and stable venue contract');
    const multiList = await call(routeServer.base, 'GET', '/api/admin/checkouts?status=pending', { token: staffBC });
    assert(multiList.status === 200, `多館櫃檯清單回 200，實際 ${multiList.status}`);
    const mixed = (multiList.data || []).find((row) => row.checkout_id === ids.mixed);
    assert(!!mixed, '多館櫃檯可看見 B+C mixed checkout');
    assert(!idsFromList(multiList.data).includes(ids.onlyX), '多館櫃檯仍看不到 scope 外 X checkout');
    assert((mixed.sub_orders || []).every((row) => row.venue_id && row.venue_name), '每筆子訂單都有穩定 venue_id / venue_name');
    assert((mixed.venues || []).length === 2, 'checkout 回應有兩筆明確場館資料，不使用第一筆代替');

    step('direct URL/query tampering remains fail-closed');
    const foreignFilter = await call(routeServer.base, 'GET', `/api/admin/checkouts?status=pending&venueId=${encodeURIComponent(venueX)}`, { token: staffB });
    assert(foreignFilter.status === 200 && idsFromList(foreignFilter.data).length === 0, '單館櫃檯指定未授權 venueId 只能得到空集合');
    const foreignGet = await call(routeServer.base, 'GET', `/api/admin/checkouts/${ids.onlyX}`, { token: staffB });
    assert(foreignGet.status === 403, `單館櫃檯直接讀 X checkout 被拒絕（${foreignGet.status}）`);
    const mixedGet = await call(routeServer.base, 'GET', `/api/admin/checkouts/${ids.mixed}`, { token: staffB });
    assert(mixedGet.status === 403, `單館櫃檯直接讀 mixed checkout 也被拒絕（${mixedGet.status}）`);
    const mixedCancel = await call(routeServer.base, 'POST', `/api/admin/checkouts/${ids.mixed}/cancel`, {
      token: staffB,
      body: { reason: 'E2E unauthorized should fail' },
    });
    assert(mixedCancel.status === 403, `單館櫃檯不可取消 mixed checkout（${mixedCancel.status}）`);

    step('cancel requires reason, persists audit, and disappears from pending only after success');
    const noReason = await call(routeServer.base, 'POST', `/api/admin/checkouts/${ids.cancelB}/cancel`, { token: staffB, body: {} });
    assert(noReason.status === 400, `未填取消原因被拒絕（${noReason.status}）`);
    const cancel = await call(routeServer.base, 'POST', `/api/admin/checkouts/${ids.cancelB}/cancel`, {
      token: staffB,
      body: { reason: 'E2E 場館測試取消', by: '偽造操作者' },
    });
    assert(cancel.status === 200 && cancel.data?.payment_status === 'cancelled', '授權櫃檯取消成功且回傳正式 cancelled');
    const state = await pg.query(
      `SELECT payment_status, current_route_state, archive_state, cancelled_by,
              cancelled_by_user_id, cancelled_at, cancellation_reason, audit_log
         FROM checkout_sessions WHERE checkout_id = $1`,
      [ids.cancelB]
    );
    assert(state.rows[0]?.payment_status === 'cancelled'
      && state.rows[0]?.current_route_state === 'cancelled'
      && state.rows[0]?.archive_state === 'SYSTEM_CANCELLED', 'checkout 進入 SYSTEM_CANCELLED，未 hard delete');
    assert(state.rows[0]?.cancelled_by === 'E2E 櫃檯 B' && state.rows[0]?.cancelled_at
      && state.rows[0]?.cancellation_reason === 'E2E 場館測試取消', '取消欄位保存 actor/time/reason');
    const auditLog = Array.isArray(state.rows[0]?.audit_log) ? state.rows[0].audit_log : JSON.parse(state.rows[0]?.audit_log || '[]');
    const audit = auditLog[auditLog.length - 1] || {};
    assert(audit.reason === 'E2E 場館測試取消' && audit.from_payment_status === 'pending_payment' && audit.by === 'E2E 櫃檯 B', 'checkout audit 有原因、原始狀態與真實操作者（忽略偽造 by）');
    const child = await pg.query(
      `SELECT ae.status, al.reason, al.action
         FROM admin_enrollments ae
         LEFT JOIN LATERAL (
           SELECT reason, action FROM admin_enrollment_audit_logs
            WHERE enrollment_id = ae.id ORDER BY id DESC LIMIT 1
         ) al ON TRUE
        WHERE ae.checkout_id = $1`,
      [ids.cancelB]
    );
    assert(child.rows.length === 1 && child.rows[0].status === 'cancelled' && child.rows[0].reason === 'E2E 場館測試取消' && /原始狀態：pending_payment/.test(child.rows[0].action || ''), '子訂單保留 cancelled 與可追查稽核');
    const afterList = await call(routeServer.base, 'GET', '/api/admin/checkouts?status=pending', { token: staffB });
    assert(!idsFromList(afterList.data).includes(ids.cancelB), '取消成功後不再出現在 pending F-M02');
    const repeated = await call(routeServer.base, 'POST', `/api/admin/checkouts/${ids.cancelB}/cancel`, {
      token: staffB,
      body: { reason: 'E2E second click' },
    });
    assert(repeated.status === 200 && repeated.data?.idempotent === true, `重複取消冪等回第一次結果（${repeated.status}）`);
    const archived = await call(routeServer.base, 'POST', `/api/admin/checkouts/${ids.cancelB}/archive`, {
      token: managerLogin.data.token,
      body: {},
    });
    assert(archived.status === 200 && archived.data?.archive_state === 'ARCHIVED', '主管可將 SYSTEM_CANCELLED 歸檔');
    const archivedAgain = await call(routeServer.base, 'POST', `/api/admin/checkouts/${ids.cancelB}/archive`, {
      token: managerLogin.data.token,
      body: {},
    });
    assert(archivedAgain.status === 200 && archivedAgain.data?.idempotent === true, '重複歸檔冪等');
    const archivedList = await call(routeServer.base, 'GET', '/api/admin/checkouts?status=cancelled&archiveState=ARCHIVED', { token: managerLogin.data.token });
    assert(idsFromList(archivedList.data).includes(ids.cancelB), '已取消／已歸檔篩選可查回付款單');
  } finally {
    await pg.query(`DELETE FROM admin_enrollments WHERE id = ANY($1::text[])`, [enrollmentIds]).catch(() => {});
    await pg.query(`DELETE FROM checkout_sessions WHERE checkout_id = ANY($1::uuid[])`, [checkoutIds]).catch(() => {});
    await pg.query(`DELETE FROM admin_users WHERE id = $1`, [ids.managerUser]).catch(() => {});
    await pg.query(`DELETE FROM admin_staff_venues WHERE staff_id = $1`, [ids.managerStaff]).catch(() => {});
    await pg.query(`DELETE FROM admin_staff WHERE id = $1`, [ids.managerStaff]).catch(() => {});
    await pg.query(`DELETE FROM admin_venues WHERE id = ANY($1::text[])`, [[venueB, venueC, venueX]]).catch(() => {});
    await pg.query(`DELETE FROM venues WHERE id = ANY($1::text[])`, [[venueB, venueC, venueX]]).catch(() => {});
    await pg.end().catch(() => {});
    await routeServer.close().catch(() => {});
  }
  step('F-M02 scope/cancel route-lock done');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
