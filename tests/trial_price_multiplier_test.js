/**
 * 試上價要乘教練係數（2026-09-07 規格改變，使用者決定）—— v7 API 版。
 * v7：admin_settings 舊鍵相容分支已移除；basePrice 是中央 raw base；缺係數/壞係數＝null（失敗關閉，
 * 路由回 TRIAL_PRICE_NOT_CONFIGURED）；前端改共用 client/shared/coursePricing.js 的 resolveTrialUnitPrice。
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { calculateTrialPrice } = require(path.join(__dirname, '..', 'server/services/trialEnrollment.js'));
const srv = require(path.join(__dirname, '..', 'server/services/coursePricing.js'));

let failures = 0;
function check(label, fn) {
  return Promise.resolve().then(fn).then(() => console.log('  ok  ' + label),
    (e) => { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); });
}
const q = (o) => calculateTrialPrice({ sessionsPerPeriod: 6, ...o });

(async () => {
  await check('固定價 × 係數（1200 × 1.2 = 1440）', () => {
    assert.strictEqual(q({ basePrice: 6900, configTrialPrice: 1200, multiplier: 1.2 }), 1440);
  });
  await check('係數 1.0 維持原價；明價 0＝免費', () => {
    assert.strictEqual(q({ basePrice: 6900, configTrialPrice: 1200, multiplier: 1 }), 1200);
    assert.strictEqual(q({ basePrice: 6900, configTrialPrice: 0, multiplier: 1.2 }), 0);
  });
  await check('推算：raw base × 係數 ÷ 堂數；有級距明價用明價', () => {
    assert.strictEqual(q({ basePrice: 6000, multiplier: 1.2 }), 1200);
    assert.strictEqual(q({ basePrice: 6000, multiplier: 1.2, tierPrices: { '1.20': 8500 } }), 1417);
  });
  await check('admin_settings 舊鍵已不再影響試上價', () => {
    assert.strictEqual(calculateTrialPrice({ basePrice: 3750, multiplier: 1.3, sessionsPerPeriod: 6, settings: { trial_price: 700 } }), 813);
  });
  await check('缺係數／壞係數／缺堂數 → null（失敗關閉，不當成 1）', () => {
    for (const bad of [0, -1, NaN, 'abc', null, undefined]) {
      assert.strictEqual(q({ basePrice: 6900, configTrialPrice: 1200, multiplier: bad }), null, '係數=' + String(bad));
    }
    assert.strictEqual(calculateTrialPrice({ basePrice: 6900, configTrialPrice: 1200, multiplier: 1.2 }), null);
  });
  await check('四捨五入到整數（1380／805）', () => {
    assert.strictEqual(q({ basePrice: 1, configTrialPrice: 1200, multiplier: 1.15 }), 1380);
    assert.strictEqual(q({ basePrice: 1, configTrialPrice: 700, multiplier: 1.15 }), 805);
  });
  await check('前端 CoachCard / useEnrollmentPricing 用共用 resolveTrialUnitPrice，且與後端逐案一致', async () => {
    const fs = require('fs');
    for (const f of ['client/liff/src/components/CoachCard.jsx', 'client/liff/src/hooks/useEnrollmentPricing.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.ok(/import \{[^}]*resolveTrialUnitPrice[^}]*\} from '\.\.\/\.\.\/\.\.\/shared\/coursePricing'/.test(src), f + ' 沒有用共用的 resolveTrialUnitPrice');
    }
    const cli = await import('../client/shared/coursePricing.js');
    let n = 0;
    for (const b of [null, 0, 6000, '6900', -1]) for (const m of [null, 0, 1, 1.2, '1.50']) for (const t of [null, { '1.20': 8500 }])
      for (const tr of [null, '', 0, 700, '1200', -5]) for (const sp of [null, 0, 6, 4.5]) {
        n++;
        assert.strictEqual(cli.resolveTrialUnitPrice(b, m, t, tr, sp),
          srv.resolveTrialUnitPrice({ basePrice: b, multiplier: m, tierPrices: t, trialPrice: tr, sessionsPerPeriod: sp }),
          JSON.stringify({ b, m, t, tr, sp }));
      }
    assert.ok(n > 1000);
  });
  console.log(failures ? '\n' + failures + ' FAILED' : '\ntrial_price_multiplier: ALL PASS');
  process.exitCode = failures ? 1 : 0;
})();
