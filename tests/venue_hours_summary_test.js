'use strict';
// 營業時間摘要的純邏輯測試（ESM，動態 import 載入）。
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { summarizeWeeklyHours, formatClosedDate } = await import(pathToFileURL(
    path.join(__dirname, '..', 'client', 'liff', 'src', 'utils', 'venueHoursSummary.js')
  ).href);

  const h = (weekday, open_time, close_time) => ({ weekday, open_time, close_time });

  // 全週相同 → 壓成一段
  {
    const r = summarizeWeeklyHours([0, 1, 2, 3, 4, 5, 6].map((w) => h(w, '05:30', '22:00')));
    assert.deepStrictEqual(r.lines, [{ label: '週日~週六', time: '05:30–22:00' }]);
    assert.strictEqual(r.closedLabel, null);
    assert.strictEqual(r.hasAny, true);
  }

  // 平日一段、週六另一段、週日休館
  {
    const r = summarizeWeeklyHours([
      ...[1, 2, 3, 4, 5].map((w) => h(w, '05:30', '22:00')),
      h(6, '08:00', '17:00'),
    ]);
    assert.deepStrictEqual(r.lines, [
      { label: '週一~週五', time: '05:30–22:00' },
      { label: '週六', time: '08:00–17:00' },
    ]);
    assert.strictEqual(r.closedLabel, '休館：週日');
  }

  // 不連續但時間相同的兩天，不得被合併成一段（週一、週三 相同，週二不同）
  {
    const r = summarizeWeeklyHours([
      h(1, '18:00', '21:00'), h(2, '09:00', '12:00'), h(3, '18:00', '21:00'),
    ]);
    assert.deepStrictEqual(r.lines.map((x) => x.label), ['週一', '週二', '週三'],
      '中間夾了不同時間，不可跨過去合併');
    assert.strictEqual(r.closedLabel, '休館：週日、週四、週五、週六');
  }

  // 同一天分段營業（未來若出現中午休息）：兩段都要顯示
  {
    const r = summarizeWeeklyHours([h(1, '09:00', '12:00'), h(1, '14:00', '18:00')]);
    assert.strictEqual(r.lines.length, 1);
    assert.strictEqual(r.lines[0].label, '週一');
    assert.ok(r.lines[0].time.includes('09:00–12:00') && r.lines[0].time.includes('14:00–18:00'),
      '分段營業兩段都要出現');
  }

  // 完全沒設定 → hasAny=false，畫面才知道要顯示「尚未設定」而不是空白
  {
    const r = summarizeWeeklyHours([]);
    assert.strictEqual(r.hasAny, false);
    assert.deepStrictEqual(r.lines, []);
    assert.strictEqual(r.closedLabel, '休館：週日、週一、週二、週三、週四、週五、週六');
    assert.strictEqual(summarizeWeeklyHours(null).hasAny, false);
  }

  // 髒資料不得讓整段爆掉
  {
    const r = summarizeWeeklyHours([{ weekday: 9 }, { weekday: null }, h(2, '10:00', '11:00')]);
    assert.deepStrictEqual(r.lines, [{ label: '週二', time: '10:00–11:00' }]);
  }

  // 休館日文案
  assert.strictEqual(formatClosedDate({ closed_date: '2026-08-17', reason: '場地整修' }), '8/17（場地整修）');
  assert.strictEqual(formatClosedDate({ closed_date: '2026-12-05' }), '12/5');

  console.log('venue_hours_summary_test: PASS');
})().catch((err) => {
  console.error('venue_hours_summary_test: FAIL');
  console.error(err);
  process.exit(1);
});