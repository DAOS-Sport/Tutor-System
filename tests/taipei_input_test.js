/**
 * datetime-local → 台北時刻的解析。
 *
 * 這條路徑決定「櫃台補簽到」實際寫進 checked_in_at 的時間。原本是 new Date(raw)，
 * 依瀏覽器本機時區解讀 —— 櫃台電腦時區設錯，簽到時間就整段偏移且無人察覺。
 */
const assert = require('assert');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

(async () => {
  const { taipeiInputToDate } = await import('../client/admin/src/utils/format.js');

  t('台北 14:30 = UTC 06:30（不隨執行環境時區飄移）', () => {
    const d = taipeiInputToDate('2026-08-04T14:30');
    assert.strictEqual(d.toISOString(), '2026-08-04T06:30:00.000Z');
  });

  t('跨日邊界：台北 00:15 是前一天的 UTC', () => {
    const d = taipeiInputToDate('2026-08-04T00:15');
    assert.strictEqual(d.toISOString(), '2026-08-03T16:15:00.000Z');
  });

  t('帶秒也接受', () => {
    assert.strictEqual(taipeiInputToDate('2026-08-04T14:30:45').toISOString(), '2026-08-04T06:30:45.000Z');
  });

  t('壞值一律 null，不回 Invalid Date', () => {
    for (const bad of ['', null, undefined, '2026-08-04', 'abc', '2026-13-99T99:99', '2026/08/04T14:30']) {
      assert.strictEqual(taipeiInputToDate(bad), null, 'bad=' + String(bad));
    }
  });

  // 突變防護：若有人把 +08:00 拿掉退回 new Date(raw)，這裡在非 UTC+8 的機器上會爆。
  // 在 UTC 機器上跑時，少了 +08:00 會得到 14:30Z 而不是 06:30Z，第一個測試就抓得到。
  t('突變防護：時區位移確實有套用', () => {
    const d = taipeiInputToDate('2026-08-04T14:30');
    assert.notStrictEqual(d.toISOString(), '2026-08-04T14:30:00.000Z',
      '解析結果等於字面值，代表 +08:00 沒有生效');
  });

  console.log('\n' + n + ' 個測試全數通過');
})();