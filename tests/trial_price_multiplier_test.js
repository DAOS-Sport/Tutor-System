/**
 * 試上價要乘教練係數（2026-09-07 規格改變，使用者決定）
 *
 * 由來：家長截圖「修課係數 120% / 試上 1 堂 NT$1,200」—— 固定價 1,200 沒吃係數，
 * 家長認為金額錯。原本程式註解明寫「試上不吃教練係數」，這次反過來：固定價 × 係數。
 *
 * 守的是純函式 calculateTrialPrice 的三條路徑都套同一規則，而且前端（CoachCard /
 * useEnrollmentPricing）沿用它 —— 畫面價與成交價必須同源。
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { calculateTrialPrice } = require(path.join(__dirname, '..', 'server/services/trialEnrollment.js'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

check('F-A07 固定價 × 係數（家長截圖的情境：1200 × 1.2 = 1440）', () => {
  assert.strictEqual(calculateTrialPrice({ basePrice: 6900, courseType: 1, configTrialPrice: 1200, multiplier: 1.2 }), 1440);
});

check('係數 1.0 時維持原價（一般教練不受影響）', () => {
  assert.strictEqual(calculateTrialPrice({ basePrice: 6900, courseType: 1, configTrialPrice: 1200, multiplier: 1 }), 1200);
  assert.strictEqual(calculateTrialPrice({ basePrice: 6900, courseType: 1, configTrialPrice: 1200 }), 1200, '沒傳係數＝1');
});

check('admin_settings 舊鍵路徑也乘係數', () => {
  assert.strictEqual(calculateTrialPrice({ basePrice: 3750, courseType: 2, settings: { trial_price_course_2: 700 }, multiplier: 1.3 }), 910);
  assert.strictEqual(calculateTrialPrice({ basePrice: 3750, courseType: 2, settings: { trial_price: 700 }, multiplier: 1.5 }), 1050);
});

check('推算退路不重乘：basePrice 上游已含係數，只除堂數', () => {
  // 沒有任何固定價 → 每期價 / 堂數；這裡的 basePrice 是 resolveUnitPrice 的結果（已乘係數），
  // 若在這裡再乘一次係數會變成 係數²，畫面價與成交價會分岔。
  assert.strictEqual(calculateTrialPrice({ basePrice: 6000, courseType: 1, settings: { sessions_per_period: 6 }, multiplier: 1.2 }), 1000);
});

check('壞的係數一律當 1（0 / 負數 / NaN / 字串垃圾）', () => {
  for (const bad of [0, -1, NaN, 'abc', null, undefined]) {
    assert.strictEqual(calculateTrialPrice({ basePrice: 6900, courseType: 1, configTrialPrice: 1200, multiplier: bad }), 1200, '係數=' + String(bad));
  }
});

check('四捨五入到整數（1200 × 1.15 = 1380；700 × 1.15 = 805）', () => {
  assert.strictEqual(calculateTrialPrice({ basePrice: 1, courseType: 1, configTrialPrice: 1200, multiplier: 1.15 }), 1380);
  assert.strictEqual(calculateTrialPrice({ basePrice: 1, courseType: 2, configTrialPrice: 700, multiplier: 1.15 }), 805);
});

check('前端 CoachCard / useEnrollmentPricing 也套了係數（畫面價＝成交價）', () => {
  const fs = require('fs');
  const card = fs.readFileSync(path.join(__dirname, '..', 'client/liff/src/components/CoachCard.jsx'), 'utf8');
  const hook = fs.readFileSync(path.join(__dirname, '..', 'client/liff/src/hooks/useEnrollmentPricing.js'), 'utf8');
  assert.ok(/Math\.round\(Number\(trialPrice\) \* trialMul\)/.test(card), 'CoachCard 的試上固定價沒有乘係數');
  assert.ok(/Math\.round\(configured \* m\)/.test(hook), 'useEnrollmentPricing 的試上固定價沒有乘係數');
});

console.log(failures ? '\n' + failures + ' FAILED' : '\ntrial_price_multiplier: ALL PASS');
process.exitCode = failures ? 1 : 0;
