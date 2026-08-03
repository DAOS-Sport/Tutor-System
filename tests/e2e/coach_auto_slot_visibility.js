'use strict';
/**
 * 教練端「看得見自動時段」E2E（HTTP 層）
 *
 * 為什麼要有這支：auto 產生的時段 venue_id 是 NULL（跨場館共用）。
 * GET /api/slots/coach/:coachId 原本用 INNER JOIN venues，NULL venue 的列
 * 會被整批濾掉——教練在排課總表上看不到自動時段，「預設開放、教練關班」
 * 的模型在教練側等於無法操作。純函式測試抓不到這個，只有真的打 route 才會現形。
 *
 * 用法（需要一個已啟動的 server 與可寫的 DB）：
 *   BASE_URL=http://localhost:4137 node tests/e2e/coach_auto_slot_visibility.js
 */
const assert = require('assert');
const path = require('path');

// 預設值與 tests/e2e/_lib.js 一致，這樣在 run_all.js 底下不必額外設環境變數。
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SERVER_DIR = path.join(__dirname, '..', '..', 'server');
const { pool } = require(path.join(SERVER_DIR, 'models', 'db'));
const { signCoachToken } = require(path.join(SERVER_DIR, 'middlewares', 'coachAuth'));

const SUFFIX = String(process.pid);
// coaches.id 是 uuid，不能用可讀字串當主鍵；用固定前綴 + pid 湊一組不會撞到的 uuid
const COACH_ID = `e2e0a51e-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const VENUE_ID = `E2EV${SUFFIX}`.slice(0, 10);

// 明天 19:00 台北時間，避開任何「過去時段不顯示」的邏輯
function tomorrow19() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  const ymd = d.toISOString().slice(0, 10);
  return new Date(`${ymd}T19:00:00+08:00`);
}

async function setup() {
  await pool.query(
    `INSERT INTO venues (id, name, is_active) VALUES ($1, $2, TRUE)
       ON CONFLICT (id) DO NOTHING`, [VENUE_ID, `E2E 場館 ${SUFFIX}`]);
  await pool.query(
    `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active)
     VALUES ($1, $2, $3, $4, TRUE) ON CONFLICT (id) DO NOTHING`,
    [COACH_ID, `E2E 教練 ${SUFFIX}`, `09${SUFFIX.padStart(8, '0')}`.slice(0, 10), COACH_ID]);
  await pool.query(
    `INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [COACH_ID, VENUE_ID]);

  const at = tomorrow19();
  const autoAt = at.toISOString();
  const manualAt = new Date(at.getTime() + 2 * 3600 * 1000).toISOString();

  // ① auto：venue_id 為 NULL —— 這就是原本會被 INNER JOIN 吃掉的那種列
  const a = await pool.query(
    `INSERT INTO coach_availability_slots
       (coach_id, venue_id, start_at, duration_minutes, status, generated_by)
     VALUES ($1, NULL, $2, 60, 'available', 'auto') RETURNING id`, [COACH_ID, autoAt]);
  // ② 手建：有場館，作為對照組，確保修 JOIN 沒把原本能看到的弄丟
  const m = await pool.query(
    `INSERT INTO coach_availability_slots
       (coach_id, venue_id, start_at, duration_minutes, status, generated_by)
     VALUES ($1, $2, $3, 60, 'available', 'coach') RETURNING id`, [COACH_ID, VENUE_ID, manualAt]);

  return { autoId: a.rows[0].id, manualId: m.rows[0].id, from: at };
}

async function cleanup() {
  await pool.query(`DELETE FROM coach_availability_slots WHERE coach_id = $1`, [COACH_ID]);
  await pool.query(`DELETE FROM coach_venues WHERE coach_id = $1`, [COACH_ID]);
  await pool.query(`DELETE FROM coaches WHERE id = $1`, [COACH_ID]);
  await pool.query(`DELETE FROM venues WHERE id = $1`, [VENUE_ID]);
}

async function main() {
  const { autoId, manualId, from } = await setup();
  try {
    const token = signCoachToken({ coachId: COACH_ID, phone: '0900000000' });
    const fromYmd = new Date(from.getTime() - 86400000).toISOString().slice(0, 10);
    const toYmd = new Date(from.getTime() + 3 * 86400000).toISOString().slice(0, 10);

    const res = await fetch(
      `${BASE}/api/slots/coach/${COACH_ID}?from=${fromYmd}&to=${toYmd}`,
      { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(res.status, 200, `教練列表應回 200，實際 ${res.status}`);
    const rows = await res.json();

    const auto = rows.find((r) => r.id === autoId);
    const manual = rows.find((r) => r.id === manualId);

    assert.ok(auto, 'NULL venue 的自動時段必須出現在教練排課總表（INNER JOIN 迴歸）');
    assert.strictEqual(auto.is_auto, true, '自動時段的 is_auto 必須是 true（前端用嚴格 === true 判斷）');
    assert.strictEqual(auto.venue_id, null, '自動時段仍應保持 venue_id = NULL（跨場館未認領）');

    assert.ok(manual, '手建時段不得因為改 LEFT JOIN 而消失');
    assert.strictEqual(manual.is_auto, false, '手建時段的 is_auto 必須是 false，不能是 null/undefined');
    assert.ok(manual.venue_name, '手建時段仍應帶得出場館名');

    console.log('coach_auto_slot_visibility: PASS（自動時段可見、is_auto 正確、手建未迴歸）');
  } finally {
    await cleanup();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('coach_auto_slot_visibility: FAIL');
  console.error(err.message);
  cleanup().finally(() => process.exit(1));
});