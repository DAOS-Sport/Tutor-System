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

  // ── 6. 核心：勾走一個場館，它必須離開原本那一區 ────────────
  const pick = await pool.query(
    `SELECT id, pricing_zone_id FROM venues WHERE pricing_zone_id IS NOT NULL AND pricing_zone_id <> $1
      ORDER BY id LIMIT 1`, [createdZoneId]);
  assert.ok(pick.rowCount, '需要一個已屬於別區的場館來測搬移');
  const venueId = pick.rows[0].id;
  const originalZoneId = pick.rows[0].pricing_zone_id;
  restore = { venueId, originalZoneId };

  r = await api('/' + createdZoneId + '/venues', { method: 'PUT', body: { venue_ids: [venueId] } });
  assert.strictEqual(r.status, 200, '設定場館失敗 → ' + JSON.stringify(r));
  const after = await pool.query('SELECT pricing_zone_id FROM venues WHERE id = $1', [venueId]);
  assert.strictEqual(after.rows[0].pricing_zone_id, createdZoneId, '場館必須搬到新區');
  console.log(`  ok  場館 ${venueId} 從第 ${originalZoneId} 區搬到第 ${createdZoneId} 區`);

  // 原本那一區的清單裡不可以再有它 —— 這就是「被選了就從別區移除」
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
  // 這個場館沒有任何課期，所以「沒有定價區」是正常狀態，不該產生警告。
  // 26 個場館裡只有 3 個真的有家教課，其餘多半是勞務館；把每個都當警告
  // 等於天天喊狼來了，真正該注意的那次反而會被當成雜訊。
  assert.strictEqual(r.data.warning, null,
    '沒在賣課的場館掉出定價區不是問題，不可以製造警告雜訊');
  console.log('  ok  取消勾選沒課的場館 → 據實回報但不製造警告');

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
