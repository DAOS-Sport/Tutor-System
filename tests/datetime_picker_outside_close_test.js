/**
 * 日期選擇器「什麼時候該關閉」的判斷。
 *
 * 家長回報：註冊填生日、填完月份，畫面就跳掉。桌機 Chrome 與 375px 手機模擬
 * 都重現不出來 —— 差別在原生 <select>（面板裡選年份那個）：桌機開行內下拉，
 * LINE 內建瀏覽器開的是系統對話框，而對話框關閉時 WebView 會補送一顆
 * mousedown，target 是 document/body 或已被移除的節點。
 * 舊寫法只問 contains()，這種事件一律被判成「點到外面」→ 面板關掉。
 *
 * 這支測試釘住的是：那類事件不可以關閉面板，而真正的外部點擊仍然要關。
 *
 * ⚠️ 誠實記一筆：LINE 內建瀏覽器我沒有辦法在這裡跑，所以「這就是家長遇到的
 * 那個 bug」仍然是假設，不是已證實。這裡證實的是「這條路徑本來會誤關，現在不會」。
 */
const assert = require('assert');
const path = require('path');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

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
  const 面板內的年份select = mk('select');
  const 面板外的按鈕 = mk('other');
  box.children.push(面板內的年份select);
  return { doc, box, 面板內的年份select, 面板外的按鈕, mk };
}

(async () => {
  const url = 'file://' + path.resolve(__dirname, '../client/shared/outsideClose.js').replace(/\\/g, '/');
  const { shouldCloseOnOutsidePointer } = await import(url);

  t('點面板裡面：不關', () => {
    const d = makeDom();
    assert.strictEqual(shouldCloseOnOutsidePointer(d.box, d.面板內的年份select), false);
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
    const 剛被卸載的節點 = d.mk('stale', false);
    assert.strictEqual(shouldCloseOnOutsidePointer(d.box, 剛被卸載的節點), false,
      'React 剛卸載掉的節點，或 WebView 補送的事件 —— 都不是使用者的操作');
  });

  t('沒有 box 或沒有 target：不關（寧可留著也不要自己消失）', () => {
    const d = makeDom();
    assert.strictEqual(shouldCloseOnOutsidePointer(null, d.面板外的按鈕), false);
    assert.strictEqual(shouldCloseOnOutsidePointer(d.box, null), false);
    assert.strictEqual(shouldCloseOnOutsidePointer(d.box, undefined), false);
  });

  t('選擇器用 pointerdown 而不是 mousedown', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.resolve(__dirname, '../client/shared/DateTimePicker.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(/addEventListener\('pointerdown'/.test(src), '要掛 pointerdown');
    assert.ok(!/addEventListener\('mousedown'/.test(src),
      'mousedown 會收到 WebView 在系統對話框關閉後補送的事件');
  });

  console.log('\n' + n + ' 個測試全數通過');
})();

