/**
 * 「請補上 Email」橫幅的顯示條件。
 *
 * 2026-08-29 盤點：555 位在職家長裡 59 位缺 Email，牽連 75 位學員。Ragic Z01
 * 的「(報)Email」是必填欄，缺了就寫不回 Ragic、加不了學員、每次開 App 都同步
 * 失敗 —— 而畫面上完全看不出原因。橫幅是要把這件事講出來。
 *
 * 這裡盯的是誤報方向：這個判斷會跑在每一位家長的首頁上，多亮一位，就是五百多個
 * 資料完整的家庭每天看到一則假警報。所以「證據不足」必須解讀成不提醒，
 * 而不是先跳出來再說。
 */
const assert = require('assert');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

(async () => {
  const { needsEmailPrompt } = await import('../client/liff/src/utils/needsEmail.js');

  t('缺 Email 才提醒', () => {
    assert.strictEqual(needsEmailPrompt({ email: null }), true);
    assert.strictEqual(needsEmailPrompt({ email: '' }), true);
    assert.strictEqual(needsEmailPrompt({ email: '   ' }), true, '只有空白等於沒填');
  });

  t('有 Email 就不提醒', () => {
    assert.strictEqual(needsEmailPrompt({ email: 'a@b.com' }), false);
    assert.strictEqual(needsEmailPrompt({ email: ' a@b.com ' }), false);
  });

  t('沒登入不提醒', () => {
    for (const v of [null, undefined, '', 0, 'parent']) {
      assert.strictEqual(needsEmailPrompt(v), false, 'v=' + String(v));
    }
  });

  t('形狀不認得就不提醒（沒有 email 這個 key）', () => {
    assert.strictEqual(needsEmailPrompt({ id: 1, name: '王小明' }), false,
      '後端 _issue() 一律帶 email（缺就是 null）；連 key 都沒有代表這不是家長物件，'
      + '可能是舊版寫進 localStorage 的快取 —— 這種時候提醒等於對所有人誤報');
  });

  t('登入回應的真實形狀：有 email 的不亮、缺的亮', () => {
    // 對齊 server/routes/auth.js 的 _issue()：email: parent.email || null
    const 有填 = { id: 7, name: '陳媽媽', phone: '0912345678', email: 'mom@example.com', students: [] };
    const 沒填 = { id: 8, name: '李爸爸', phone: '0922333444', email: null, students: [] };
    assert.strictEqual(needsEmailPrompt(有填), false);
    assert.strictEqual(needsEmailPrompt(沒填), true);
  });

  console.log('\n' + n + ' 個測試全數通過');
})();

