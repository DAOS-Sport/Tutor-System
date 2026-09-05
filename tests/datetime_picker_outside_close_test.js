/**
 * 日期選擇器：什麼時候該關閉、以及面板裡不可以有原生 <select>。
 *
 * 家長回報：註冊／新增學員填生日，填完月份畫面就跳掉。桌機 Chrome 與 375px
 * 手機模擬都重現不出來 —— 差別在原生 <select>（面板裡選年份那個）：
 * 桌機開行內下拉，LINE 內建瀏覽器（Android WebView / iOS WKWebView）開的是
 * **系統對話框**，而對話框關閉時 WebView 會補送一顆 mousedown，
 * target 是 document/body 或已被移除的節點。
 * 舊寫法只問 contains()，這種事件一律被判成「點到外面」→ 面板關掉。
 *
 * 兩層防護，這裡都釘住：
 *   1. 事件層：改用 pointerdown，且忽略沒有真正目標的事件
 *   2. 源頭：年份不再用原生 <select>，沒有對話框可言
 *
 * ⚠️ 誠實記一筆：LINE 內建瀏覽器沒辦法在這裡跑，所以「這就是家長遇到的那個
 * bug」仍是假設。這裡證實的是「這條路徑本來會誤關，現在不會」。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

const PICKER = path.resolve(__dirname, '../client/shared/DateTimePicker.jsx');

/** 去掉 JSX 註解與 JS 註解。說明文字裡就寫著 <select>，不濾掉的話斷言永遠通過。 */
function stripComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

// 夠用的假 DOM：只要有 contains / isConnected / ownerDocument 就測得動
function makeDom() {
  const doc = { body: null, documentElement: null };
  const mk = (name, connected = true) => ({
    name, isConnected: connected, ownerDocument: doc,
    children: [],
    contains(x) {
      if (x === this) return true;
      return this.children.some((c) => c === x || (c.contains && c.contains(x)));
    },
  });
  doc.body = mk('body');
  doc.documentElement = mk('html');
  const box = mk('box');
  const 面板內的元素 = mk('inner');
  const 面板外的按鈕 = mk('other');
  box.children.push(面板內的元素);
  return { doc, box, 面板內的元素, 面板外的按鈕, mk };
}

