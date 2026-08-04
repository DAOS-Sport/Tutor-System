'use strict';
// 手動扣課「壓時間」的純邏輯測試。ESM 模組，用動態 import 載入。
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const mod = await import(pathToFileURL(
    path.join(__dirname, '..', 'client', 'admin', 'src', 'utils', 'occurredAt.js')
  ).href);
  const { parseOccurredAt, toLocalInputValue } = mod;

  const NOW = new Date('2026-08-04T12:00:00+08:00');

  // 未指定 → 不送 occurred_at，維持「伺服器接收時間」語意。
  // 這點很重要：後端的冪等指紋對「未指定」與「明確指定」是分開處理的，
  // 前端自己補一個 now 進去會讓每次 retry 的指紋都不同。
  assert.deepStrictEqual(parseOccurredAt('', NOW), { iso: null, error: null });
  assert.deepStrictEqual(parseOccurredAt('   ', NOW), { iso: null, error: null });
  assert.deepStrictEqual(parseOccurredAt(null, NOW), { iso: null, error: null });
  assert.deepStrictEqual(parseOccurredAt(undefined, NOW), { iso: null, error: null });

  // 過去時間 → 可用
  {
    const r = parseOccurredAt('2026-07-12T14:30', NOW);
    assert.strictEqual(r.error, null);
    assert.ok(r.iso, '過去時間應產生 ISO');
    // datetime-local 沒有時區，必須以本地時間解讀（不得自行補 Z）
    assert.strictEqual(r.iso, new Date('2026-07-12T14:30').toISOString());
  }

  // 未來時間 → 擋。補登是記錄已經上過的課，填未來會產生一堂 completed 卻還沒發生的課。
  {
    const r = parseOccurredAt('2026-09-01T09:00', NOW);
    assert.strictEqual(r.iso, null, '未來時間不得產生 ISO');
    assert.ok(r.error && r.error.includes('未來'), '須明確告知不能填未來');
  }

  // 邊界：正好等於現在 → 允許（不是未來）
  {
    const localNow = toLocalInputValue(NOW);
    const r = parseOccurredAt(localNow, NOW);
    assert.strictEqual(r.error, null, '正好現在應可用');
  }

  // 格式錯誤 → 給錯誤而不是靜靜吞掉
  {
    const r = parseOccurredAt('not-a-date', NOW);
    assert.strictEqual(r.iso, null);
    assert.ok(r.error && r.error.includes('格式'));
  }

  // toLocalInputValue 產生的字串必須能被 parseOccurredAt 讀回同一時刻
  {
    const d = new Date('2026-03-09T08:05:00');
    const back = parseOccurredAt(toLocalInputValue(d), new Date('2026-12-31T00:00:00'));
    assert.strictEqual(new Date(back.iso).getTime(), Math.floor(d.getTime() / 60000) * 60000,
      'round-trip 只該損失秒以下精度');
  }

  console.log('manual_deduction_occurred_at_test: PASS');
})().catch((err) => {
  console.error('manual_deduction_occurred_at_test: FAIL');
  console.error(err);
  process.exit(1);
});