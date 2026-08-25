'use strict';
/**
 * 整合 API（U16）的資料暴露面與 fail-closed 行為。
 *
 * ── 為什麼要有這支 ──
 * 這是本系統第一支「給系統外部的東西打」的業務資料端點。上課紀錄是一份
 * 「誰、在哪、幾點、跟誰上課」的名冊，多數是未成年學員。
 * tests/public_api_exposure_test.js 記著上一次的教訓：欄位白名單做在 JS 層、
 * 沒擋住「可以整包枚舉」，結果 165 筆教練名冊連同計價資訊整份被端走。
 *
 * 所以這支鎖三件事，而且盡量用「真的呼叫函式」而不是掃字串：
 *   1. SQL 根本沒把 PII 撈出來（不是撈了再過濾）
 *   2. 回傳物件的鍵集合「完全等於」白名單，多一個就紅
 *   3. 金鑰設定壞掉時是拒絕，不是放行
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const integrations = require('../server/routes/integrations');
const { shapeSession, SESSIONS_SQL, MAX_WINDOW_MIN, MAX_DATE_OFFSET_DAYS } = integrations.__test__;
const { __test__: authTest } = require('../server/middlewares/integrationAuth');
const routeSource = fs.readFileSync(path.join(ROOT, 'server/routes/integrations.js'), 'utf8');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// ── 1. SQL 沒有把 PII 撈出來 ──────────────────────────────────
// 「撈了再用 JS 過濾」跟「根本沒撈」的差別，在於哪天有人多寫一行 res.json(row)
// 會不會外洩。這裡要的是後者。
check('SQL 不含扣課原因與操作者', () => {
  for (const forbidden of ['deduction_reason', 'deducted_by', 'manual_lesson_deductions']) {
    assert.ok(!SESSIONS_SQL.includes(forbidden), `SQL must not select ${forbidden}`);
  }
});
check('SQL 不 JOIN parents，也不撈電話', () => {
  assert.ok(!/\bparents\b/.test(SESSIONS_SQL), 'SQL must not touch the parents table');
  assert.ok(!/\bphone\b/.test(SESSIONS_SQL), 'SQL must not select any phone column');
});
check('SQL 不組 checkin_details（裡面有家長全名）', () => {
  assert.ok(!SESSIONS_SQL.includes('checked_in_by_parent_id'), 'no parent identity in checkin details');
  assert.ok(!SESSIONS_SQL.includes('checkin_details'), 'checkin_details must not be built at all');
});
check('SQL 濾掉已取消的課堂', () => {
  assert.ok(SESSIONS_SQL.includes("cs.status::text NOT LIKE 'cancelled%'"),
    'cancelled sessions must not show up as if they were happening');
});
check('SQL 強制以 venue 為條件（不能裸列舉）', () => {
  assert.ok(/cp\.venue_id = \$1/.test(SESSIONS_SQL), 'real sessions must be venue-scoped in SQL');
  assert.ok(/ats\.venue_id = \$1/.test(SESSIONS_SQL), 'legacy table must be venue-scoped too');
});
check('SQL 有 UNION 舊表 admin_today_sessions', () => {
  // 少收會讓後台看得到的課在救生台查不到，等於把合法課程判成「待查」去質疑教練。
  assert.ok(SESSIONS_SQL.includes('admin_today_sessions'),
    'the legacy table the admin page unions must be included, or the field tool under-reports');
});

// ── 2. 回傳形狀：鍵集合完全等於白名單 ────────────────────────
const WHITELIST = [
  'id', 'date', 'start', 'end', 'venue_id', 'coach', 'course_type',
  'is_experience_course', 'student_count', 'students', 'checkin_status', 'checkin_at',
].sort();

const ROW = {
  id: 'abc', date: '2026-08-25', start_time: '14:00', end_time: '15:00',
  sort_at: '2026-08-25T06:00:00Z', venue_id: 'L', coach: '王大明', course_type: 3,
  is_experience_course: true,
  student_names: ['林育睿', '何劼丞', '江睿芸'],
  checkin_status: 'checked_in', checkin_at: '2026-08-25T06:03:00Z',
  // 就算上游哪天多 SELECT 了這些，shapeSession 也不可以把它們帶出去
  deduction_reason: '櫃檯補扣', deducted_by: '吳承融', parent_phone: '0922107211',
};

check('回傳鍵集合完全等於白名單（多一個就紅）', () => {
  const keys = Object.keys(shapeSession(ROW)).sort();
  assert.deepStrictEqual(keys, WHITELIST,
    'the response shape is the exposure surface — it must be exact, not a superset');
});
check('上游多餘欄位不會被帶出去', () => {
  const out = shapeSession(ROW);
  for (const leak of ['deduction_reason', 'deducted_by', 'parent_phone', 'student_names']) {
    assert.ok(!(leak in out), `${leak} must not appear in the response`);
  }
});
check('學員姓名一律遮罩，且遮罩後不等於原值', () => {
  const out = shapeSession(ROW);
  assert.strictEqual(out.student_count, 3, 'count comes from the real roster');
  assert.deepStrictEqual(out.students, ['林同學', '何同學', '江同學']);
  for (const original of ROW.student_names) {
    assert.ok(!out.students.includes(original), `${original} must never be returned in full`);
  }
});
check('教練姓名刻意不遮（救生員要對得到人）', () => {
  assert.strictEqual(shapeSession(ROW).coach, '王大明',
    'masking the coach would make the whole tool useless at the poolside');
});
check('試上標記有帶出去（游泳池試教就是靠這個旗標）', () => {
  assert.strictEqual(shapeSession(ROW).is_experience_course, true);
  assert.strictEqual(shapeSession({ ...ROW, is_experience_course: null }).is_experience_course, false);
});
check('沒有名單時不會炸，回空陣列與 0', () => {
  const out = shapeSession({ ...ROW, student_names: null });
  assert.deepStrictEqual(out.students, []);
  assert.strictEqual(out.student_count, 0);
});

// ── 3. 查詢範圍上限 ─────────────────────────────────────────
check('時間窗與日期範圍有上限', () => {
  assert.ok(MAX_WINDOW_MIN <= 480, 'a field tool never needs more than one shift of data');
  assert.ok(MAX_DATE_OFFSET_DAYS <= 7, 'browsing history is not this endpoint’s job');
});
check('沒帶 venue_id 直接 400', () => {
  assert.ok(routeSource.includes("code: 'VENUE_REQUIRED'"), 'bare queries must be rejected');
});
check('越權場館回 403 並留下警告紀錄', () => {
  assert.ok(routeSource.includes("code: 'VENUE_OUT_OF_SCOPE'"));
  assert.ok(routeSource.includes("severity: 'warning'"), 'out-of-scope access must be auditable');
});
check('場館可即時停用，且停用檢查在查資料之前', () => {
  // 金鑰在 Secrets 裡、改了要重新部署；真的要切斷時靠的是這個 DB 開關。
  assert.ok(routeSource.includes("code: 'VENUE_DISABLED'"), 'a per-venue kill switch must exist');
  const disabledAt = routeSource.indexOf('VENUE_DISABLED');
  const queryAt = routeSource.indexOf('pool.query(SESSIONS_SQL');
  assert.ok(disabledAt > 0 && queryAt > disabledAt,
    'the kill switch must short-circuit before any data is read');
});

// ── 4. 金鑰設定 fail-closed ─────────────────────────────────
const { loadKeys, sameKey } = authTest;
const ORIGINAL = process.env.INTEGRATION_KEYS;
const withEnv = (value, fn) => {
  if (value === undefined) delete process.env.INTEGRATION_KEYS;
  else process.env.INTEGRATION_KEYS = value;
  try { return fn(); } finally {
    if (ORIGINAL === undefined) delete process.env.INTEGRATION_KEYS;
    else process.env.INTEGRATION_KEYS = ORIGINAL;
  }
};
const KEY = 'k'.repeat(40);

check('未設定 → null（呼叫端據此回 503，不是放行）', () => {
  assert.strictEqual(withEnv(undefined, loadKeys), null);
  assert.strictEqual(withEnv('   ', loadKeys), null);
});
check('JSON 壞掉 → null，不可以當成沒有限制', () => {
  assert.strictEqual(withEnv('{not json', loadKeys), null);
  assert.strictEqual(withEnv('[]', loadKeys), null, 'an array is not a key map');
});
check('太短的金鑰不收（避免有人填 "test"）', () => {
  const parsed = withEnv(JSON.stringify({ short: { label: 'x', venue_ids: ['L'] } }), loadKeys);
  assert.strictEqual(parsed, null, 'a config with only invalid keys must resolve to null, not an empty pass');
});
check('正常設定 → 解析出 label 與場館綁定', () => {
  const parsed = withEnv(JSON.stringify({ [KEY]: { label: '三民高中救生台', venue_ids: ['L'] } }), loadKeys);
  assert.ok(parsed instanceof Map);
  assert.deepStrictEqual(parsed.get(KEY), { label: '三民高中救生台', venueIds: ['L'] });
});
check('venue_ids 空陣列視同不限場館（由路由層再把關）', () => {
  const parsed = withEnv(JSON.stringify({ [KEY]: { label: 'x', venue_ids: [] } }), loadKeys);
  assert.strictEqual(parsed.get(KEY).venueIds, null);
});
check('金鑰比對長度不同不會丟例外', () => {
  assert.strictEqual(sameKey('abc', 'abcd'), false);
  assert.strictEqual(sameKey(KEY, KEY), true);
  assert.strictEqual(sameKey(KEY, 'x'.repeat(40)), false);
});

if (failed) {
  console.error(`\nintegration_api_exposure_test: ${failed} FAILED`);
  process.exit(1);
}
console.log('integration_api_exposure_test: PASS');
