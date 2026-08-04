'use strict';
/**
 * 教練關班（block / unblock / delete）的 E2E —— 全程打真的 HTTP route。
 *
 * 為什麼不能只在 DB 層測：這條路徑的正確性有一半在 route 上——ownership 守門、
 * 狀態守門、以及「解封要不要一併清掉跨週期記憶」。直接下 SQL 只會驗到
 * Postgres 會不會照做，把 route 的 WHERE 刪掉測試照樣綠。
 *
 * 用法（需要已啟動的 server 與可寫的 DB）：
 *   BASE_URL=http://localhost:3999 node tests/e2e/coach_block_flow.js
 */
const assert = require('assert');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SERVER_DIR = path.join(__dirname, '..', '..', 'server');
const { pool } = require(path.join(SERVER_DIR, 'models', 'db'));
const { signCoachToken } = require(path.join(SERVER_DIR, 'middlewares', 'coachAuth'));
const gen = require(path.join(SERVER_DIR, 'services', 'slotGenerator'));

const SUF = String(process.pid);
const COACH = `e2e0b10c-0000-4000-8000-${SUF.padStart(12, '0')}`;
const OTHER = `e2e0b10c-1111-4000-8000-${SUF.padStart(12, '0')}`;
const VENUE = `E2EB${SUF}`.slice(0, 10);

async function call(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空 body */ }
  return { status: res.status, body: json };
}

/** 台北時間的某個未來週一 15:00（+7n 天） */
function mondayAt15(weeksAhead) {
  const now = new Date(Date.now() + 8 * 3600 * 1000);       // 台北
  const ymd = now.toISOString().slice(0, 10);
  const d = new Date(`${ymd}T15:00:00+08:00`);
  const dow = new Date(d.getTime() + 8 * 3600 * 1000).getUTCDay();
  const addDays = ((1 - dow) + 7) % 7 || 7;                  // 下一個週一（不含今天）
  return new Date(d.getTime() + (addDays + weeksAhead * 7) * 86400000);
}

async function insertSlot(startAt, status = 'available', generatedBy = 'auto') {
  const r = await pool.query(
    `INSERT INTO coach_availability_slots
       (coach_id, venue_id, start_at, duration_minutes, status, generated_by)
     VALUES ($1, NULL, $2, 60, $3, $4) RETURNING id`,
    [COACH, startAt.toISOString(), status, generatedBy]);
  return r.rows[0].id;
}

