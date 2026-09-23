/**
 * 冒煙測試：家長端「看到的價」＝ 系統「實際收的價」，逐場館、逐加成級距。
 *
 * ── 為什麼不是「base × 倍率」──
 * 後台每個課別可以對各加成級距**填固定金額**：
 *   留空 → 沿用「每期價格 × 加成倍率」自動計算
 *   填了 → 以填的為準（成交金額以此為唯一來源）
 * 正式庫就有不等於乘法的例子：一對一 base 6,900、1.5 級距填 9,000（乘出來是 10,350，
 * 差 1,350）。所以期望值一律取「設定值」，不是乘出來的 —— 這支測試刻意把明價設成
 * 不等於乘積，乘法寫死的實作會立刻紅。
 *
 * ── 兩邊各自獨立算，才驗得出漂移 ──
 *   家長看到的：/api/courses/base-price + /api/coaches 的回傳，餵進 **前端那份**
 *               client/shared/coursePricing.resolveUnitPrice（CoachCard 用的同一支）
 *   系統收的　：真的送出報名，讀 admin_enrollments.original_price（後端那份算的）
 * 前後端是兩份實作，這裡就是它們的對帳點。
 */
const assert = require('assert');
const path = require('path');
const { randomUUID } = require('crypto');

const SERVER = path.resolve(__dirname, '../../server');
const jwt = require(path.join(SERVER, 'node_modules', 'jsonwebtoken'));
const { pool } = require(path.join(SERVER, 'models', 'db'));

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.JWT_SECRET;
const COURSE_TYPE = 3;
// 兩個定價區各一館、三個加成級距各一位教練，全部自建（原本借 dev 庫的 L / C 館與在職教練）。
const suffix = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const VENUES = [`PMA${suffix}`, `PMB${suffix}`];
const ZONE_PRICES = [4500, 5400];
const MULTIPLIERS = [1.00, 1.20, 1.50];
const zoneIds = [];
const parentId = randomUUID();
const coachIds = MULTIPLIERS.map(() => randomUUID());
const staffIds = MULTIPLIERS.map((m, i) => `E2E-PM-${suffix}-${i}`);

const createdEnrollments = [];
const restoreTiers = [];   // { zoneId, tier_prices }

async function api(p, token) {
  const r = await fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  let d = null;
  try { d = await r.json(); } catch { /* 空回應 */ }
  return { status: r.status, data: d };
}

