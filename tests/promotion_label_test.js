'use strict';
// 優惠折扣文字（家長端首頁與教練端今日頁共用）。ESM，動態 import 載入。
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const { promotionValueLabel: L } = await import(pathToFileURL(
    path.join(__dirname, '..', 'client', 'liff', 'src', 'utils', 'promotionLabel.js')
  ).href);

  // PERCENTAGE 存的是乘數。0.9 是「9 折」，不是「0.9 折」——這是最容易寫錯、
  // 而且錯了會讓教練跟家長講出不同價格的地方。
  assert.strictEqual(L({ type: 'PERCENTAGE', discount_value: 0.9 }), '9 折');
  assert.strictEqual(L({ type: 'PERCENTAGE', discount_value: 0.85 }), '8.5 折');
  assert.strictEqual(L({ type: 'PERCENTAGE', discount_value: 0.5 }), '5 折');
  // 尾數要收乾淨，不能出現「8.500000000000001 折」
  assert.strictEqual(L({ type: 'PERCENTAGE', discount_value: 0.83 }), '8.3 折');

  // value 也吃 promotion.value（不同端點欄位名不一樣）
  assert.strictEqual(L({ type: 'PERCENTAGE', value: 0.9 }), '9 折');

  // PERCENTAGE 但 > 1 是壞資料——不得硬算出一個看起來正常的數字
  assert.strictEqual(L({ type: 'PERCENTAGE', discount_value: 9 }), '優惠詳情請洽櫃檯');

  assert.strictEqual(L({ type: 'FIXED_AMOUNT', discount_value: 200 }), '現折 NT$ 200');
  assert.strictEqual(L({ type: 'FIXED_AMOUNT', discount_value: 1500 }), '現折 NT$ 1,500');

  // 缺值 / 壞值一律給保底文案，不得顯示 NaN 或空白
  for (const bad of [null, undefined, {}, { type: 'PERCENTAGE' },
    { type: 'PERCENTAGE', discount_value: 0 }, { type: 'PERCENTAGE', discount_value: -1 },
    { type: 'WEIRD', discount_value: 0.9 }]) {
    assert.strictEqual(L(bad), '優惠詳情請洽櫃檯', '壞值須給保底文案：' + JSON.stringify(bad));
  }

  console.log('promotion_label_test: PASS');
})().catch((err) => {
  console.error('promotion_label_test: FAIL');
  console.error(err);
  process.exit(1);
});