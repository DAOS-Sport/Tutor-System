/**
 * 整合 API（U16）端到端實測 —— 全新程序、真 HTTP、真 DB。
 *
 * 靜態斷言看不到的東西在這裡驗：中介層有沒有真的掛上、金鑰錯了是不是真的 401、
 * 遮罩有沒有真的套用在「從資料庫撈出來的真名」上、取消的課會不會真的消失。
 *
 * INTEGRATION_KEYS 由本程序自行設定，真路由掛在程序內的 Express（見下方 KEY / BAD_KEY）。
 * 測試資料在 finally 全部刪除。
 */
const assert = require('assert');
const path = require('path');
const { randomUUID } = require('crypto');

const SERVER = path.resolve(__dirname, '../../server');
const express = require(path.join(SERVER, 'node_modules', 'express'));
const { pool } = require(path.join(SERVER, 'models', 'db'));

const KEY = process.env.E2E_INTEGRATION_KEY || ('e2e' + 'k'.repeat(45));
const BAD_KEY = 'b'.repeat(48);
const VENUE = 'B';
const OTHER_VENUE = 'C';
const KILL_KEY = process.env.E2E_INTEGRATION_KILL_KEY || ('e2ekill' + 'x'.repeat(41));
const KILL_VENUE = 'K';

// 金鑰設定屬於伺服器環境，測試管不到外部伺服器（沒設就是 503）→ 在本程序設好
// INTEGRATION_KEYS，並把真路由（含 requireIntegrationKey）掛在程序內的 Express 上。
process.env.INTEGRATION_KEYS = JSON.stringify({
  [KEY]: { label: 'e2e 整合測試', venue_ids: [VENUE] },
  [KILL_KEY]: { label: 'e2e 場館停用測試', venue_ids: [KILL_VENUE] },
});
const integrationsRouter = require(path.join(SERVER, 'routes', 'integrations'));
let BASE = null;
let server = null;

async function startRouteServer() {
  const app = express();
  app.use('/api/integrations', integrationsRouter);
  server = await new Promise((resolve) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
  });
  BASE = `http://127.0.0.1:${server.address().port}`;
}

async function api(qs, { key } = {}) {
  const r = await fetch(`${BASE}/api/integrations/sessions${qs}`, {
    headers: key ? { Authorization: 'Bearer ' + key } : {},
  });
  let data = null;
  try { data = await r.json(); } catch { /* 空回應 */ }
  return { status: r.status, data };
}

const created = { periods: [], sessions: [] };
// 家長、學員、教練自建，不借用庫裡現成的資料。
const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
const parentId = randomUUID();
const coach = randomUUID();

async function makeSession({ minutesFromNow, status = 'confirmed', studentIds, isExperience }) {
  const cp = await pool.query(
    `INSERT INTO course_periods (coach_id, venue_id, course_type, expires_at,
                                 original_price, final_price, is_experience_course)
     VALUES ($1,$2,3, CURRENT_DATE + 90, 3300, 3300, $3) RETURNING id`,
    [coach, VENUE, !!isExperience]);
  created.periods.push(cp.rows[0].id);
  for (const sid of studentIds) {
    await pool.query(
      `INSERT INTO course_period_enrollments (course_period_id, student_id, status)
       VALUES ($1,$2,'active')`, [cp.rows[0].id, sid]);
  }
  const cs = await pool.query(
    `INSERT INTO course_sessions (course_period_id, scheduled_at, duration_minutes, status)
     VALUES ($1, NOW() + make_interval(mins => $2), 60, $3) RETURNING id`,
    [cp.rows[0].id, minutesFromNow, status]);
  created.sessions.push(cs.rows[0].id);
  return cs.rows[0].id;
}

