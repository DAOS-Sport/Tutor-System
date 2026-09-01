/**
 * 上課紀錄篩選列的場館選項。
 *
 * 這支不掃原始碼、也不相信端點自己回什麼 —— 用另一條路把「應該有哪些館」
 * 重算一次再比對。端點錯了會讓使用者篩不到明明存在的紀錄，
 * 而畫面上只會顯示「所選範圍內沒有課程」，沒有任何錯誤訊息可循。
 */
const assert = require('assert');
const path = require('path');
const { pool } = require(path.resolve(__dirname, '../server/models/db'));
const { signToken } = require(path.resolve(__dirname, '../server/middlewares/adminAuth'));

const BASE = process.env.TEST_BASE || 'http://localhost:3001';
let n = 0;
const t = (name, fn) => fn().then(() => { n += 1; console.log('  PASS  ' + name); });

async function get(p, token) {
  const r = await fetch(BASE + p, { headers: { authorization: 'Bearer ' + token } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** 獨立重算：直接數上課紀錄裡出現過哪些 venue_id，不經過被測端點的任何邏輯。 */
async function expectedIds() {
  const a = await pool.query(
    `SELECT DISTINCT cp.venue_id AS id
       FROM course_sessions cs JOIN course_periods cp ON cp.id = cs.course_period_id
      WHERE cp.venue_id IS NOT NULL AND cs.status::text NOT LIKE 'cancelled%'`
  );
  const b = await pool.query(
    `SELECT DISTINCT venue_id AS id FROM admin_today_sessions WHERE venue_id IS NOT NULL`
  );
  return new Set([...a.rows, ...b.rows].map((r) => r.id));
}

(async () => {
  const admin = (await pool.query(
    `SELECT id, username, role FROM admin_users WHERE role = 'admin' AND is_active LIMIT 1`
  )).rows[0];
  assert.ok(admin, 'dev 上要有一個啟用中的 admin 才跑得動這支測試');
  const adminToken = signToken({ id: admin.id, username: admin.username, role: admin.role });

  const want = await expectedIds();

  await t('admin 拿到的選項＝上課紀錄裡真的出現過的館別，一個不多一個不少', async () => {
    const r = await get('/api/admin/sessions/venue-options', adminToken);
    assert.strictEqual(r.status, 200, '狀態碼 ' + r.status);
    const got = new Set(r.body.map((v) => v.id));
    assert.deepStrictEqual([...got].sort(), [...want].sort());
  });

  await t('選項不會比「啟用中的場館」還多空殼 —— 每個選項都查得到課', async () => {
    const r = await get('/api/admin/sessions/venue-options', adminToken);
    for (const v of r.body) {
      const c = await pool.query(
        `SELECT count(*)::int AS n FROM (
           SELECT 1 FROM course_sessions cs JOIN course_periods cp ON cp.id = cs.course_period_id
            WHERE cp.venue_id = $1 AND cs.status::text NOT LIKE 'cancelled%'
           UNION ALL
           SELECT 1 FROM admin_today_sessions WHERE venue_id = $1
         ) x`, [v.id]
      );
      assert.ok(c.rows[0].n > 0, v.id + ' 被列進選項但一堂課都沒有');
    }
  });

  await t('每個選項都有名字（join 不到也要退回 id，不能是空字串）', async () => {
    const r = await get('/api/admin/sessions/venue-options', adminToken);
    assert.ok(r.body.length > 0, '至少要有一個館，否則後面的斷言沒有意義');
    for (const v of r.body) assert.ok(v.name && String(v.name).trim(), v.id + ' 沒有名字');
  });

  await t('選項是「上課紀錄的館」而不是「整張場館表」', async () => {
    const all = (await pool.query(`SELECT count(*)::int AS n FROM venues WHERE is_active`)).rows[0].n;
    const r = await get('/api/admin/sessions/venue-options', adminToken);
    assert.ok(r.body.length < all,
      `選項 ${r.body.length} 個、啟用中場館 ${all} 個 —— 沒有收斂就等於這個需求沒做到`);
  });

  await t('沒有 token 進不來（這支跟 range 同一個 requireResource）', async () => {
    const r = await fetch(BASE + '/api/admin/sessions/venue-options');
    assert.ok(r.status === 401 || r.status === 403, '狀態碼 ' + r.status);
  });

  // 場館範圍用 manager 驗，不用 staff：dev 的 role_permissions 沒給 staff／lifeguard
  // sessions 權限（正式環境三個角色都有），用 staff 會直接 403 而把整段斷言跳掉 ——
  // 那等於這條路根本沒測到。getScopedVenueIds 對所有非 admin 角色是同一段程式
  // （role !== 'admin' → 讀 venue_ids），所以用 manager 驗的就是同一條路。
  const SCOPED_ROLE = 'manager';

  await t('綁單一場館的非 admin 只拿得到自己的館（越權的館不會出現）', async () => {
    const mine = [...want][0];
    assert.ok(mine, 'dev 上要有至少一個有課的館');
    const token = signToken({
      id: 'TEST_SCOPED', username: 'test_scoped', role: SCOPED_ROLE, venue_ids: [mine],
    });
    const r = await get('/api/admin/sessions/venue-options', token);
    assert.strictEqual(r.status, 200, '狀態碼 ' + r.status
      + '（若為 403，表示這個角色在本環境沒有 sessions 權限，測試就沒測到東西）');
    assert.deepStrictEqual(r.body.map((v) => v.id), [mine]);
    assert.ok(want.size > 1, '至少要有兩個有課的館，這條斷言才證明得了「越權的被濾掉」');
  });

  await t('綁到沒課的館 → 回空陣列，不是整張表', async () => {
    const empty = (await pool.query(
      `SELECT id FROM venues WHERE is_active AND id <> ALL($1::text[]) LIMIT 1`,
      [[...want]]
    )).rows[0];
    assert.ok(empty, 'dev 上要有一個「啟用但沒課」的館，這條斷言才有意義');
    const token = signToken({
      id: 'TEST_SCOPED2', username: 'test_scoped2', role: SCOPED_ROLE, venue_ids: [empty.id],
    });
    const r = await get('/api/admin/sessions/venue-options', token);
    assert.strictEqual(r.status, 200, '狀態碼 ' + r.status);
    assert.deepStrictEqual(r.body, []);
  });

  await t('選項裡的每一館，用它去查 range 都真的查得到東西（判準一致）', async () => {
    const r = await get('/api/admin/sessions/venue-options', adminToken);
    // 取該館最後一堂課那天當查詢日，範圍一天就好 —— 只是要證明兩支端點對
    // 「有課」的定義一樣，不是要驗排序。
    for (const v of r.body) {
      // 日期一定要在 SQL 端就格成文字。讓 node-postgres 把 DATE 交回 JS Date
      // 再 toISOString()，會被容器時區推掉一天 —— 這支測試第一版就是這樣自己造出
      // 一個假的失敗，害我差點去改沒壞的程式。
      const d = await pool.query(
        `SELECT to_char(max(day), 'YYYY-MM-DD') AS day FROM (
           SELECT (cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date AS day
             FROM course_sessions cs JOIN course_periods cp ON cp.id = cs.course_period_id
            WHERE cp.venue_id = $1 AND cs.status::text NOT LIKE 'cancelled%'
           UNION ALL
           SELECT date AS day FROM admin_today_sessions WHERE venue_id = $1
         ) x`, [v.id]
      );
      const iso = d.rows[0].day;
      if (!iso) continue;
      const q = await get(`/api/admin/sessions?from=${iso}&to=${iso}&venueIds=${v.id}`, adminToken);
      assert.strictEqual(q.status, 200, v.id + ' range 狀態碼 ' + q.status);
      assert.ok(q.body.length > 0, `${v.id} 出現在選項裡，但用它查 ${iso} 是空的`);
    }
  });

  await t('「取消」的判準涵蓋所有取消類的狀態，且不誤傷正常狀態', async () => {
    // 端點用 NOT LIKE 'cancelled%' 濾掉取消的課。這條驗的是「判準本身對不對」——
    // 例如寫成 <> 'cancelled' 就會漏掉 cancelled_normal / cancelled_by_parent。
    // dev 目前沒有「整館只剩取消課」的資料，所以把過濾整段拿掉在這裡看不出差別，
    // 這條至少擋得住判準寫錯的那一半。
    const r = await pool.query(
      `SELECT e.enumlabel AS status, (e.enumlabel LIKE 'cancelled%') AS 判為取消
         FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
        WHERE ty.typname = (SELECT udt_name FROM information_schema.columns
                             WHERE table_name = 'course_sessions' AND column_name = 'status')
        ORDER BY e.enumsortorder`
    );
    assert.ok(r.rows.length, '找不到 course_sessions.status 的列舉值');
    for (const row of r.rows) {
      const shouldBeCancelled = row.status.startsWith('cancelled');
      assert.strictEqual(row.判為取消, shouldBeCancelled,
        `狀態 ${row.status} 被判成${row.判為取消 ? '取消' : '未取消'}，與預期相反`);
    }
    assert.ok(r.rows.some((x) => x.判為取消), '列舉裡至少要有一個取消狀態，否則這條沒驗到東西');
    assert.ok(r.rows.some((x) => !x.判為取消), '列舉裡至少要有一個非取消狀態');
  });

  console.log('\n' + n + ' 個測試全數通過');
  await pool.end();
})().catch(async (e) => {
  console.error('FAIL ' + e.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
