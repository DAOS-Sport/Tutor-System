'use strict';
/**
 * 舊家教系統（ABLEPOS）移轉資料的標記。
 *
 * 匯入工具補進來的上課紀錄 checked_in_source='legacy_import'，報名單
 * external_order_no='ABLEPOS:<單據序號>'。薪資匯出與統計要分得出新舊系統
 * （擁有者 2026-10-20）：認不得的來源原樣顯示英文，會讓櫃檯以為是新系統簽到。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const legacy = { session_id: 's1', source: 'legacy_import', by: '舊系統', student: '王小明', at: '2026-09-03T02:00:00Z' };
const parent = { session_id: 's2', source: 'parent', by: '王大明', student: '王小明', at: '2026-10-03T02:00:00Z' };

(async () => {
  const fmt = await import('../client/admin/src/utils/format.js');
  const report = await import('../client/admin/src/utils/sessionReportRows.mjs');

  check('簽到來源標籤：legacy_import 顯示「舊系統轉移」', () => {
    assert.strictEqual(fmt.checkinSourceLabel('legacy_import'), '舊系統轉移');
    assert.strictEqual(fmt.checkinSourceLabel('parent'), '家長自助');
  });

  check('報名單：只有 ABLEPOS: 開頭的 external_order_no 算舊系統轉移', () => {
    assert.strictEqual(fmt.isLegacyImportOrder({ external_order_no: 'ABLEPOS:1234' }), true);
    assert.strictEqual(fmt.isLegacyImportOrder({ external_order_no: 'RAGIC:1234' }), false);
    assert.strictEqual(fmt.isLegacyImportOrder({ external_order_no: null }), false);
    assert.strictEqual(fmt.isLegacyImportOrder(null), false);
  });

  check('薪資匯出備註：舊系統上課第一行標［舊系統轉移］，簽到行來源也標出', () => {
    const lines = report.sessionReportNote({ checkin_details: [legacy] }).split('\n');
    assert.ok(lines[0].startsWith('［舊系統轉移］'), lines[0]);
    assert.ok(lines.some((line) => line.includes('｜舊系統轉移｜')), lines.join(' / '));
  });

  check('薪資匯出備註：新系統簽到不加舊系統標記', () => {
    assert.ok(!report.sessionReportNote({ checkin_details: [parent] }).includes('舊系統轉移'));
  });

  check('匯出列的備註欄帶到標記', () => {
    const row = report.sessionToRow({ date: '2026-09-03', checkin_details: [legacy], students: ['王小明'] });
    assert.ok(row[report.SESSION_HEADERS.indexOf('備註')].startsWith('［舊系統轉移］'));
  });

  check('上課紀錄表格摘要顯示舊系統轉移', () => {
    assert.strictEqual(fmt.sessionNoteSummary({ checkin_details: [legacy] }).tag, '舊系統轉移');
  });

  check('報名 API 清單／明細帶出 external_order_no', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/routes/admin/enrollments.js'), 'utf8');
    const shaper = src.slice(src.indexOf('function shapeEnrollmentRow'), src.indexOf('function shapeEnrollmentRow') + 4000);
    assert.ok(/external_order_no:\s*row\.external_order_no/.test(shaper), 'shapeEnrollmentRow 沒有帶 external_order_no');
  });

  check('教練頁：舊系統轉移有自己的標籤，且保留 coach 歷史分支', () => {
    const src = fs.readFileSync(path.join(ROOT, 'client/liff/src/pages/CoachSessionPage.jsx'), 'utf8');
    assert.ok(/'legacy_import'\)\s*return '舊系統轉移'/.test(src));
    assert.ok(/'coach'/.test(src));
  });

  check('家長端課程卡：/api/courses/mine 帶 is_legacy_import，卡片顯示舊系統轉移', () => {
    const api = fs.readFileSync(path.join(ROOT, 'server/routes/courses.js'), 'utf8');
    assert.ok(/admin_enrollments\.external_order_no/.test(api), '/mine 沒有選出 external_order_no');
    assert.ok(/is_legacy_import:\s*String\(row\.external_order_no \|\| ''\)\.startsWith\('ABLEPOS:'\)/.test(api));
    const card = fs.readFileSync(path.join(ROOT, 'client/liff/src/components/CourseCard.jsx'), 'utf8');
    assert.ok(/period\.is_legacy_import && \(/.test(card) && card.includes('舊系統轉移'));
  });

  check('家長登入發憑證時起算舊系統課程到期', () => {
    const auth = fs.readFileSync(path.join(ROOT, 'server/routes/auth.js'), 'utf8');
    const issue = auth.slice(auth.indexOf('function _issue('), auth.indexOf('const token = signParentToken({', auth.indexOf('function _issue(')));
    assert.ok(/startLegacyExpiryCountdown\(parent\.id\)\.catch\(/.test(issue), '_issue 沒有呼叫到期起算');
  });

  if (failed) {
    console.error('\nlegacy_import_marker_test: ' + failed + ' failed');
    process.exit(1);
  }
  console.log('legacy_import_marker_test: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
