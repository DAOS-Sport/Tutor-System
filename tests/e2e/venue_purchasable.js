/**
 * 「沒設定完的場館，家長端不給選」端到端實測。
 *
 * 要防的是這個劇本：營運端新開一個定價區（例如松山），系統把別區的課別複製一份
 * 當起點 —— 那些價格是**佔位值**。若複製過來就是啟用狀態，這個區從建立那一刻起
 * 就「可以賣」，家長在松山用三蘆的價下單，畫面上完全正常，沒有任何人會發現。
 *
 * 所以兩道一起驗：
 *   1. 新區複製過來的課別一律停用（is_active = FALSE）
 *   2. 場館所屬的區沒有「啟用中且有價格」的課別 → /api/venues 標 purchasable=false
 *      → 家長端場館清單不列它
 * 最後把其中一項設好價並啟用，確認場館「就會」出現 —— 否則這個機制只是永遠擋住。
 */
const assert = require('assert');
const path = require('path');

const SERVER = path.resolve(__dirname, '../../server');
const jwt = require(path.join(SERVER, 'node_modules', 'jsonwebtoken'));
const { pool } = require(path.join(SERVER, 'models', 'db'));

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.JWT_SECRET;
const ZONE_NAME = '__e2e_purchasable__';
let zoneId = null;
let movedVenue = null;   // { id, originalZoneId }

const adminToken = () => jwt.sign(
  { role: 'admin', sub: 'purch-e2e', username: 'purch-e2e', name: '可販售 E2E' }, SECRET, { expiresIn: '1h' });

async function api(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch { /* 空回應 */ }
  return { status: r.status, data: d };
}

const venueRow = async (id) => (await api(`/api/venues`)).data.find((v) => v.id === id);

(async () => {
  assert.ok(SECRET, 'JWT_SECRET must be set');
  const t = adminToken();

  // ── 1. 新開一區，複製過來的課別必須全部停用 ────────────────
  let r = await api('/api/admin/pricing-zones', {
    method: 'POST', token: t, body: { name: ZONE_NAME, sessions_per_period: 6 },
  });
  assert.strictEqual(r.status, 201, '新增定價區失敗 → ' + JSON.stringify(r));
  zoneId = r.data.id;
  const copied = await pool.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE is_active)::int AS active
       FROM course_type_configs WHERE pricing_zone_id = $1`, [zoneId]);
  assert.ok(copied.rows[0].n > 0, '新區要帶入一套課別當起點');
  assert.strictEqual(copied.rows[0].active, 0,
    `複製過來的 ${copied.rows[0].n} 個課別必須全部停用 —— 那些價格是從別區抄來的佔位值`);
  console.log(`  ok  新區帶入 ${copied.rows[0].n} 個課別，啟用中 0 個`);

  // ── 2. 把一個場館搬進來 → 家長端就不該看到它 ───────────────
  const pick = await pool.query(
    `SELECT id, pricing_zone_id FROM venues
      WHERE is_active AND pricing_zone_id IS NOT NULL AND pricing_zone_id <> $1
      ORDER BY id LIMIT 1`, [zoneId]);
  assert.ok(pick.rowCount, '需要一個啟用中的場館來測');
  movedVenue = { id: pick.rows[0].id, originalZoneId: pick.rows[0].pricing_zone_id };

  const before = await venueRow(movedVenue.id);
  assert.ok(before, `場館 ${movedVenue.id} 原本應該出現在清單裡`);
  assert.strictEqual(before.purchasable, true, '搬移前該場館本來是可販售的');

  r = await api(`/api/admin/pricing-zones/${zoneId}/venues`, {
    method: 'PUT', token: t, body: { venue_ids: [movedVenue.id] },
  });
  assert.strictEqual(r.status, 200, '搬移場館失敗 → ' + JSON.stringify(r));

  const after = await venueRow(movedVenue.id);
  assert.strictEqual(after.purchasable, false,
    '搬進「課別全部停用」的區之後，這個場館不該是可販售狀態');
  console.log(`  ok  場館 ${movedVenue.id} 搬進未設定完的區 → purchasable=false`);

  // ── 3. 設好價並啟用一項 → 場館就要回來 ────────────────────
  // 這一步不能省：只證明「擋得住」而不證明「開得起來」，等於做了一個永遠關著的閘門。
  await pool.query(
    `UPDATE course_type_configs SET is_active = TRUE, base_price = 1234
      WHERE pricing_zone_id = $1 AND course_type = (
        SELECT MIN(course_type) FROM course_type_configs WHERE pricing_zone_id = $1)`,
    [zoneId]);
  const reopened = await venueRow(movedVenue.id);
  assert.strictEqual(reopened.purchasable, true,
    '設好價格並啟用之後，場館必須重新變成可販售');
  console.log(`  ok  設好價並啟用一項 → purchasable=true（閘門開得起來）`);

  // ── 4. 價格為 0 不算設定完 ────────────────────────────────
  await pool.query(
    `UPDATE course_type_configs SET base_price = 0 WHERE pricing_zone_id = $1`, [zoneId]);
  const zeroed = await venueRow(movedVenue.id);
  assert.strictEqual(zeroed.purchasable, false,
    '啟用了但價格是 0，等於還沒設定完，不該可販售');
  console.log('  ok  啟用但價格 0 → 仍然不可販售');

  console.log('\ne2e_venue_purchasable: ALL PASS');
})()
  .catch((e) => { console.error('\n❌ FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    if (movedVenue) {
      await pool.query('UPDATE venues SET pricing_zone_id = $1 WHERE id = $2',
        [movedVenue.originalZoneId, movedVenue.id]);
    }
    if (zoneId) {
      await pool.query('DELETE FROM course_type_configs WHERE pricing_zone_id = $1', [zoneId]);
      await pool.query('DELETE FROM pricing_zones WHERE id = $1', [zoneId]);
    }
    await pool.query('DELETE FROM pricing_zones WHERE name = $1', [ZONE_NAME]).catch(() => {});
    console.log('(已還原場館歸屬並刪除測試定價區)');
    await pool.end();
  });