(async () => {
  assert.ok(SECRET, 'JWT_SECRET must be set');
  // 前端那一份（ESM）—— 用 CoachCard 實際 import 的同一個檔案，不另外抄一份公式。
  const { resolveUnitPrice } = await import(
    'file://' + path.resolve(__dirname, '../../client/shared/coursePricing.js'));

  for (let i = 0; i < VENUES.length; i += 1) {
    const zoneId = (await pool.query(
      `INSERT INTO pricing_zones (name, sessions_per_period, sort_order) VALUES ($1, 6, 994) RETURNING id`,
      [`價格對帳區${suffix}-${i}`])).rows[0].id;
    zoneIds.push(zoneId);
    await pool.query(
      `INSERT INTO venues (id, name, is_active, pricing_zone_id) VALUES ($1, $2, TRUE, $3)`,
      [VENUES[i], `價格對帳館${suffix}-${i}`, zoneId]);
    await pool.query(
      `INSERT INTO course_type_configs
         (pricing_zone_id, course_type, label, min_students, max_students, sort_order, base_price, is_active)
       VALUES ($1, $2, '一對三', 1, 3, 3, $3, TRUE)`,
      [zoneId, COURSE_TYPE, ZONE_PRICES[i]]);
  }
  // 家長端教練清單以 admin_staff（在職＋館別）為準，成交價讀 coaches.pricing_multiplier，兩邊係數一致。
  const digits = String(parseInt(suffix, 16)).padStart(10, '0').slice(-8);
  for (let i = 0; i < MULTIPLIERS.length; i += 1) {
    const phone = `07${digits.slice(0, 7)}${i}`;
    await pool.query(
      `INSERT INTO admin_staff (id, name, role, venue_id, phone, multiplier, active, is_coach)
       VALUES ($1, $2, 'coach', $3, $4, $5, TRUE, TRUE)`,
      [staffIds[i], `價格對帳教練${suffix}-${i}`, VENUES[0], phone, MULTIPLIERS[i]]);
    await pool.query(
      `INSERT INTO admin_staff_venues (staff_id, venue_id) SELECT $1, unnest($2::text[])`,
      [staffIds[i], VENUES]);
    await pool.query(
      `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active, pricing_multiplier)
       VALUES ($1, $2, $3, $4, TRUE, $5)`,
      [coachIds[i], `價格對帳教練${suffix}-${i}`, phone, staffIds[i], MULTIPLIERS[i]]);
  }
  await pool.query(
    `INSERT INTO parents (id, name, phone, is_active) VALUES ($1, $2, $3, TRUE)`,
    [parentId, `價格對帳家長${suffix}`, `09${digits}`]);
  const parent = (await pool.query(
    `INSERT INTO students (parent_id, name) VALUES ($1, $2)
     RETURNING parent_id AS id, $3::text AS phone, id AS student_id`,
    [parentId, `價格對帳學員${suffix}`, `09${digits}`])).rows[0];
  const token = jwt.sign({ type: 'parent', parentId: parent.id, phone: parent.phone }, SECRET, { expiresIn: '1h' });

  // 為每個場館所屬的定價區設一組明價：1.50 刻意「不等於」base×1.5，1.20 留空走乘法。
  for (const v of VENUES) {
    const z = await pool.query(
      `SELECT z.id, c.base_price, c.tier_prices
         FROM venues v JOIN pricing_zones z ON z.id = v.pricing_zone_id
         JOIN course_type_configs c ON c.pricing_zone_id = z.id AND c.course_type = $2
        WHERE v.id = $1`, [v, COURSE_TYPE]);
    assert.ok(z.rowCount, `場館 ${v} 查不到一對三設定`);
    const { id: zoneId, base_price: base, tier_prices: orig } = z.rows[0];
    restoreTiers.push({ zoneId, tier_prices: orig });
    // 明價 = base + 111，保證與 base×1.5 不同，也不是任何巧合的整數關係
    const explicit = Math.round(Number(base)) + 111;
    await pool.query(
      `UPDATE course_type_configs SET tier_prices = $3::jsonb
        WHERE pricing_zone_id = $1 AND course_type = $2`,
      [zoneId, COURSE_TYPE, JSON.stringify({ '1.50': explicit })]);
  }

  const seen = [];
  for (const v of VENUES) {
    // ① 家長端實際會拿到的兩包資料
    const bp = await api(`/api/courses/base-price?courseType=${COURSE_TYPE}&venue=${v}`, token);
    assert.strictEqual(bp.status, 200, `${v} base-price 失敗 → ${JSON.stringify(bp)}`);
    assert.ok(Number.isFinite(Number(bp.data.original_price)),
      `${v} base-price 沒回 original_price，前端會顯示 NT$0：${JSON.stringify(bp.data)}`);
    const coaches = await api(`/api/coaches?venueId=${v}`, token);
    assert.strictEqual(coaches.status, 200, `${v} 教練清單失敗 → ${coaches.status}`);

    for (const mult of [1, 1.2, 1.5]) {
      const coach = (coaches.data || []).find(
        (c) => Math.abs(Number(c.multiplier ?? c.pricing_multiplier ?? 1) - mult) < 1e-9);
      if (!coach) { console.log(`  －  ${v} 沒有 ${mult} 倍的在職教練，略過`); continue; }

      // ② 家長看到的價：用前端那支算（CoachCard 就是這樣算的）
      // 欄位名刻意跟前端一致：CoachListPage 讀的是 bp.original_price（不是 base_price）。
      // 用錯欄位會拿到 undefined、算出 0，而畫面上只會看到 NT$0 —— 又是一種安靜的錯。
      const shown = resolveUnitPrice(bp.data.original_price, mult, bp.data.tier_prices);

      // ③ 系統收的價：真的下一筆單
      const rid = `price-match-${v}-${mult}-${Math.floor(Math.random() * 1e9).toString(36)}`;
      const res = await fetch(BASE + '/api/enrollments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'Idempotency-Key': rid },
        body: JSON.stringify({
          request_id: rid,
          coach: { id: coach.id },
          venue: { id: v },
          course_type: COURSE_TYPE,
          students: [{ id: parent.student_id }],
          period_count: 1,
          order_kind: 'standard',
          payment_method: 'bank_transfer',
        }),
      });
      let body = null;
      try { body = await res.json(); } catch { /* 空回應 */ }
      assert.strictEqual(res.status, 201, `${v}/${mult} 報名失敗 → ${res.status} ${JSON.stringify(body)}`);
      const row = await pool.query(
        `SELECT id, original_price FROM admin_enrollments
          WHERE parent_phone = $1 AND venue_id = $2 ORDER BY submitted_at DESC LIMIT 1`,
        [parent.phone, v]);
      createdEnrollments.push(row.rows[0].id);
      const charged = Math.round(Number(row.rows[0].original_price));

      const viaMultiply = Math.round(Number(bp.data.original_price) * mult);
      const usedExplicit = shown !== viaMultiply;
      console.log(`  ${v}  ${mult} 倍  家長看到 ${shown}  實收 ${charged}`
        + `  ${usedExplicit ? `（用固定金額，非乘法 ${viaMultiply}）` : '（該級距留空，走乘法）'}`);
      assert.strictEqual(charged, shown,
        `${v} ${mult} 倍：家長看到 ${shown}，實際收 ${charged} —— 兩邊對不上`);
      seen.push({ v, mult, shown, usedExplicit });
    }
  }

  // 兩條分支都要真的被走過，否則這支測試證明不了它宣稱的事
  assert.ok(seen.some((x) => x.usedExplicit), '必須至少有一組走「固定金額」分支');
  assert.ok(seen.some((x) => !x.usedExplicit), '必須至少有一組走「乘法」分支');
  // 兩個場館的同一級距不可以同價，否則分區根本沒生效
  for (const mult of [1, 1.5]) {
    const pair = seen.filter((x) => x.mult === mult);
    if (pair.length === 2) {
      assert.notStrictEqual(pair[0].shown, pair[1].shown,
        `兩個場館的 ${mult} 倍價格相同，分區沒有生效`);
    }
  }

  console.log('\ne2e_parent_price_match: ALL PASS（家長看到的＝系統收的，逐場館逐級距）');
})()
  .catch((e) => { console.error('\n❌ FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    if (createdEnrollments.length) {
      await pool.query('DELETE FROM admin_enrollments WHERE id = ANY($1)', [createdEnrollments]);
    }
    for (const t of restoreTiers) {
      await pool.query(
        `UPDATE course_type_configs SET tier_prices = $3::jsonb
          WHERE pricing_zone_id = $1 AND course_type = $2`,
        [t.zoneId, COURSE_TYPE, t.tier_prices === null ? null : JSON.stringify(t.tier_prices)]);
    }
    // 自建夾具：checkout 與冪等紀錄掛在測試家長身上，先清掉再刪家長、教練、場館、定價區。
    await pool.query('DELETE FROM checkout_sessions WHERE parent_id = $1', [parentId]).catch(() => {});
    await pool.query('DELETE FROM request_idempotency_ledger WHERE actor_id = $1', [parentId]).catch(() => {});
    await pool.query('DELETE FROM students WHERE parent_id = $1', [parentId]).catch(() => {});
    await pool.query('DELETE FROM parents WHERE id = $1', [parentId]).catch(() => {});
    await pool.query('DELETE FROM coaches WHERE id = ANY($1::uuid[])', [coachIds]).catch(() => {});
    await pool.query('DELETE FROM admin_staff WHERE id = ANY($1::text[])', [staffIds]).catch(() => {});
    await pool.query('DELETE FROM course_type_configs WHERE pricing_zone_id = ANY($1::int[])', [zoneIds]).catch(() => {});
    await pool.query('DELETE FROM venues WHERE id = ANY($1::text[])', [VENUES]).catch(() => {});
    await pool.query('DELETE FROM pricing_zones WHERE id = ANY($1::int[])', [zoneIds]).catch(() => {});
    console.log(`(已清除 ${createdEnrollments.length} 筆測試報名，還原 ${restoreTiers.length} 組加成級距設定)`);
    await pool.end();
  });
