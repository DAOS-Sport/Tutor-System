'use strict';
// 「這個場館這個時間真的有開嗎」的純判定測試。
const assert = require('assert');
const {
  evaluateOpening, openingRejectMessage, toMinutes,
} = require('../server/services/venueOpening');

const MON = 1;
const HOURS = [{ weekday: MON, open_time: '18:00:00', close_time: '21:00:00' }];
const at = (hh, mm = 0) => hh * 60 + mm;
const base = { weekday: MON, durationMinutes: 60, isClosedDate: false, hours: HOURS };

// ── 正常落在營業時間內 ──
assert.strictEqual(evaluateOpening({ ...base, startMinutes: at(18) }).open, true);
assert.strictEqual(evaluateOpening({ ...base, startMinutes: at(20) }).open, true, '20:00-21:00 剛好貼齊打烊');

// ── 必須「完整放得下」，不是只有開始時間在營業時間內 ──
{
  const r = evaluateOpening({ ...base, startMinutes: at(20, 30) });
  assert.strictEqual(r.open, false, '20:30 開始的 60 分課會上到 21:30，超過打烊');
  assert.strictEqual(r.reason, 'VENUE_HOURS_MISMATCH');
}

// ── 開店前 ──
assert.strictEqual(evaluateOpening({ ...base, startMinutes: at(17) }).open, false);

// ── 星期不符（同樣的時間但不是營業日）──
assert.strictEqual(evaluateOpening({ ...base, weekday: 2, startMinutes: at(19) }).open, false);

// ── 特殊休館日：即使落在營業時間內也不准 ──
{
  const r = evaluateOpening({ ...base, startMinutes: at(19), isClosedDate: true });
  assert.strictEqual(r.open, false);
  assert.strictEqual(r.reason, 'VENUE_CLOSED_DATE');
}

// ── fail-closed：沒有營業時間資料一律不准，不得放行 ──
for (const hours of [[], null, undefined]) {
  const r = evaluateOpening({ ...base, startMinutes: at(19), hours });
  assert.strictEqual(r.open, false, '查不到營業時間必須擋下');
  assert.strictEqual(r.reason, 'VENUE_NO_BUSINESS_HOURS');
}

// ── 分段營業：兩段都算，中間空檔不算 ──
{
  const split = [
    { weekday: MON, open_time: '09:00', close_time: '12:00' },
    { weekday: MON, open_time: '14:00', close_time: '18:00' },
  ];
  assert.strictEqual(evaluateOpening({ ...base, startMinutes: at(10), hours: split }).open, true);
  assert.strictEqual(evaluateOpening({ ...base, startMinutes: at(15), hours: split }).open, true);
  assert.strictEqual(evaluateOpening({ ...base, startMinutes: at(12, 30), hours: split }).open, false,
    '中午休息時段不得放行');
  assert.strictEqual(evaluateOpening({ ...base, startMinutes: at(11, 30), hours: split }).open, false,
    '11:30 開始的 60 分課跨越 12:00 休息，不得放行');
}

// ── 髒資料不得被當成營業時間 ──
{
  const dirty = [
    { weekday: MON, open_time: null, close_time: '21:00' },
    { weekday: MON, open_time: '20:00', close_time: '08:00' }, // 打烊早於開店
    { weekday: MON, open_time: 'x', close_time: 'y' },
  ];
  assert.strictEqual(evaluateOpening({ ...base, startMinutes: at(19), hours: dirty }).open, false);
}

// ── 跨午夜一律擋（本 schema 的營業時間不跨日，無從比對）──
{
  const late = [{ weekday: MON, open_time: '22:00', close_time: '23:59' }];
  const r = evaluateOpening({ ...base, startMinutes: at(23, 30), durationMinutes: 60, hours: late });
  assert.strictEqual(r.open, false);
  assert.strictEqual(r.reason, 'VENUE_HOURS_MISMATCH');
}

// ── weekday 型別寬容（DB 可能回字串）──
assert.strictEqual(
  evaluateOpening({ ...base, weekday: '1', startMinutes: at(19),
    hours: [{ weekday: '1', open_time: '18:00', close_time: '21:00' }] }).open, true);

// ── toMinutes ──
assert.strictEqual(toMinutes('18:00:00'), 1080);
assert.strictEqual(toMinutes('09:05'), 545);
assert.strictEqual(toMinutes(''), null);
assert.strictEqual(toMinutes(null), null);

// ── 每個 reason 都要有給家長看的話，不能漏掉變成空字串 ──
for (const reason of ['VENUE_CLOSED_DATE', 'VENUE_NO_BUSINESS_HOURS', 'VENUE_HOURS_MISMATCH']) {
  assert.ok(openingRejectMessage(reason).length > 5, reason + ' 缺少文案');
}
assert.ok(openingRejectMessage('SOMETHING_NEW').length > 5, '未知 reason 也要有保底文案');

console.log('venue_opening_test: PASS');