(async () => {
  await startRouteServer();
  const digits = String(parseInt(suffix, 16)).padStart(10, '0').slice(-8);
  await pool.query(
    `INSERT INTO coaches (id, name, phone, ragic_employee_id, is_active, pricing_multiplier)
     VALUES ($1, $2, $3, $4, TRUE, 1.00)`,
    [coach, `整合測試教練${suffix}`, `03${digits}`, `E2E-INTEG-${suffix}`]);
  await pool.query(
    `INSERT INTO parents (id, name, phone, is_active) VALUES ($1, $2, $3, TRUE)`,
    [parentId, `整合測試家長${suffix}`, `09${digits}`]);
  const students = (await pool.query(
    `INSERT INTO students (parent_id, name) VALUES ($1, $2), ($1, $3), ($1, $4) RETURNING id, name`,
    [parentId, `整合甲${suffix}`, `整合乙${suffix}`, `整合丙${suffix}`])).rows;

  const liveId = await makeSession({ minutesFromNow: 10, studentIds: students.map((s) => s.id), isExperience: true });
  const deadId = await makeSession({ minutesFromNow: 20, status: 'cancelled_normal', studentIds: [students[0].id] });

  // ── 1. 認證 ────────────────────────────────────────────────
  let r = await api(`?venue_id=${VENUE}`);
  assert.strictEqual(r.status, 401, '沒帶金鑰必須 401，got ' + r.status);
  assert.strictEqual(r.data.code, 'KEY_REQUIRED');
  r = await api(`?venue_id=${VENUE}`, { key: BAD_KEY });
  assert.strictEqual(r.status, 401, '錯金鑰必須 401，got ' + r.status);
  assert.strictEqual(r.data.code, 'KEY_INVALID');
  console.log('✅ 1 未帶／錯誤金鑰一律 401');

  // ── 2. 必須指定場館，且不得越權 ────────────────────────────
  r = await api('', { key: KEY });
  assert.strictEqual(r.status, 400, '裸查詢必須 400，got ' + r.status);
  assert.strictEqual(r.data.code, 'VENUE_REQUIRED');
  r = await api(`?venue_id=${OTHER_VENUE}`, { key: KEY });
  assert.strictEqual(r.status, 403, '越權場館必須 403，got ' + r.status);
  assert.strictEqual(r.data.code, 'VENUE_OUT_OF_SCOPE');
  console.log('✅ 2 不得裸列舉、不得跨場館');

  // ── 3. 正常查詢：欄位、遮罩、試上標記 ──────────────────────
  r = await api(`?venue_id=${VENUE}&window=60`, { key: KEY });
  assert.strictEqual(r.status, 200, '正常查詢失敗 → ' + JSON.stringify(r));
  assert.strictEqual(r.data.venue_id, VENUE);
  assert.ok(r.data.server_time, '要回伺服器時間（現場平板時鐘不可信）');
  const row = r.data.sessions.find((s) => s.id === liveId);
  assert.ok(row, '剛建立的課必須查得到');
  assert.strictEqual(row.student_count, 3, '人數要對得上名單');
  assert.strictEqual(row.is_experience_course, true, '試上標記要帶出來');
  assert.strictEqual(row.checkin_status, 'not_yet', '沒人簽到就是 not_yet');
  assert.ok(row.coach && row.coach.length > 0, '教練姓名必須有值（救生員要對人）');
  console.log('✅ 3 正常查詢：欄位與試上標記正確');

  // ── 4. 學員全名絕不外流 ────────────────────────────────────
  const body = JSON.stringify(r.data);
  for (const s of students) {
    assert.ok(!body.includes(s.name), `學員全名「${s.name}」不可出現在回應中`);
  }
  for (const masked of row.students) {
    assert.ok(masked.endsWith('同學'), '學員一律遮成「X同學」，實得 ' + masked);
  }
  assert.deepStrictEqual(Object.keys(row).sort(), [
    'checkin_at', 'checkin_status', 'coach', 'course_type', 'date', 'end',
    'id', 'is_experience_course', 'start', 'student_count', 'students', 'venue_id',
  ], '回傳鍵集合必須完全等於白名單');
  console.log('✅ 4 學員全名不外流，鍵集合等於白名單');

  // ── 5. 取消的課不可出現（否則救生員會找一堂不存在的課）──────
  assert.ok(!r.data.sessions.some((s) => s.id === deadId), '已取消的課堂不可出現');
  console.log('✅ 5 已取消的課堂不出現');

  // ── 6. 日期範圍上限 ────────────────────────────────────────
  r = await api(`?venue_id=${VENUE}&date=2020-01-01`, { key: KEY });
  assert.strictEqual(r.status, 400, '超出範圍的日期必須 400，got ' + r.status);
  assert.strictEqual(r.data.code, 'DATE_OUT_OF_RANGE');
  r = await api(`?venue_id=${VENUE}&date=not-a-date`, { key: KEY });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.code, 'DATE_INVALID');
  console.log('✅ 6 日期範圍與格式把關');

  // ── 7. 存取有留下紀錄（稽核工具自己也要可稽核）──────────────
  const logs = await pool.query(
    `SELECT action, severity, admin_id FROM audit_logs
      WHERE target_type = 'integration_sessions' AND at >= NOW() - make_interval(mins => 5)
      ORDER BY at DESC LIMIT 10`);
  assert.ok(logs.rowCount > 0, '存取紀錄必須寫進 audit_logs');
  assert.ok(logs.rows.some((x) => x.severity === 'warning'),
    '認證失敗／越權必須留下 warning 等級的紀錄');
  console.log(`✅ 7 存取紀錄已寫入（${logs.rowCount} 筆，含 warning）`);

  // ── 8. 場館即時停用（不必重新部署就能切斷）────────────────
  await pool.query(
    `INSERT INTO admin_settings (key, value) VALUES ($1, 0)
       ON CONFLICT (key) DO UPDATE SET value = 0, updated_at = NOW()`,
    [`integration_venue_enabled_${KILL_VENUE}`]);
  try {
    r = await api(`?venue_id=${KILL_VENUE}&window=60`, { key: KILL_KEY });
    assert.strictEqual(r.status, 403, '停用的場館必須 403，got ' + r.status + ' ' + JSON.stringify(r.data));
    assert.strictEqual(r.data.code, 'VENUE_DISABLED');
    assert.ok(!r.data.sessions, '停用時不可以回任何課堂資料');
  } finally {
    await pool.query('DELETE FROM admin_settings WHERE key = $1',
      [`integration_venue_enabled_${KILL_VENUE}`]);
  }
  console.log('✅ 8 場館可即時停用，停用時不吐任何資料');

  console.log('\ne2e_integration_sessions: ALL PASS');
})()
  .catch((e) => { console.error('\n❌ FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    if (created.sessions.length) {
      await pool.query('DELETE FROM course_sessions WHERE id = ANY($1)', [created.sessions]);
    }
    if (created.periods.length) {
      await pool.query('DELETE FROM course_period_enrollments WHERE course_period_id = ANY($1)', [created.periods]);
      await pool.query('DELETE FROM course_periods WHERE id = ANY($1)', [created.periods]);
    }
    await pool.query('DELETE FROM students WHERE parent_id = $1', [parentId]).catch(() => {});
    await pool.query('DELETE FROM parents WHERE id = $1', [parentId]).catch(() => {});
    await pool.query('DELETE FROM coaches WHERE id = $1', [coach]).catch(() => {});
    console.log(`(已清除 ${created.sessions.length} 堂測試課、${created.periods.length} 個測試課期)`);
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });
