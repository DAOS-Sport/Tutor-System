// 家長端首頁：家教班課程使用期限及退費說明（老闆 2026-11-03 指示，告知義務）。
// 實際渲染元件檢查條文，並檢查首頁擺在三條橫幅上方。不連資料庫。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(root, 'client/liff/package.json'));
const React = appRequire('react');
const { renderToStaticMarkup } = appRequire('react-dom/server');
const { transformSync } = appRequire('esbuild');

function load(file) {
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs', target: 'node20' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (n) => (n === 'react' ? React : appRequire(n)) }, { filename: file });
  return module.exports;
}

const notice = load(path.join(root, 'client/liff/src/components/RefundPolicyNotice.jsx'));
assert.equal(notice.REFUND_POLICY_ITEMS.length, 7);
const html = renderToStaticMarkup(React.createElement(notice.default));
assert.match(html, /家教班課程使用期限及退費說明/);
assert.match(html, /<details/, 'Collapsed by default so the home page stays short');
for (const [head] of notice.REFUND_POLICY_ITEMS) assert.ok(html.includes(head), 'Missing clause: ' + head);
assert.match(html, /每一期課程自購課（完成付款）日起一年內有效/, 'Per-period one year (owner decision)');
assert.match(html, /手續費新臺幣 50 元/, 'Fixed 50 dollar fee (owner decision)');
assert.match(html, /版本 2026-11-03/);

const home = fs.readFileSync(path.join(root, 'client/liff/src/pages/HomePage.jsx'), 'utf8');
const at = (s) => { const i = home.indexOf(s); assert.ok(i >= 0, 'Missing in HomePage: ' + s); return i; };
const pos = at('<RefundPolicyNotice />');
assert.ok(at('準備好開始今天的訓練了嗎') < pos, 'Notice goes under the greeting card');
assert.ok(pos < at('<GuideEntry'), 'Notice above the guide banner');
assert.ok(pos < at('上課記錄/簽到'), 'Notice above the check-in banner');
assert.ok(pos < at('試上課程'), 'Notice above the trial banner');

// 報名握手的勾選框和首頁說明共用同一份條文。
const agree = renderToStaticMarkup(React.createElement(notice.PolicyAgreement, { checked: false, onChange() {} }));
assert.match(agree, /type="checkbox"/);
assert.match(agree, /我已閱讀並同意《家教班課程使用期限及退費說明》/);
console.log('PASS: refund policy notice renders 7 clauses (per-period one year, 50 fee, version) and sits above the home banners');
