'use strict';
// 預約政策 — 取消期限與逾時復原（純函式，零外部相依、不讀時鐘）
const assert = require('assert');
const {
  CANCEL_DEADLINE_HOURS, NO_SHOW_GRACE_MINUTES,
  canSelfCancel, isNoShowRestorable, cancelRejectMessage,
} = require('../server/services/bookingPolicy');

assert.strictEqual(CANCEL_DEADLINE_HOURS, 24, '預設 24 小時');

const NOW = new Date('2026-08-10T12:00:00+08:00');
const hoursLater = (h) => new Date(NOW.getTime() + h * 3600000);

// ── 取消期限：24 小時邊界 ──
assert.strictEqual(canSelfCancel(hoursLater(25), NOW).allowed, true, '25 小時前可取消');
assert.strictEqual(canSelfCancel(hoursLater(24), NOW).allowed, true, '正好 24 小時可取消');
{
  const r = canSelfCancel(hoursLater(23.9), NOW);
  assert.strictEqual(r.allowed, false, '23.9 小時不可取消');
  assert.strictEqual(r.reason, 'TOO_LATE');
}
{
  const r = canSelfCancel(hoursLater(-1), NOW);
  assert.strictEqual(r.allowed, false, '已開始不可取消');
  assert.strictEqual(r.reason, 'ALREADY_STARTED');
}
{
  const r = canSelfCancel('not-a-date', NOW);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'INVALID_SCHEDULE');
}
// 字串形式的時間也要能吃
assert.strictEqual(canSelfCancel(hoursLater(30).toISOString(), NOW).allowed, true);

// ── 逾時未簽到復原 ──
const base = { scheduledAt: new Date('2026-08-10T09:00:00+08:00'), durationMinutes: 60 };
// 課程 09:00-10:00，緩衝 120 分 → 12:00 之後才可復原
assert.strictEqual(
  isNoShowRestorable({ ...base, hasCheckin: false }, new Date('2026-08-10T11:59:00+08:00')), false,
  '緩衝未過不得復原');
assert.strictEqual(
  isNoShowRestorable({ ...base, hasCheckin: false }, new Date('2026-08-10T12:00:00+08:00')), true,
  '緩衝已過應可復原');
assert.strictEqual(
  isNoShowRestorable({ ...base, hasCheckin: true }, new Date('2026-08-11T00:00:00+08:00')), false,
  '有簽到就不是未出席，絕不可復原');
assert.strictEqual(
  isNoShowRestorable({ scheduledAt: 'bad', hasCheckin: false }, NOW), false,
  '無效時間不得復原');
// 未來的課不得復原
assert.strictEqual(
  isNoShowRestorable({ scheduledAt: hoursLater(5), durationMinutes: 60, hasCheckin: false }, NOW), false);
// duration 缺省視為 60 分
assert.strictEqual(
  isNoShowRestorable({ scheduledAt: base.scheduledAt, hasCheckin: false },
    new Date('2026-08-10T12:00:00+08:00')), true);

// ── 文案 ──
assert.ok(cancelRejectMessage('ALREADY_STARTED', -1).includes('已開始'));
{
  const m = cancelRejectMessage('TOO_LATE', 5);
  assert.ok(m.includes('24 小時'), '須告知期限');
  assert.ok(m.includes('自動回復'), '須告知不出席會自動復原，否則家長不知道怎麼辦');
}
assert.ok(cancelRejectMessage('WEIRD', 0).includes('洽櫃台'));

console.log('booking_policy_test: PASS');