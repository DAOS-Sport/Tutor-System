'use strict';
// F-A06 閱讀原則：被開放某頁的角色，該頁用到的每支 GET API 都要讀得到。
// 實際比對由 scripts/audit-page-permissions.js 做（載入真的 Express router + 解析前端）。
const assert = require('node:assert/strict');
const { audit, EXPECTED_GAPS } = require('../scripts/audit-page-permissions');

const { findings, stale, unmatched, pages, routes } = audit();

assert.ok(Object.keys(pages).length >= 30 && routes.length >= 150, '分析器沒讀到頁面或路由，結果不可信');
assert.deepEqual(unmatched, [], '有前端呼叫對不到後端路由：分析器漏判或前端打了不存在的 API');

const manual = pages['/manual-enroll'].calls.find((c) => c.via === 'customerParentsApi.list');
assert.ok(manual, '分析器要能追到手動建檔頁的家長搜尋（驗證跨檔追蹤有效）');

assert.deepEqual(
  findings.map((f) => `${f.page} → ${f.api}（${f.blocked.join('；')}）`), [],
  '頁面打得開、資料卻 403：把該頁的 key 加進那支 API 的 requireAnyResource，或在前端用 can() 擋住並登記 EXPECTED_GAPS');
assert.deepEqual(stale.map((e) => `${e.page} → ${e.api}`), [], 'EXPECTED_GAPS 有已不存在的缺口，請移除');
for (const e of EXPECTED_GAPS) assert.ok(e.why && e.why.length > 20, `${e.page} 的例外要寫清楚前端在哪裡擋`);

console.log(`PASS ${Object.keys(pages).length} 個後台頁面的 GET API 都讀得到（${EXPECTED_GAPS.length} 個登記例外）`);
