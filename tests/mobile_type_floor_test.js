/**
 * 手機字級底線：抬得起來，而且絕對不能漏到桌機。
 *
 * 為什麼需要底線：實測 /enrollments 在 375px，可見文字有 80%（1209/1514）是 12px。
 * 全站 text-xs 用了 494 次、text-[11px] 112 次、text-[10px] 55 次，
 * 而 text-base 只用了 11 次 —— 這是「每一頁都覺得字很小」的來源。
 *
 * 為什麼是媒體查詢而不是逐處改：那些尺寸被烘在幾百個欄位 render 函式裡。
 * 卡片標題明明設了 text-sm，實際顯示 12px，因為 render 自帶的 text-xs 蓋過去了。
 * 逐處覆蓋要動的點太多，而且下次有人新增欄位又會回到 12px。
 *
 * ── 這支測試真正在守的東西 ──
 * 使用者明確要求「桌機千萬不要改」。而全域覆寫 Tailwind 工具類是很容易
 * 漏到桌機的做法 —— 只要把 max-width 寫成 768px（而不是 767px），
 * 就會與 md: 重疊一個像素，桌機的 text-xs 跟著變大，而那種一像素的重疊
 * 在畫面上看不出來、只有量了才知道。
 *
 * 實測基準（改動當下）：
 *   375px  ≤12px 佔比 80% → 30%，卡片 89px → 95px，一屏仍 6 張，零橫向溢出
 *   1280px text-xs=12 / text-[11px]=11 / text-[10px]=10 / text-[13px]=13，全部＝原值
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'client/admin/src/index.css'), 'utf8');

// Tailwind 的 md: 斷點。底線的上限必須小於它，否則兩者重疊。
const MD_BREAKPOINT = 768;

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

const blocks = [...CSS.matchAll(/@media[^{]*\{([\s\S]*?)\n\}/g)];

check('字級底線存在', () => {
  assert.ok(/\.text-xs\s*\{[^}]*font-size/.test(CSS),
    '找不到 text-xs 的底線覆寫 —— 手機上八成的文字會退回 12px');
});

check('底線只在手機生效，與 md: 不重疊', () => {
  const m = CSS.match(/@media\s*\(\s*max-width:\s*(\d+)px\s*\)/);
  assert.ok(m, '底線沒有包在 max-width 的媒體查詢裡 —— 那會直接套到桌機');
  const bound = Number(m[1]);
  assert.ok(bound < MD_BREAKPOINT,
    `上限是 ${bound}px，而 Tailwind 的 md: 從 ${MD_BREAKPOINT}px 起 —— `
    + `${bound >= MD_BREAKPOINT ? '兩者重疊，桌機會被改到' : ''}`);
  assert.strictEqual(bound, MD_BREAKPOINT - 1,
    `上限應該正好是 ${MD_BREAKPOINT - 1}px（緊貼 md: 之下，中間不留空隙也不重疊），實際是 ${bound}px`);
});

check('底線裡沒有 min-width（那會讓規則反過來只套桌機）', () => {
  const floorBlock = blocks.find((b) => /\.text-xs\s*\{[^}]*font-size/.test(b[1]));
  assert.ok(floorBlock, '找不到含 text-xs 的媒體查詢區塊');
  const head = CSS.slice(CSS.lastIndexOf('@media', CSS.indexOf(floorBlock[1])), CSS.indexOf(floorBlock[1]));
  assert.ok(!/min-width/.test(head),
    '底線的媒體查詢含 min-width：' + head.trim());
});

check('每一條都是往上抬，沒有把字改小', () => {
  const floorBlock = blocks.find((b) => /\.text-xs\s*\{[^}]*font-size/.test(b[1]));
  const body = floorBlock[1];
  // 原始值：text-xs 是 Tailwind 的 12px，其餘從 class 名字讀
  const bad = [];
  for (const m of body.matchAll(/\.text-\\\[(\d+)px\\\]\s*\{[^}]*font-size:\s*(\d+)px/g)) {
    const from = Number(m[1]); const to = Number(m[2]);
    if (to <= from) bad.push(`text-[${from}px] → ${to}px`);
  }
  const xs = body.match(/\.text-xs\s*\{[^}]*font-size:\s*(\d+)px/);
  if (xs && Number(xs[1]) <= 12) bad.push(`text-xs → ${xs[1]}px（原本 12px）`);
  assert.deepStrictEqual(bad, [], '這些沒有把字抬大：' + bad.join('、'));
});

check('抬幅是保守的（一級），不是全部拉到 16px', () => {
  // 抬太多會讓卡片變高、一屏看到的筆數變少，而櫃檯對帳是掃描型任務。
  // 實測抬一級：卡片 89px → 95px，一屏仍是 6 張。
  const floorBlock = blocks.find((b) => /\.text-xs\s*\{[^}]*font-size/.test(b[1]));
  const body = floorBlock[1];
  const bad = [];
  for (const m of body.matchAll(/\.text-\\\[(\d+)px\\\]\s*\{[^}]*font-size:\s*(\d+)px/g)) {
    const from = Number(m[1]); const to = Number(m[2]);
    if (to - from > 2) bad.push(`text-[${from}px] → ${to}px（抬了 ${to - from}px）`);
  }
  const xs = body.match(/\.text-xs\s*\{[^}]*font-size:\s*(\d+)px/);
  if (xs && Number(xs[1]) - 12 > 2) bad.push(`text-xs → ${xs[1]}px（抬了 ${Number(xs[1]) - 12}px）`);
  assert.deepStrictEqual(bad, [],
    '抬幅超過 2px，卡片會變高、一屏看到的筆數變少：' + bad.join('、'));
});

console.log(failures ? '\n' + failures + ' FAILED' : '\nmobile_type_floor: ALL PASS');
process.exitCode = failures ? 1 : 0;
