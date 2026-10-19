'use strict';
// 家長端「選擇教練」卡片：1對N 顯示最終金額（單價 × N 人），1對1 維持原樣。
// 1對N 個人報名一次要選滿 N 位，結帳金額就是單價 × N（useEnrollmentPricing 的 subtotal）；
// 卡片只寫單價，家長按進去才發現金額翻倍。這裡實際渲染 CoachCard，看家長看得到的文字。
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(root, 'client/admin/package.json'));
const React = appRequire('react');
const { renderToStaticMarkup } = appRequire('react-dom/server');
const { buildSync } = appRequire('esbuild');

const bundled = buildSync({
  entryPoints: [path.join(root, 'client/liff/src/components/CoachCard.jsx')],
  bundle: true, write: false, format: 'cjs', platform: 'node', loader: { '.js': 'jsx' }, external: ['react'],
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', 'require', bundled)(mod, mod.exports, (n) => (n === 'react' ? React : require(n)));
const { default: CoachCard, coachCardPrice } = mod.exports;

const text = (props) => renderToStaticMarkup(React.createElement(CoachCard, { onSelect() {}, ...props }))
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const coach = (multiplier) => ({ id: 'c1', name: '合成教練', multiplier, pricing_multiplier: multiplier });
const base = { basePrice: 3750, sessionsPerPeriod: 6 };

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

check('1對1：金額與標示不變', () => {
  const t = text({ coach: coach(1), ...base, seats: 1 });
  assert.match(t, /NT\$ ?3,750/);
  assert.match(t, /\/ 6 堂/);
  assert.doesNotMatch(t, /每人|人・/);
});

check('1對2、係數 100%：主價格是 2 人合計，另標每人單價', () => {
  const t = text({ coach: coach(1), ...base, seats: 2 });
  assert.match(t, /NT\$ ?7,500/);
  assert.match(t, /\/ 2 人・6 堂/);
  assert.match(t, /每人 NT\$ ?3,750/);
});

check('1對2、係數 120%：合計 9,000，刪除線原價也是 2 人份', () => {
  const t = text({ coach: coach(1.2), ...base, seats: 2 });
  assert.match(t, /NT\$ ?9,000/);
  assert.match(t, /NT\$ ?7,500/, '刪除線原價要乘人數');
  assert.match(t, /每人 NT\$ ?4,500/);
});

check('卡片合計＝單價 × 人數（與報名頁 subtotal 同一算法）', () => {
  for (const seats of [1, 2, 3, 4, 5, 6]) for (const m of [1, 1.2, 1.5]) {
    const p = coachCardPrice({ coach: coach(m), ...base, seats });
    assert.equal(p.total, p.unit * seats, JSON.stringify({ seats, m }));
  }
});

check('試上 1對3：每人每堂 × 3', () => {
  const p = coachCardPrice({ coach: coach(1), ...base, isTrial: true, trialPrice: 700, seats: 3 });
  assert.equal(p.total, p.unit * 3);
  assert.match(text({ coach: coach(1), ...base, isTrial: true, trialPrice: 700, seats: 3 }), /\/ 3 人・試上 1 堂/);
});

check('價格未定時不顯示金額、也不顯示每人', () => {
  const t = text({ coach: coach(null), ...base, seats: 2 });
  assert.match(t, /價格待確認/);
  assert.doesNotMatch(t, /每人/);
});

check('沒傳 seats（舊呼叫端）等同 1 人', () => {
  assert.equal(coachCardPrice({ coach: coach(1), ...base }).total, 3750);
});

if (failures) { console.error(`coach_card_group_total_test: ${failures} FAIL`); process.exit(1); }
console.log('PASS 選擇教練卡片：1對N 顯示 單價×N 的最終金額，1對1 不變');