async function setup() {
  await pool.query(
    `INSERT INTO venues (id, name, is_active) VALUES ($1,$2,TRUE) ON CONFLICT (id) DO NOTHING`,
    [VENUE, `E2E 關班場館 ${SUF}`]);
  // phone 有 unique 約束：兩位測試教練的號碼必須互不相同，也不能撞到既有資料。
  const phones = [`0900${SUF.padStart(6, '0')}`.slice(0, 10), `0901${SUF.padStart(6, '0')}`.slice(0, 10)];
  const names = [`E2E 關班教練 ${SUF}`, `E2E 他人 ${SUF}`];
  const ids = [COACH, OTHER];
  for (let i = 0; i < ids.length; i += 1) {
    await pool.query(
      `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active)
       VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (id) DO NOTHING`,
      [ids[i], names[i], phones[i], `${ids[i].slice(0, 8)}${i}`]);
  }
  await pool.query(
    `INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [COACH, VENUE]);
}

async function cleanup() {
  await pool.query(`DELETE FROM coach_availability_slots WHERE coach_id IN ($1,$2)`, [COACH, OTHER]);
  await pool.query(`DELETE FROM coach_venues WHERE coach_id IN ($1,$2)`, [COACH, OTHER]);
  await pool.query(`DELETE FROM coaches WHERE id IN ($1,$2)`, [COACH, OTHER]);
  await pool.query(`DELETE FROM venues WHERE id = $1`, [VENUE]);
}

async function markerOf(id) {
  const r = await pool.query(
    `SELECT status, blocked_by_coach_at FROM coach_availability_slots WHERE id = $1`, [id]);
  return r.rows[0];
}

(async () => {
  await cleanup();
  await setup();
  const token = signCoachToken({ coachId: COACH, phone: '0900000000' });
  const otherToken = signCoachToken({ coachId: OTHER, phone: '0900000001' });
  try {
    const w1 = mondayAt15(0);
    const slotA = await insertSlot(w1);

    // ① 關班：available → blocked，且寫下「教練自己關的」標記
    {
      const r = await call('PATCH', `/api/slots/${slotA}/block`, token);
      assert.strictEqual(r.status, 200, `① 關班應回 200，實際 ${r.status}`);
      const m = await markerOf(slotA);
      assert.strictEqual(m.status, 'blocked');
      assert.ok(m.blocked_by_coach_at, '① 必須寫下 blocked_by_coach_at，否則智慧記憶不會沿用');
    }

    // ② 重複關班要被擋（狀態守門）
    assert.strictEqual((await call('PATCH', `/api/slots/${slotA}/block`, token)).status, 409,
      '② 已 blocked 不得再關一次');

    // ③ 已關閉的槽位不得被刪除（刪除只限 available）
    assert.strictEqual((await call('DELETE', `/api/slots/${slotA}`, token)).status, 409,
      '③ blocked 槽位不可刪除');

    // ④ 別的教練不能碰（IDOR）
    for (const [method, p] of [['PATCH', `/api/slots/${slotA}/unblock`], ['DELETE', `/api/slots/${slotA}`]]) {
      assert.strictEqual((await call(method, p, otherToken)).status, 403,
        `④ 他人 token 打 ${method} ${p} 必須 403`);
    }
    // 未登入一律擋
    assert.ok([401, 403].includes((await call('PATCH', `/api/slots/${slotA}/block`, null)).status),
      '④ 未登入必須被擋');

    // ⑤ 智慧記憶真的沿用：下個週期的同一個星期幾＋時刻會被建成 blocked
    {
      const blocks = await gen.__loadPreviousBlocksForTest
        ? await gen.__loadPreviousBlocksForTest(COACH, 21, pool)
        : (await pool.query(
          `SELECT start_at FROM coach_availability_slots
            WHERE coach_id=$1 AND blocked_by_coach_at IS NOT NULL
              AND start_at >= NOW() - INTERVAL '21 days'`, [COACH])).rows;
      const keys = gen.buildBlockedKeys(blocks);
      const hhmm = new Date(w1.getTime() + 8 * 3600000).toISOString().slice(11, 16);
      const wd = new Date(w1.getTime() + 8 * 3600000).getUTCDay();
      assert.ok(keys.has(gen.carryKey(wd, hhmm)),
        '⑤ 教練關掉的時段必須進入 carry-forward 記憶');
    }

    // ⑥ 產生器建立的 blocked 不得寫標記——否則會讀到自己的輸出，
    //    一次性關班自我複製成永久關班，解封收不回來。
    {
      const carried = await insertSlot(mondayAt15(3), 'blocked', 'auto'); // 模擬產生器沿用而建
      const m = await markerOf(carried);
      assert.strictEqual(m.blocked_by_coach_at, null,
        '⑥ 沿用而建的 blocked 不得帶標記');

      // ⑦ 解封「沿用出來的那一格」必須連原始記憶一起清掉，
      //    否則下個週期又會被關回去，UI 承諾的「隨時可以再打開」不成立。
      const r = await call('PATCH', `/api/slots/${carried}/unblock`, token);
      assert.strictEqual(r.status, 200, `⑦ 解封應回 200，實際 ${r.status}`);
      assert.strictEqual((await markerOf(carried)).status, 'available');

      const still = await pool.query(
        `SELECT COUNT(*)::int n FROM coach_availability_slots
          WHERE coach_id=$1 AND blocked_by_coach_at IS NOT NULL`, [COACH]);
      assert.strictEqual(still.rows[0].n, 0,
        '⑦ 解封後同一星期幾＋時刻的記憶必須全部清空，實際還剩 ' + still.rows[0].n);
      assert.ok(r.body && r.body.carry_memory_cleared >= 1,
        '⑦ 回應要說明清掉了幾筆記憶');
    }

    // ⑧ 解封後不得再沿用
    {
      const rows = (await pool.query(
        `SELECT start_at FROM coach_availability_slots
          WHERE coach_id=$1 AND blocked_by_coach_at IS NOT NULL`, [COACH])).rows;
      assert.strictEqual(gen.buildBlockedKeys(rows).size, 0, '⑧ 記憶應為空');
    }

    // ⑨ available 槽位可以刪除；不存在的槽位回 404
    {
      const tmp = await insertSlot(mondayAt15(5));
      assert.strictEqual((await call('DELETE', `/api/slots/${tmp}`, token)).status, 200);
      assert.strictEqual((await call('DELETE', `/api/slots/${tmp}`, token)).status, 404,
        '⑨ 已刪除的槽位再刪應 404');
    }

    console.log('coach_block_flow: PASS（9 項全通過，全程打真 route）');
  } finally {
    await cleanup();
    await pool.end();
  }
})().catch((err) => {
  console.error('coach_block_flow: FAIL —', err.message);
  cleanup().finally(() => process.exit(1));
});