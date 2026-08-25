/**
 * 整合 API（U16）端到端實測 —— 全新程序、真 HTTP、真 DB。
 *
 * 靜態斷言看不到的東西在這裡驗：中介層有沒有真的掛上、金鑰錯了是不是真的 401、
 * 遮罩有沒有真的套用在「從資料庫撈出來的真名」上、取消的課會不會真的消失。
 *
 * 需要 server 啟動時帶 INTEGRATION_KEYS（見下方 KEY / BAD_KEY）。
 * 測試資料在 finally 全部刪除。
 */
const assert = require('assert');
const path = require('path');

const SERVER = path.resolve(__dirname, '../../server');
const { pool } = require(path.join(SERVER, 'models', 'db'));

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const KEY = process.env.E2E_INTEGRATION_KEY || ('e2e' + 'k'.repeat(45));
const BAD_KEY = 'b'.repeat(48);
const VENUE = 'B';
const OTHER_VENUE = 'C';

async function api(qs, { key } = {}) {
  const r = await fetch(`${BASE}/api/integrations/sessions${qs}`, {
    headers: key ? { Authorization: 'Bearer ' + key } : {},
  });
  let data = null;
  try { data = await r.json(); } catch { /* 空回應 */ }
  return { status: r.status, data };
}

const created = { periods: [], sessions: [] };

async function makeSession({ minutesFromNow, status = 'confirmed', studentIds, isExperience }) {
  const coach = (await pool.query('SELECT id FROM coaches LIMIT 1')).rows[0].id;
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
  const students = (await pool.query('SELECT id, name FROM students ORDER BY created_at LIMIT 3')).rows;
  assert.ok(students.length === 3, 'need 3 students in the dev DB');

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
    console.log(`(已清除 ${created.sessions.length} 堂測試課、${created.periods.length} 個測試課期)`);
    await pool.end();
  });
