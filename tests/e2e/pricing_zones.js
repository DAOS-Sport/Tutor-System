/**
 * 定價區管理 API（F-A08）端到端實測。
 *
 * 重點驗「場館互斥」：把一個場館勾給 B 區，它必須自動離開 A 區。
 * 這件事靠的是 venues.pricing_zone_id 單一外鍵，不是 UI 自律 —— 所以要用
 * 真的 API 打一輪、再回資料庫看歸屬，才算證明。
 */
const assert = require('assert');
const path = require('path');

const SERVER = path.resolve(__dirname, '../../server');
const jwt = require(path.join(SERVER, 'node_modules', 'jsonwebtoken'));
const { pool } = require(path.join(SERVER, 'models', 'db'));

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.JWT_SECRET;
const ZONE_NAME = '__e2e_zone__';
let createdZoneId = null;
let restore = null;   // { venueId, originalZoneId }

const token = () => jwt.sign(
  { role: 'admin', sub: 'zone-e2e', username: 'zone-e2e', name: '定價區 E2E' }, SECRET, { expiresIn: '1h' });

async function api(p, { method = 'GET', body } = {}) {
  const r = await fetch(BASE + '/api/admin/pricing-zones' + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* 空回應 */ }
  return { status: r.status, data };
}

(async () => {
  assert.ok(SECRET, 'JWT_SECRET must be set');

  // ── 1. 分頁列 ─────────────────────────────────────────────
  let r = await api('');
  assert.strictEqual(r.status, 200, '載入定價區失敗 → ' + JSON.stringify(r));
  assert.ok(Array.isArray(r.data.zones) && r.data.zones.length >= 1, '至少要有一個定價區');
  assert.ok(Array.isArray(r.data.all_venues) && r.data.all_venues.length > 0, '要回全部場館供勾選');
  const first = r.data.zones[0];
  assert.ok(Array.isArray(first.venues), '每個分頁要帶自己的場館清單');
  console.log(`  ok  分頁列：${r.data.zones.map((z) => `${z.name}(${z.venues.length}館/一期${z.sessions_per_period}堂)`).join('  ')}`);

  // ── 2. 新增一區，且立刻拿到一套課別起點 ───────────────────
  r = await api('', { method: 'POST', body: { name: ZONE_NAME, sessions_per_period: 8, period_count_min: 1, period_count_max: 4 } });
  assert.strictEqual(r.status, 201, '新增定價區失敗 → ' + JSON.stringify(r));
  createdZoneId = r.data.id;
  assert.strictEqual(Number(r.data.sessions_per_period), 8);
  const seeded = await pool.query(
    'SELECT COUNT(*)::int AS n FROM course_type_configs WHERE pricing_zone_id = $1', [createdZoneId]);
  assert.ok(seeded.rows[0].n > 0, '新區必須立刻有課別設定可編，不必等重啟');
  console.log(`  ok  新增「${ZONE_NAME}」→ 自動帶入 ${seeded.rows[0].n} 個課別起點`);

  // ── 3. 同名擋下 ───────────────────────────────────────────
  r = await api('', { method: 'POST', body: { name: ZONE_NAME } });
  assert.strictEqual(r.status, 409, '同名應該擋下');
  assert.strictEqual(r.data.code, 'NAME_TAKEN');
  console.log('  ok  同名定價區被擋下');

  // ── 4. 期數上下限相反要擋 ─────────────────────────────────
  r = await api('/' + createdZoneId, { method: 'PATCH', body: { period_count_min: 5, period_count_max: 2 } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.code, 'PERIOD_RANGE_INVALID');
  console.log('  ok  期數下限大於上限被擋下');

  // ── 5. 改名 ───────────────────────────────────────────────
  r = await api('/' + createdZoneId, { method: 'PATCH', body: { name: ZONE_NAME + '2' } });
  assert.strictEqual(r.status, 200, '改名失敗 → ' + JSON.stringify(r));
  assert.strictEqual(r.data.name, ZONE_NAME + '2');
  console.log('  ok  改名成功（分頁名稱由使用者自訂）');

  // ── 6. 核心：已被別區佔用的場館，不給搶 ────────────────────
  //
  // 早期版本是「勾選＝搬過來」，一個誤觸就把某館從三蘆抽到松山，該館的價目表
  // 當場整個換掉、家長端金額跟著變，畫面上沒有任何阻攔。現在必須擋下來。
  const pick = await pool.query(
    `SELECT id, pricing_zone_id FROM venues WHERE pricing_zone_id IS NOT NULL AND pricing_zone_id <> $1
      ORDER BY id LIMIT 1`, [createdZoneId]);
  assert.ok(pick.rowCount, '需要一個已屬於別區的場館來測');
  const venueId = pick.rows[0].id;
  const originalZoneId = pick.rows[0].pricing_zone_id;
  restore = { venueId, originalZoneId };

  r = await api('/' + createdZoneId + '/venues', { method: 'PUT', body: { venue_ids: [venueId] } });
  assert.strictEqual(r.status, 409, '已屬於別區的場館必須擋下 → ' + JSON.stringify(r));
  assert.strictEqual(r.data.code, 'VENUE_OWNED_BY_OTHER_ZONE');
  assert.ok(String(r.data.error || '').includes('取消勾選'),
    '錯誤訊息要講得出下一步怎麼做，不然使用者只知道被擋、不知道怎麼辦');
  const blocked = await pool.query('SELECT pricing_zone_id FROM venues WHERE id = $1', [venueId]);
  assert.strictEqual(String(blocked.rows[0].pricing_zone_id), String(originalZoneId),
    '被擋下之後場館的歸屬一個字都不能動 —— 半套的搬移比不搬更糟');
  console.log(`  ok  場館 ${venueId} 已屬於第 ${originalZoneId} 區 → 擋下 409，歸屬未變`);

  // ── 6b. 兩段式換區：先在原本那一區放掉，再到新的一區勾 ──────
  // 只證明「擋得住」而不證明「換得成」，等於做了一個永遠打不開的鎖。
  const siblings = (await pool.query(
    'SELECT id FROM venues WHERE pricing_zone_id = $1 AND id <> $2', [originalZoneId, venueId])).rows.map((x) => x.id);
  r = await api('/' + originalZoneId + '/venues', { method: 'PUT', body: { venue_ids: siblings } });
  assert.strictEqual(r.status, 200, '在原本那一區取消勾選失敗 → ' + JSON.stringify(r));

  r = await api('/' + createdZoneId + '/venues', { method: 'PUT', body: { venue_ids: [venueId] } });
  assert.strictEqual(r.status, 200, '放掉之後就該勾得起來 → ' + JSON.stringify(r));
  const after = await pool.query('SELECT pricing_zone_id FROM venues WHERE id = $1', [venueId]);
  assert.strictEqual(after.rows[0].pricing_zone_id, createdZoneId, '兩段式換區必須真的換過去');
  console.log(`  ok  先放掉再勾 → 場館 ${venueId} 換到第 ${createdZoneId} 區（鎖打得開）`);

  // 原本那一區的清單裡不可以再有它
  r = await api('');
  const oldZone = r.data.zones.find((z) => z.id === originalZoneId);
  assert.ok(oldZone, '原本那一區還在');
  assert.ok(!oldZone.venues.some((v) => v.id === venueId),
    `場館 ${venueId} 不可以同時出現在兩個定價區的清單裡`);
  const newZone = r.data.zones.find((z) => z.id === createdZoneId);
  assert.ok(newZone.venues.some((v) => v.id === venueId), '新區清單要有它');
  console.log('  ok  同一場館不會同時出現在兩區（互斥由單一外鍵保證）');

  // ── 7. 取消勾選會變成未分配，而且一定回報 ─────────────────
  r = await api('/' + createdZoneId + '/venues', { method: 'PUT', body: { venue_ids: [] } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.unassigned.length, 1, '取消勾選的場館要被回報');
  // 警告的規則是「這個場館真的有在開課，卻掉出定價區」才提醒 ——
  // 多數場館（勞務館之類）沒有定價區是正常狀態，每個都警告等於天天喊狼來了。
  // 所以這裡不寫死期望值，而是照規則推：有課期就該有警告，沒課期就不該有。
  const hasCourses = (await pool.query(
    'SELECT EXISTS (SELECT 1 FROM course_periods WHERE venue_id = $1) AS yes', [venueId])).rows[0].yes;
  if (hasCourses) {
    assert.ok(r.data.warning && r.data.warning.includes('報名會失敗'),
      '有課在跑的場館掉出定價區，必須明確警告');
    console.log('  ok  取消勾選「有課在跑」的場館 → 明確警告');
  } else {
    assert.strictEqual(r.data.warning, null,
      '沒在賣課的場館掉出定價區不是問題，不可以製造警告雜訊');
    console.log('  ok  取消勾選「沒課」的場館 → 據實回報但不製造警告');
  }

  // ── 8. 還有場館時不可刪；空了才可刪 ───────────────────────
  await pool.query('UPDATE venues SET pricing_zone_id = $1 WHERE id = $2', [createdZoneId, venueId]);
  r = await api('/' + createdZoneId, { method: 'DELETE' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'ZONE_HAS_VENUES');
  console.log('  ok  還有場館的定價區不可刪除');

  await pool.query('UPDATE venues SET pricing_zone_id = $1 WHERE id = $2', [originalZoneId, venueId]);
  restore = null;
  await pool.query('DELETE FROM course_type_configs WHERE pricing_zone_id = $1', [createdZoneId]);
  r = await api('/' + createdZoneId, { method: 'DELETE' });
  assert.strictEqual(r.status, 200, '清空後應可刪除 → ' + JSON.stringify(r));
  createdZoneId = null;
  console.log('  ok  清空後可刪除');

  console.log('\ne2e_pricing_zones: ALL PASS');
})()
  .catch((e) => { console.error('\n❌ FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    if (restore) {
      await pool.query('UPDATE venues SET pricing_zone_id = $1 WHERE id = $2',
        [restore.originalZoneId, restore.venueId]);
    }
    if (createdZoneId) {
      await pool.query('UPDATE venues SET pricing_zone_id = NULL WHERE pricing_zone_id = $1', [createdZoneId]);
      await pool.query('DELETE FROM course_type_configs WHERE pricing_zone_id = $1', [createdZoneId]);
      await pool.query('DELETE FROM pricing_zones WHERE id = $1', [createdZoneId]);
    }
    await pool.query('DELETE FROM pricing_zones WHERE name LIKE $1', ['__e2e_zone__%']).catch(() => {});
    await pool.end();
  });
