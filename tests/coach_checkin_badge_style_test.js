'use strict';
/**
 * 教練端的「已簽到」章，色票必須與家長端的「已出席」章同一組。
 *
 * 為什麼值得一支測試：這兩顆章會被同一個人在同一天看到 —— 家長在上課記錄裡
 * 看到 brand-green 的「已出席」，教練在首頁看到 emerald 的「已簽到」，
 * 是兩種不同的綠。emerald 在整個 liff 前端只有教練端這兩顆章在用（其餘
 * 「完成／通過」語意一律走 bg-brand-green/15 + text-brand-green），
 * 所以它是孤例，不是另一套刻意的設計。
 *
 * 掃描方式刻意採「白名單＋語意重算」而不是「黑名單找 emerald」：
 * 黑名單只擋得住這一次的錯字，下次有人換成 lime-100 一樣溜過去。
 * 這裡改成正面斷言「這一行必須長成什麼樣」。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIFF_SRC = path.join(ROOT, 'client/liff/src');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const read = (rel) => fs.readFileSync(path.join(LIFF_SRC, rel), 'utf8');

/**
 * 註解裡本來就會提到 emerald（說明為什麼不再用它），掃描前先剝掉，
 * 否則這支測試會被自己的說明文字絆倒 —— 同樣的坑在
 * admin_role_gate_consistency_test 已經踩過一次。
 */
// 順序很重要：先剝「行註解」再剝「區塊註解」。
// 反過來的話，一句 // 註解裡只要出現區塊註解的開頭符號（例如寫路徑時的萬用字元），
// 區塊規則就會從那裡一路吃到下一個結束符號，把中間的程式碼全部當成註解刪掉 ——
// 而「不得包含 X」那類斷言就會因為 X 被吃掉而假性通過。
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

// 家長端那顆章的權威定義。教練端要對齊的就是這一組值。
const PARENT_ATTENDED_CLS = 'bg-brand-green/15 text-brand-green';

// 教練端「用三元式直接寫色票」的頁面。授課記錄已改走共用元件 CoachRecordCard，
// 它的色票由下面那條單獨守 —— 分開守是因為兩者的失效方式不同：
// 這裡是「有人在頁面裡硬寫了別的綠」，那裡是「共用元件的色票被改掉」。
const COACH_BADGE_PAGES = ['pages/CoachTodayPage.jsx'];

check('家長端「已出席」章仍是 bg-brand-green/15 + text-brand-green（基準沒被搬走）', () => {
  const src = read('pages/MyLessonsPage.jsx');
  assert.ok(src.includes('已出席'), 'MyLessonsPage 找不到「已出席」—— 基準頁改版了，本測試要重寫');
  assert.ok(src.includes("attended: '" + PARENT_ATTENDED_CLS + "'"),
    'StatusSquare 的 attended 色票變了。教練端是照著它抄的，'
    + '基準一改就要同步，否則兩端又會分岔');
});

for (const rel of COACH_BADGE_PAGES) {
  check(`${rel} 的簽到章用家長端同一組色票`, () => {
    const src = stripComments(read(rel));
    // 只認那一行：className 裡同時出現 checked_in 三元式與色票，
    // 避免掃到頁面上其他不相干的 brand-green。
    const m = src.match(/s\.checked_in \? '([^']+)' : '([^']+)'/);
    assert.ok(m, `${rel} 找不到簽到章的三元式 —— 掃描失效，這支測試等於沒在測`);
    assert.strictEqual(m[1], PARENT_ATTENDED_CLS,
      `已簽到的色票是 "${m[1]}"，家長端是 "${PARENT_ATTENDED_CLS}"。`
      + '兩端不一致的話，同一個人會在同一天看到兩種綠');
    assert.ok(/^bg-gray-\d+ text-gray-\d+$/.test(m[2]),
      `未簽到應維持中性灰，目前是 "${m[2]}"`);
  });
}

check('共用卡片 CoachRecordCard 的「已簽到」方塊用家長端同一組色票', () => {
  // 授課記錄的簽到章 2026-08-17 改成共用元件的 StatusSquare tone="green"。
  // 守的是同一件事：教練看到的綠必須就是家長端「已出席」那個綠。
  const src = stripComments(read('components/coach/CoachRecordCard.jsx'));
  const m = src.match(/green:\s*'([^']+)'/);
  assert.ok(m, 'CoachRecordCard 找不到 green 色票 —— 掃描失效');
  assert.ok(m[1].includes('bg-brand-green/15') && m[1].includes('text-brand-green'),
    `green 色票是 "${m[1]}"，家長端是 "${PARENT_ATTENDED_CLS}"。`
    + '兩端不一致的話，同一個人會在同一天看到兩種綠');
});

check('授課記錄確實走共用元件，沒有再自己寫一份簽到章', () => {
  const src = stripComments(read('pages/CoachHistoryPage.jsx'));
  assert.ok(/<StatusBanner\s+tone="green"/.test(src),
    '授課記錄沒有使用共用的綠色狀態 banner');
  assert.ok(!/s\.checked_in \? '[^']*(emerald|lime|green-)/.test(src),
    '頁面裡又出現硬寫的色票 —— 應該一律走 CoachRecordCard');
  // 簽到記錄是「呈現」不是「操作」：列表上不該出現看起來能按的簽到入口。
  // 簽到會扣課並推播給教練，有自己的流程與稽核。
  assert.ok(!/點進去簽|立即簽到|點擊簽到/.test(src),
    '授課記錄又出現像按鈕的簽到入口');
});

check('教練端簽到章不再使用 emerald（黑名單只是補刀，不是主要依據）', () => {
  for (const rel of COACH_BADGE_PAGES) {
    const src = stripComments(read(rel));
    assert.ok(!/checked_in \? '[^']*emerald/.test(src),
      `${rel} 的簽到章仍在用 emerald`);
  }
});

check('掃描沒有失效：把色票改掉就要能被抓到', () => {
  const src = stripComments(read('pages/CoachTodayPage.jsx'));
  const m = src.match(/s\.checked_in \? '([^']+)' : '([^']+)'/);
  assert.ok(m, '正則抓不到目標行');
  const mutated = src.replace(m[0], "s.checked_in ? 'bg-lime-100 text-lime-700' : 'bg-gray-100 text-gray-500'");
  const m2 = mutated.match(/s\.checked_in \? '([^']+)' : '([^']+)'/);
  assert.notStrictEqual(m2[1], PARENT_ATTENDED_CLS,
    '改成 lime 之後正則抓到的還是原值 —— 表示比對的不是真的那一行');
});

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
