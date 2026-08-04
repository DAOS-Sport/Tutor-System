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
// 「時間過後會自動回復」的兌現者是那支每 30 分鐘的 cron，而它第一行就是
// `if (!isSlotSupplyEnabled()) return;`。旗標沒開就不能講這句話——家長被擋住
// 不能取消、又等不到任何回復，那堂課就這樣沒了。文案必須跟著旗標實況走。
{
  const on = cancelRejectMessage('TOO_LATE', 5, { autoRestoreEnabled: true });
  assert.ok(on.includes('24 小時'), '須告知期限');
  assert.ok(on.includes('自動回復'), '自動復原有開時，須告知不出席會自動復原');

  const off = cancelRejectMessage('TOO_LATE', 5, { autoRestoreEnabled: false });
  assert.ok(off.includes('24 小時'), '須告知期限');
  assert.ok(!off.includes('自動回復'), '自動復原沒開時，不得承諾會自動回復');
  assert.ok(off.includes('櫃檯'), '不能自動回復時，須給家長一個真的能處理的窗口');

  // 預設值必須是 fail-closed：漏傳參數不得默默承諾一個不會發生的行為。
  const dflt = cancelRejectMessage('TOO_LATE', 5);
  assert.ok(!dflt.includes('自動回復'), '預設不得承諾自動回復');
}
assert.ok(cancelRejectMessage('WEIRD', 0).includes('洽櫃台'));

console.log('booking_policy_test: PASS');