/**
 * 課程期限的日期運算。
 *
 * 2026-09-01 需求：期限＝對帳完成時間的「一年後」，取那一天的 23:59（台北）。
 *
 * 為什麼要真行為測試而不是掃原始碼：這段錯了不會有任何人立刻發現。
 * 少一天、時區偏一天、閏年滾錯，症狀都是「家長到隔年才說我的課怎麼過期了」，
 * 那時候已經無從查起。
 */
const assert = require('assert');
const path = require('path');

const { __test__ } = require(path.resolve(__dirname, '../server/routes/sessions'));
const { courseExpiryAt, daysLeftUntil, EXPIRING_SOON_DAYS } = __test__;

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

/** 把 instant 轉成台北牆鐘字串，方便斷言。 */
function taipei(d) {
  const x = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (v) => String(v).padStart(2, '0');
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} `
    + `${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`;
}

t('一般情況：一年後的同月同日 23:59', () => {
  // 2026-08-07 21:38 台北 對帳
  assert.strictEqual(taipei(courseExpiryAt('2026-08-07T13:38:46.882Z')), '2027-08-07 23:59');
});

t('對帳時間是幾點都不影響期限那一天', () => {
  const early = courseExpiryAt('2026-08-07T00:30:00Z');  // 台北 08:30
  const late = courseExpiryAt('2026-08-07T15:00:00Z');   // 台北 23:00
  assert.strictEqual(taipei(early), '2027-08-07 23:59');
  assert.strictEqual(taipei(late), '2027-08-07 23:59');
});

t('台北時區真的有生效：UTC 當天但台北已跨日', () => {
  // 2026-08-07 16:30Z ＝ 台北 08/08 00:30，期限應該算 08/08 那一天
  assert.strictEqual(taipei(courseExpiryAt('2026-08-07T16:30:00Z')), '2027-08-08 23:59');
});

t('跨年：12/31 對帳，期限是隔年的 12/31', () => {
  assert.strictEqual(taipei(courseExpiryAt('2026-12-31T04:00:00Z')), '2027-12-31 23:59');
});

t('閏日：2/29 對帳，隔年沒有 2/29 → 滾到 3/1（寧可多一天，不可少一天）', () => {
  // 2024-02-29 10:00 台北
  assert.strictEqual(taipei(courseExpiryAt('2024-02-29T02:00:00Z')), '2025-03-01 23:59');
});

t('目標年是閏年時，2/28 仍然是 2/28', () => {
  assert.strictEqual(taipei(courseExpiryAt('2023-02-28T02:00:00Z')), '2024-02-28 23:59');
});

t('沒有對帳時間就沒有期限（不硬塞一個日期）', () => {
  for (const v of [null, undefined, '', 0]) {
    assert.strictEqual(courseExpiryAt(v), null, String(v));
  }
});

t('壞掉的時間字串回 null，不回 Invalid Date', () => {
  assert.strictEqual(courseExpiryAt('不是日期'), null);
  assert.strictEqual(courseExpiryAt('2026-13-99'), null);
});

t('剩餘天數：不足一天算一天，已過期為負', () => {
  const now = new Date('2026-09-01T00:00:00Z');
  assert.strictEqual(daysLeftUntil(new Date('2026-09-01T00:00:00Z'), now), 0, '同一刻＝0');
  assert.strictEqual(daysLeftUntil(new Date('2026-09-01T00:00:01Z'), now), 1, '還差一秒也算一天');
  assert.strictEqual(daysLeftUntil(new Date('2026-09-11T00:00:00Z'), now), 10);
  assert.ok(daysLeftUntil(new Date('2026-08-30T00:00:00Z'), now) < 0, '過期要是負的');
  assert.strictEqual(daysLeftUntil(null, now), null);
});

t('「3 個月內」用 92 天', () => {
  assert.strictEqual(EXPIRING_SOON_DAYS, 92,
    '跨月天數不固定，用月份算會讓同樣一句話在不同季節得到不同結果');
});

t('端到端：對帳當天算出來的剩餘天數約等於一年', () => {
  const issued = '2026-08-07T13:38:00Z';
  const left = daysLeftUntil(courseExpiryAt(issued), new Date(issued));
  assert.ok(left >= 365 && left <= 366, '剩餘天數應該落在 365～366，實際 ' + left);
});

console.log('\n' + n + ' 個測試全數通過');