(async () => {
  const url = 'file://' + path.resolve(__dirname, '../client/shared/outsideClose.js').replace(/\\/g, '/');
  const { shouldCloseOnOutsidePointer } = await import(url);

  t('點面板裡面：不關', () => {
    const d = makeDom();
    assert.strictEqual(shouldCloseOnOutsidePointer(d.box, d.面板內的元素), false);
    assert.strictEqual(shouldCloseOnOutsidePointer(d.box, d.box), false);
  });

  t('點頁面上其他真的元素：要關', () => {
    const d = makeDom();
    assert.strictEqual(shouldCloseOnOutsidePointer(d.box, d.面板外的按鈕), true);
  });

  t('target 是 document / body / html：不關（系統對話框關閉後補送的事件）', () => {
    const d = makeDom();
    for (const target of [d.doc, d.doc.body, d.doc.documentElement]) {
      assert.strictEqual(shouldCloseOnOutsidePointer(d.box, target), false,
        '這不是「使用者點到面板外面」，是事件沒有真正的目標。'
        + '把它當成外部點擊，使用者填到一半面板就會自己消失');
    }
  });

  t('target 已從 DOM 移除：不關', () => {
    const d = makeDom();
    assert.strictEqual(shouldCloseOnOutsidePointer(d.box, d.mk('stale', false)), false,
      'React 剛卸載掉的節點，或 WebView 補送的事件 —— 都不是使用者的操作');
  });

  t('沒有 box 或沒有 target：不關（寧可留著也不要自己消失）', () => {
    const d = makeDom();
    assert.strictEqual(shouldCloseOnOutsidePointer(null, d.面板外的按鈕), false);
    assert.strictEqual(shouldCloseOnOutsidePointer(d.box, null), false);
    assert.strictEqual(shouldCloseOnOutsidePointer(d.box, undefined), false);
  });

  t('關閉面板是掛在 pointerdown，不是 mousedown', () => {
    const src = stripComments(fs.readFileSync(PICKER, 'utf8'));
    // 只看「負責關閉面板」的那個 effect。檔案別處可以有 mousedown ——
    // 診斷浮層就被動監聽它，為的正是驗證 WebView 到底有沒有補送那顆事件；
    // 那是觀察，不是行為。這條斷言要管的是行為。
    const i = src.indexOf('shouldCloseOnOutsidePointer(boxRef.current');
    assert.ok(i > 0, '找不到外部點擊關閉的處理');
    const 區塊 = src.slice(Math.max(0, i - 400), i + 900);
    assert.ok(/addEventListener\('pointerdown', onDown\)/.test(區塊),
      '關閉面板要掛 pointerdown');
    assert.ok(!/addEventListener\('mousedown', onDown/.test(區塊),
      '用 mousedown 關面板會收到 WebView 在系統對話框關閉後補送的事件 —— '
      + '那正是家長遇到的「填完月份就跳掉」');
  });

  t('年月面板裡沒有原生 <select>（那是系統對話框的來源）', () => {
    const src = stripComments(fs.readFileSync(PICKER, 'utf8'));
    const i = src.indexOf('pickingMonth ? (');
    assert.ok(i > 0, '找不到年月選擇區塊');
    const j = src.indexOf(') : (', i);
    assert.ok(j > i, '找不到年月區塊的結尾');
    const 年月區塊 = src.slice(i, j);
    assert.ok(!/<select/.test(年月區塊),
      '年份用原生 <select> 的話，LINE 內建瀏覽器會開系統對話框；'
      + '對話框關閉時 WebView 補送的事件會把面板關掉 —— 那就是家長遇到的'
      + '「生日填完月份就跳掉」。改成面板內的按鈕，才沒有對話框可言');
    assert.ok(/data-year=/.test(年月區塊), '年份應該是一排可點的按鈕');
  });

  t('選年/選月會記下時間戳（iOS 模擬點擊防護的觸發點）', () => {
    const src = stripComments(fs.readFileSync(PICKER, 'utf8'));
    const y = src.match(/選了年[^\n]*lastGridPickAt\.current = Date\.now\(\)/);
    const m = src.match(/選了月[^\n]*lastGridPickAt\.current = Date\.now\(\)/);
    assert.ok(y || /lastGridPickAt\.current = Date\.now\(\)[^\n]*選了年/.test(src),
      '選年時沒有記下 lastGridPickAt —— iOS 模擬點擊防護就沒有起算點');
    assert.ok(m || /lastGridPickAt\.current = Date\.now\(\)[^\n]*選了月/.test(src),
      '選月時沒有記下 lastGridPickAt —— 而「選完月就跳掉」正是要擋的那一下');
  });

  t('觸發鈕在剛選過年/月的極短窗內不可被關閉（iOS 模擬點擊落在觸發鈕上）', () => {
    const src = stripComments(fs.readFileSync(PICKER, 'utf8'));
    // 生日是 date 模式，沒有「完成」鈕；date 模式下唯一「不留 note」的關閉路徑
    // 就是觸發鈕的 toggle。診斷連續 16 筆全在「選了月」後戛然而止、無任何後續 note，
    // 由排除法就是這顆 toggle 被 iOS 補送的模擬點擊打到。這條守它不被拿掉。
    const i = src.indexOf('setOpen((v) => !v)');
    assert.ok(i > 0, '找不到觸發鈕的 toggle');
    const 區塊 = src.slice(Math.max(0, i - 300), i + 30);
    assert.ok(/withinGridEcho\(\)/.test(區塊),
      '觸發鈕的 toggle 沒有 withinGridEcho 防護 —— 家長「填完月份就跳掉」會回歸');
    assert.ok(/return;/.test(區塊),
      '防護命中時要 return（吞掉那顆模擬點擊），不能還是往下 setOpen');
  });

  t('外部點擊關閉也套同一道防護（保險）', () => {
    const src = stripComments(fs.readFileSync(PICKER, 'utf8'));
    const i = src.indexOf('const onDown = (e) =>');
    assert.ok(i > 0, '找不到外點關閉處理');
    const 區塊 = src.slice(i, i + 400);
    assert.ok(/withinGridEcho\(\)/.test(區塊),
      '外點關閉沒有 withinGridEcho 防護');
  });

  console.log('\n' + n + ' 個測試全數通過');
})();

