/**
 * 教練端卡片的簽到標籤。
 *
 * 自助簽到建立的 session，scheduled_at 與 checked_in_at 完全相同
 * （正式庫近 60 天實測 315/315，平均差 0.0 分），兩個都印會讓同一個數字在同一張卡上
 * 出現兩次。預約制則平均差 192 分鐘，附上簽到時間才有資訊量。
 */
const assert = require('assert');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

(async () => {
  const { checkinLabel, formatTWTime } = await import('../client/liff/src/utils/format.js');

  const AT = '2026-08-07T03:51:58.000Z';   // 台北 11:51

  t('自助簽到：兩個時間相同 → 不附時間', () => {
    assert.strictEqual(checkinLabel(AT, AT), '已簽到');
  });

  t('相差 90 秒仍視為同一件事 → 不附時間', () => {
    const b = new Date(Date.parse(AT) + 90 * 1000).toISOString();
    assert.strictEqual(checkinLabel(AT, b), '已簽到');
  });

  t('預約制：相差 2 小時 → 附上簽到時間', () => {
    const b = new Date(Date.parse(AT) + 2 * 3600 * 1000).toISOString();
    assert.strictEqual(checkinLabel(AT, b), '已簽到 ' + formatTWTime(b));
  });

  t('早到簽到（負差距）也要附時間', () => {
    const b = new Date(Date.parse(AT) - 30 * 60 * 1000).toISOString();
    assert.strictEqual(checkinLabel(AT, b), '已簽到 ' + formatTWTime(b));
  });

  t('沒有簽到時間 → 只回「已簽到」，不回 undefined/NaN', () => {
    for (const bad of [null, undefined, '']) {
      assert.strictEqual(checkinLabel(AT, bad), '已簽到', 'checkedInAt=' + String(bad));
    }
  });

  t('壞掉的時間字串 → 退回「已簽到」，不產生 Invalid Date', () => {
    assert.strictEqual(checkinLabel('abc', AT), '已簽到');
    assert.strictEqual(checkinLabel(AT, 'abc'), '已簽到');
  });

  // 突變防護：若有人把判斷拿掉、改成永遠附時間，第一個案例會變成「已簽到 11:51」而爆。
  t('突變防護：相同時間與相差 2 小時必須產生不同結果', () => {
    const far = new Date(Date.parse(AT) + 2 * 3600 * 1000).toISOString();
    assert.notStrictEqual(checkinLabel(AT, AT), checkinLabel(AT, far),
      '兩者結果相同，這個測試就失去鑑別力');
  });

  console.log('\n' + n + ' 個測試全數通過');
})().catch((e) => { console.error('\nFAIL: ' + e.message); process.exit(1); });