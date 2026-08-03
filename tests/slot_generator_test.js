'use strict';
// 時段產生器單元測試（零外部相依：不連 DB、不打網路、不讀時鐘）
const assert = require('assert');
const {
  computeSlots, buildBlockedKeys, timeToMinutes, minutesToTime, weekdayOf, addDays, carryKey,
} = require('../server/services/slotGenerator');

// ── 基礎工具 ──
assert.strictEqual(timeToMinutes('09:00'), 540);
assert.strictEqual(timeToMinutes('18:30:00'), 1110);
assert.strictEqual(timeToMinutes('bad'), null);
assert.strictEqual(timeToMinutes('25:00'), null, '小時超過 23 應為 null');
assert.strictEqual(minutesToTime(540), '09:00');
assert.strictEqual(addDays('2026-08-31', 1), '2026-09-01', '跨月');
assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01', '跨年');
// 2026-08-03 是星期一
assert.strictEqual(weekdayOf('2026-08-03'), 1);

const MON = 1;
const HOURS = [{ weekday: MON, open_time: '14:00', close_time: '17:00', slot_minutes: 60 }];

// ── 切格：14-17 點、60 分 → 3 格；最後一格不得超過打烊 ──
{
  const s = computeSlots({ businessHours: HOURS, fromDate: '2026-08-03', toDate: '2026-08-03' });
  assert.strictEqual(s.length, 3, `週一 14-17 應切 3 格，實際 ${s.length}`);
  assert.ok(s.every((x) => x.status === 'available'));
  assert.strictEqual(s[0].startAtISO, new Date('2026-08-03T14:00:00+08:00').toISOString());
}

// ── 放不下的尾巴不產生（14:00-15:30、60 分 → 只有 1 格）──
{
  const s = computeSlots({
    businessHours: [{ weekday: MON, open_time: '14:00', close_time: '15:30', slot_minutes: 60 }],
    fromDate: '2026-08-03', toDate: '2026-08-03',
  });
  assert.strictEqual(s.length, 1, '不得產生會超過打烊時間的格子');
}

// ── 只在對應星期幾產生 ──
{
  const s = computeSlots({ businessHours: HOURS, fromDate: '2026-08-04', toDate: '2026-08-09' });
  assert.strictEqual(s.length, 0, '週二~週日不該有週一的時段');
}

// ── 跨週：兩個週一 → 6 格 ──
{
  const s = computeSlots({ businessHours: HOURS, fromDate: '2026-08-03', toDate: '2026-08-16' });
  assert.strictEqual(s.length, 6, `兩週應有 2 個週一 × 3 格，實際 ${s.length}`);
}

// ── 智慧記憶：上一輪關掉週一 15:00 → 這一輪同格直接產生為 blocked ──
{
  const prevBlocked = [{ start_at: new Date('2026-07-27T15:00:00+08:00') }]; // 上一個週一
  const keys = buildBlockedKeys(prevBlocked);
  assert.ok(keys.has(carryKey(MON, '15:00')), 'carry-forward 應記住 週一15:00');

  const s = computeSlots({ businessHours: HOURS, fromDate: '2026-08-03', toDate: '2026-08-03', blockedKeys: keys });
  const byTime = Object.fromEntries(s.map((x) => [new Date(x.startAtISO).toISOString(), x.status]));
  const at15 = new Date('2026-08-03T15:00:00+08:00').toISOString();
  const at14 = new Date('2026-08-03T14:00:00+08:00').toISOString();
  assert.strictEqual(byTime[at15], 'blocked', '被記憶的時段應產生為 blocked');
  assert.strictEqual(byTime[at14], 'available', '未被記憶的時段應維持 available');
}

// ── 已存在的不重複產生（教練手建 / 前次已產生）──
{
  const existing = new Set([new Date('2026-08-03T14:00:00+08:00').toISOString()]);
  const s = computeSlots({ businessHours: HOURS, fromDate: '2026-08-03', toDate: '2026-08-03', existingKeys: existing });
  assert.strictEqual(s.length, 2, '已存在的那格不應再產生');
}

// ── 防呆 ──
assert.deepStrictEqual(computeSlots({ businessHours: [], fromDate: '2026-08-03', toDate: '2026-08-03' }), []);
assert.deepStrictEqual(computeSlots({ businessHours: HOURS, fromDate: '2026-08-10', toDate: '2026-08-03' }), [], 'to < from → 空');
assert.throws(() => computeSlots({ businessHours: HOURS, fromDate: '08/03', toDate: '2026-08-03' }), /YYYY-MM-DD/);
// 打烊早於開店 / 無效 slot_minutes → 略過該筆，不拋錯
assert.deepStrictEqual(
  computeSlots({ businessHours: [{ weekday: MON, open_time: '18:00', close_time: '14:00', slot_minutes: 60 }],
    fromDate: '2026-08-03', toDate: '2026-08-03' }), []);

// ── unionHours：跨館合併（同 weekday 取最早開店~最晚打烊，slot_minutes 取最小）──
{
  const { unionHours } = require('../server/services/slotGenerator');
  const merged = unionHours([
    { weekday: 1, open_time: '07:00', close_time: '22:00', slot_minutes: 60 },  // K
    { weekday: 1, open_time: '05:30', close_time: '21:55', slot_minutes: 60 },  // B
    { weekday: 2, open_time: '06:00', close_time: '22:00', slot_minutes: 90 },
  ]);
  assert.strictEqual(merged.length, 2, '兩個 weekday 應合併成兩筆');
  const mon = merged.find((x) => x.weekday === 1);
  assert.strictEqual(mon.open_time, '05:30', '取最早開店');
  assert.strictEqual(mon.close_time, '22:00', '取最晚打烊');
  assert.strictEqual(mon.slot_minutes, 60);
  // 無效列（打烊早於開店）不得汙染結果
  assert.deepStrictEqual(unionHours([{ weekday: 3, open_time: '20:00', close_time: '08:00', slot_minutes: 60 }]), []);
  assert.deepStrictEqual(unionHours([]), []);
  assert.deepStrictEqual(unionHours(null), []);
}

// ── 合併後再切格：週一 05:30~22:00、60 分 → 16 格（最後一格 21:00-22:00）──
{
  const { unionHours } = require('../server/services/slotGenerator');
  const hours = unionHours([
    { weekday: 1, open_time: '07:00', close_time: '22:00', slot_minutes: 60 },
    { weekday: 1, open_time: '05:30', close_time: '21:55', slot_minutes: 60 },
  ]);
  const s = computeSlots({ businessHours: hours, fromDate: '2026-08-03', toDate: '2026-08-03' });
  assert.strictEqual(s.length, 16, `05:30~22:00 每 60 分應為 16 格，實際 ${s.length}`);
}

console.log('slot_generator_test: PASS');