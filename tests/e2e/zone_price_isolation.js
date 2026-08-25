/**
 * 冒煙測試：同一個課別、兩個不同定價區的場館，實際落地的金額必須不同。
 *
 * 這支要抓的就是那個「安靜的錯」—— 分區後 `WHERE course_type = $1` 會每區回一列，
 * 取 rows[0] 會讓松山的家長付到三蘆的價，而且沒有任何錯誤訊息。
 * 所以這裡不看程式碼、不看回應訊息，只看 **admin_enrollments 真的存進去多少錢**。
 */
const assert = require('assert');
const path = require('path');
const SERVER = path.resolve(__dirname, '../../server');
const jwt = require(path.join(SERVER, 'node_modules', 'jsonwebtoken'));
const { pool } = require(path.join(SERVER, 'models', 'db'));

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.JWT_SECRET;
const created = [];
const createdGroups = [];

async function post(token, body) {
  const rid = 'zone-smoke-' + body.venue.id + '-' + Math.floor(Math.random() * 1e9).toString(36);
  const r = await fetch(BASE + '/api/enrollments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'Idempotency-Key': rid,
    },
    body: JSON.stringify({ ...body, request_id: rid }),
  });
  let data = null;
  try { data = await r.json(); } catch { /* 空回應 */ }
  return { status: r.status, data, rid };
}

(async () => {
  assert.ok(SECRET, 'JWT_SECRET must be set');

  // 找一個有學員的家長、一個 1.00 倍率的在職教練
  const pr = await pool.query(`
    SELECT p.id, p.phone, s.id AS student_id, s.name AS student_name
      FROM parents p JOIN students s ON s.parent_id = p.id
     WHERE p.is_active = TRUE LIMIT 1`);
  assert.ok(pr.rowCount, 'dev DB 需要至少一組家長+學員');
  const parent = pr.rows[0];
  const co = await pool.query(
    `SELECT id FROM coaches WHERE is_active = TRUE AND pricing_multiplier = 1.00 LIMIT 1`);
  assert.ok(co.rowCount, 'dev DB 需要一位 1.00 倍率的在職教練');
  const coachId = co.rows[0].id;

  const token = jwt.sign({ type: 'parent', parentId: parent.id, phone: parent.phone }, SECRET, { expiresIn: '1h' });

  // 兩區同一課別的設定價（期望值直接從 DB 讀，不寫死）
  const expect = {};
  for (const v of ['L', 'C']) {
    const r = await pool.query(`
      SELECT z.name AS zone, c.base_price
        FROM venues v JOIN pricing_zones z ON z.id = v.pricing_zone_id
        JOIN course_type_configs c ON c.pricing_zone_id = z.id
       WHERE v.id = $1 AND c.course_type = 3`, [v]);
    assert.ok(r.rowCount, `場館 ${v} 查不到一對三設定`);
    expect[v] = { zone: r.rows[0].zone, price: Math.round(Number(r.rows[0].base_price)) };
  }
  assert.notStrictEqual(expect.L.price, expect.C.price,
    '兩區價格必須先不同，否則這支測試證明不了任何事');
  console.log(`  設定：一對三 @${expect.L.zone}=${expect.L.price}／期  @${expect.C.zone}=${expect.C.price}／期`);

  const body = {
    coach: { id: coachId },
    course_type: 3,
    students: [{ id: parent.student_id }],
    period_count: 1,
    order_kind: 'standard',
    payment_method: 'bank_transfer',
  };

  for (const v of ['L', 'C']) {
    const res = await post(token, { ...body, venue: { id: v } });
    assert.strictEqual(res.status, 201, `場館 ${v} 報名失敗 → ${JSON.stringify(res)}`);
    const row = await pool.query(
      `SELECT id, original_price, final_price, venue_id FROM admin_enrollments
        WHERE parent_phone = $1 AND venue_id = $2 ORDER BY submitted_at DESC LIMIT 1`,
      [parent.phone, v]);
    assert.ok(row.rowCount, `場館 ${v} 沒有落地訂單`);
    created.push(row.rows[0].id);
    const got = Math.round(Number(row.rows[0].original_price));
    console.log(`  ${v}（${expect[v].zone}）落地金額 = ${got}，應為 ${expect[v].price}`);
    assert.strictEqual(got, expect[v].price,
      `場館 ${v} 收了 ${got}，但該區設定是 ${expect[v].price} —— 這就是靜默錯價`);
  }


  // ── 團報：同一課別、兩個區，每家應繳金額也必須各收各的 ──
  // 團購走的是另一條建單路徑（POST /api/group-orders），設定讀取點也是另外兩處，
  // 所以個人報名對了不代表團報對了，要各自驗。
  for (const v of ['L', 'C']) {
    const rid = 'zone-smoke-go-' + v + '-' + Math.floor(Math.random() * 1e9).toString(36);
    const r = await fetch(BASE + '/api/group-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        course_type: 3,
        venue_id: v,
        coach_id: coachId,
        student_ids: [parent.student_id],
        period_count: 1,
        note: rid,
      }),
    });
    let data = null;
    try { data = await r.json(); } catch { /* 空回應 */ }
    assert.strictEqual(r.status, 201, `場館 ${v} 開團失敗 → ${r.status} ${JSON.stringify(data)}`);
    const go = await pool.query(
      `SELECT go.id, m.original_amount
         FROM group_orders go JOIN group_order_members m ON m.group_order_id = go.id
        WHERE go.note = $1`, [rid]);
    assert.ok(go.rowCount, `場館 ${v} 沒有落地團購`);
    createdGroups.push(go.rows[0].id);
    const got = Math.round(Number(go.rows[0].original_amount));
    console.log(`  ${v}（${expect[v].zone}）團報每家應繳 = ${got}，應為 ${expect[v].price}`);
    assert.strictEqual(got, expect[v].price,
      `團報在場館 ${v} 算成 ${got}，但該區設定是 ${expect[v].price}`);
  }

  console.log('\nsmoke_zone_price: PASS（兩區各收各的價）');
})()
  .catch((e) => { console.error('\n❌ FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    if (created.length) {
      await pool.query('DELETE FROM admin_enrollments WHERE id = ANY($1)', [created]);
    }
    if (createdGroups.length) {
      await pool.query('DELETE FROM group_order_audit_logs WHERE group_order_id = ANY($1)', [createdGroups]);
      await pool.query('DELETE FROM group_order_members WHERE group_order_id = ANY($1)', [createdGroups]);
      await pool.query('DELETE FROM group_orders WHERE id = ANY($1)', [createdGroups]);
    }
    console.log(`(已清除 ${created.length} 筆報名、${createdGroups.length} 筆團購)`);
    await pool.end();
  });
