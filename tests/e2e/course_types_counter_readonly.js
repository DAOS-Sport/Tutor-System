/*
 * 課程需求：櫃台唯讀（2026-10-14，in-process 掛 router、拋棄式 PostgreSQL）：
 *   櫃台（staff）有「手動建檔」、沒有「課程需求管理」→ 讀得到本館課別與價格（手動建檔頁的組別下拉），
 *   新增、修改、刪除、異動紀錄一律 403；救生員兩個都沒有 → 讀取也 403；管理員照常。
 * 依 bootstrap 種下的預設角色權限（course-types 只給 admin；manual-enroll 給 admin／manager／staff）。
 */
const { randomUUID } = require('crypto');
const express = require('../../server/node_modules/express');
const { Client } = require('../../server/node_modules/pg');
const { signToken } = require('../../server/middlewares/adminAuth');
const courseTypesRouter = require('../../server/routes/admin/courseTypes');
const { assert, step } = require('./_lib');

async function startRouteServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin/course-types', courseTypesRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: 'test route failure' }));
  const server = await new Promise((resolve) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function call(base, method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  const route = await startRouteServer();
  await pg.connect();
  const tokenFor = (role) => signToken({ sub: `ct-readonly-${role}-${randomUUID()}`, username: `ct_${role}`, name: `課程需求唯讀測試 ${role}`, role, venue_ids: [] });

  try {
    const perms = (await pg.query(
      `SELECT role, array_agg(resource_key ORDER BY resource_key) AS keys
         FROM role_permissions WHERE role IN ('staff','lifeguard') GROUP BY role`)).rows;
    const keysOf = (role) => (perms.find((p) => p.role === role) || { keys: [] }).keys;
    assert(keysOf('staff').includes('manual-enroll') && !keysOf('staff').includes('course-types'),
      `前提：櫃台有手動建檔、沒有課程需求管理（${keysOf('staff').filter((k) => ['manual-enroll', 'course-types'].includes(k)).join(',')}）`);
    assert(!keysOf('lifeguard').some((k) => ['course-types', 'manual-enroll', 'enrollments'].includes(k)),
      '前提：救生員三項都沒有');
    const ref = (await pg.query(
      `SELECT v.id AS venue_id, c.course_type
         FROM venues v JOIN course_type_configs c ON c.pricing_zone_id = v.pricing_zone_id
        WHERE v.is_active = TRUE ORDER BY v.id, c.course_type LIMIT 1`)).rows[0];
    if (!ref) throw new Error('test database needs one active venue with course_type_configs');
    const before = (await pg.query(
      `SELECT count(*)::int AS n, max(updated_at) AS t FROM course_type_configs`)).rows[0];

    const staff = tokenFor('staff');
    step('C1 櫃台讀本館課程需求（手動建檔頁的組別下拉）→ 200，有資料');
    const list = await call(route.base, 'GET', `/api/admin/course-types?venue=${encodeURIComponent(ref.venue_id)}`, staff);
    assert(list.status === 200 && Array.isArray(list.data) && list.data.length > 0,
      `櫃台讀得到（${list.status}，${Array.isArray(list.data) ? list.data.length : 'n/a'} 筆）`);
    assert(list.data.some((row) => Number(row.course_type) === Number(ref.course_type) && 'base_price' in row),
      '回傳含價格欄位（手動建檔要用每期價）');

    step('C2 櫃台新增、修改、刪除、看異動紀錄 → 一律 403，資料不變');
    const zoneQ = `venue=${encodeURIComponent(ref.venue_id)}`;
    const create = await call(route.base, 'POST', '/api/admin/course-types', staff, { course_type: 9, label: '唯讀測試', base_price: 1, venue_id: ref.venue_id });
    assert(create.status === 403 && create.data?.code === 'RESOURCE_FORBIDDEN', `新增被擋（${create.status} ${create.data?.code}）`);
    const patch = await call(route.base, 'PATCH', `/api/admin/course-types/${ref.course_type}?${zoneQ}`, staff, { label: '唯讀測試改名', venue_id: ref.venue_id });
    assert(patch.status === 403 && patch.data?.code === 'RESOURCE_FORBIDDEN', `修改被擋（${patch.status} ${patch.data?.code}）`);
    const del = await call(route.base, 'DELETE', `/api/admin/course-types/${ref.course_type}?${zoneQ}`, staff);
    assert(del.status === 403 && del.data?.code === 'RESOURCE_FORBIDDEN', `刪除被擋（${del.status} ${del.data?.code}）`);
    const logs = await call(route.base, 'GET', `/api/admin/course-types/${ref.course_type}/audit-logs?${zoneQ}`, staff);
    assert(logs.status === 403 && logs.data?.code === 'RESOURCE_FORBIDDEN', `異動紀錄被擋（${logs.status} ${logs.data?.code}）`);
    const after = (await pg.query(
      `SELECT count(*)::int AS n, max(updated_at) AS t FROM course_type_configs`)).rows[0];
    assert(after.n === before.n && String(after.t) === String(before.t), '課程需求資料完全沒變');

    step('C3 救生員（沒有手動建檔、也沒有課程需求管理）讀取 → 403');
    const lg = await call(route.base, 'GET', `/api/admin/course-types?venue=${encodeURIComponent(ref.venue_id)}`, tokenFor('lifeguard'));
    assert(lg.status === 403 && lg.data?.code === 'RESOURCE_FORBIDDEN', `救生員被擋（${lg.status} ${lg.data?.code}）`);

    step('C4 管理員讀取 → 200（對照）');
    const ad = await call(route.base, 'GET', `/api/admin/course-types?venue=${encodeURIComponent(ref.venue_id)}`, tokenFor('admin'));
    assert(ad.status === 200 && Array.isArray(ad.data) && ad.data.length === list.data.length, `管理員讀得到且筆數相同（${ad.status}）`);
  } finally {
    await pg.end();
    await route.close();
    const { pool } = require('../../server/models/db');
    await pool.end().catch(() => {});
  }
  step('done');
})().catch((e) => { console.error(e); process.exit(1); });
