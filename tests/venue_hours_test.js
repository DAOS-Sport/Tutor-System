'use strict';
// 場館營業時間 — 輸入驗證（純函式，零外部相依）
const assert = require('assert');
const { validateRow } = require('../server/routes/admin/venueHours');

const ok = { weekday: 1, open_time: '07:00', close_time: '22:00', slot_minutes: 60 };
assert.deepStrictEqual(validateRow(ok, 0), [], '合法設定不得有錯誤');

// weekday 範圍
assert.ok(validateRow({ ...ok, weekday: -1 }, 0)[0].includes('weekday'));
assert.ok(validateRow({ ...ok, weekday: 7 }, 0)[0].includes('weekday'));
assert.ok(validateRow({ ...ok, weekday: '1.5' }, 0)[0].includes('weekday'));
assert.deepStrictEqual(validateRow({ ...ok, weekday: 0 }, 0), [], '週日(0) 合法');
assert.deepStrictEqual(validateRow({ ...ok, weekday: 6 }, 0), [], '週六(6) 合法');

// 時間格式
assert.ok(validateRow({ ...ok, open_time: '7:00' }, 0)[0].includes('open_time'), '須補零');
assert.ok(validateRow({ ...ok, open_time: '24:00' }, 0)[0].includes('open_time'));
assert.ok(validateRow({ ...ok, close_time: '22:60' }, 0)[0].includes('close_time'));
assert.ok(validateRow({ ...ok, open_time: '' }, 0).length > 0);
assert.ok(validateRow({ ...ok, open_time: undefined }, 0).length > 0);

// 打烊必須晚於開店
assert.ok(validateRow({ ...ok, open_time: '22:00', close_time: '07:00' }, 0)
  .some((e) => e.includes('晚於')), '顛倒須擋下');
assert.ok(validateRow({ ...ok, open_time: '09:00', close_time: '09:00' }, 0)
  .some((e) => e.includes('晚於')), '相同時間須擋下');

// slot_minutes
assert.deepStrictEqual(validateRow({ ...ok, slot_minutes: undefined }, 0), [], '缺省視為 60');
assert.ok(validateRow({ ...ok, slot_minutes: 0 }, 0)[0].includes('slot_minutes'));
assert.ok(validateRow({ ...ok, slot_minutes: -30 }, 0)[0].includes('slot_minutes'));
assert.ok(validateRow({ ...ok, slot_minutes: 500 }, 0)[0].includes('slot_minutes'));
assert.ok(validateRow({ ...ok, slot_minutes: 60.5 }, 0)[0].includes('slot_minutes'));

// 真實資料：四個場館的設定都必須通過
for (const [o, c] of [['05:30', '22:00'], ['07:00', '22:00'], ['07:00', '21:55'], ['06:00', '22:00']]) {
  assert.deepStrictEqual(validateRow({ weekday: 3, open_time: o, close_time: c, slot_minutes: 60 }, 0), [],
    `正式庫設定 ${o}-${c} 必須合法`);
}

// 錯誤訊息要帶第幾筆，否則櫃檯不知道改哪一列
assert.ok(validateRow({ ...ok, weekday: 9 }, 4)[0].includes('第 5 筆'));

// 多個錯誤要一次回報，不是遇到第一個就停
assert.strictEqual(validateRow({ weekday: 9, open_time: 'x', close_time: 'y', slot_minutes: 0 }, 0).length, 4);

console.log('venue_hours_test: PASS');