// 舊系統轉移、已在舊系統結算的課（使用者 2026-11-04）：上課紀錄要顯眼標「不計薪」，核薪人員看得清楚。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { transformSync, buildSync } = createRequire(path.join(root, 'client/admin/package.json'))('esbuild');

// 1. 備註摘要：舊系統已結算 → 橘色「舊系統轉移・不計薪」；其他情況照舊（format.js 有 import，用 bundle 載入）
const code = buildSync({ entryPoints: [path.join(root, 'client/admin/src/utils/format.js')], bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
const { sessionNoteSummary } = mod.exports;
const legacy = sessionNoteSummary({ legacy_settled: true, checkin_details: [{ source: 'legacy_import', by: '王' }] });
assert.equal(legacy.tag, '舊系統轉移・不計薪');
assert.equal(legacy.tone, 'amber');
assert.match(legacy.text, /不計教練堂數/);
assert.equal(sessionNoteSummary({ checkin_details: [{ source: 'parent', by: '王' }] }).tag, '家長自助');
assert.equal(sessionNoteSummary({ lesson_over_cap: true, lesson_cap_notes: ['x'] }).tag, '超過購買堂數');

// 2. 後端把標記交給前端
const route = read('server/routes/admin/sessions.js');
assert.ok(route.includes('legacy_settled: r.legacy_settled === true,'));
assert.ok(route.includes('legacy_checkin_at: r.legacy_checkin_at || null,'));

// 3. 列表簽到時間欄與課程詳情都標出來，JSX 編得過
const page = read('client/admin/src/pages/SessionsPage.jsx');
const modal = read('client/admin/src/components/SessionDetailModal.jsx');
assert.ok(page.includes(': r.legacy_settled') && page.includes('舊系統轉移・不計薪'));
assert.ok(modal.includes('session.legacy_settled &&') && modal.includes('舊系統轉移・不計薪'));
for (const src of [page, modal]) transformSync(src, { loader: 'jsx' });
console.log('PASS: legacy-settled lessons are marked 舊系統轉移・不計薪 in list, note and detail');
