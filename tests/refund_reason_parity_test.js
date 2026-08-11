'use strict';
/**
 * 退課申請原因：前後端兩份鏡射必須一致。
 *
 * 跨 client/server 邊界無法共用模組（見 client/shared/coursePricing.js 的說明），
 * 所以這份清單有兩份實作：
 *   前端 client/shared/refundReasons.js  —— 畫下拉
 *   後端 server/services/refundReasons.js —— 驗證送進來的 code
 *
 * 兩邊分岔的後果很具體：櫃檯在下拉選得到某個原因，按送出卻被後端擋成
 * 「申請原因不在允許清單內」。所以逐項比對，任一邊改了另一邊沒跟上就紅。
 *
 * 另外驗手續費率的正規化 —— 那個值直接決定退多少錢，邊界不能有洞。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const srv = require('../server/services/refundReasons');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

(async () => {
  const cli = await import('../client/shared/refundReasons.js');

  check('兩份清單的 code 與 label 完全一致', () => {
    assert.ok(Array.isArray(srv.REFUND_REASONS) && srv.REFUND_REASONS.length >= 3,
      '後端清單只有 ' + (srv.REFUND_REASONS || []).length + ' 項，掃描或實作有問題');
    assert.deepStrictEqual(
      cli.REFUND_REASONS.map((r) => [r.code, r.label]),
      srv.REFUND_REASONS.map((r) => [r.code, r.label]),
      '前後端的申請原因清單不一致 —— 櫃檯會選得到卻送不出去',
    );
  });

  check('Owner 指定的五個原因都在（順序即畫面順序）', () => {
    assert.deepStrictEqual(srv.REFUND_REASONS.map((r) => r.label), [
      '公司因素 - 未媒合到教練',
      '公司因素 - 場地因素',
      '個人因素 - 生病/生理',
      '個人因素 - 一般正常退費',
      '其他',
    ]);
  });

  check('code 不重複，且都是穩定的英數識別碼', () => {
    const codes = srv.REFUND_REASON_CODES;
    assert.strictEqual(new Set(codes).size, codes.length, 'code 有重複');
    for (const c of codes) {
      assert.ok(/^[a-z][a-z0-9_]*$/.test(c),
        'code「' + c + '」不是穩定識別碼 —— 中文或含空白的 code 一旦寫進 audit log 就改不動了');
    }
  });

  check('label 查詢：查不到時原樣回傳，不吐 undefined', () => {
    assert.strictEqual(srv.refundReasonLabel('other'), '其他');
    assert.strictEqual(cli.refundReasonLabel('other'), '其他');
    // 歷史資料可能有已被移除的 code，畫面上要顯示原值而不是空白或 undefined
    assert.strictEqual(srv.refundReasonLabel('legacy_removed'), 'legacy_removed');
    assert.strictEqual(srv.refundReasonLabel(''), '');
    assert.strictEqual(srv.refundReasonLabel(null), '');
  });

  check('手續費率下拉預設值兩邊一致', () => {
    assert.deepStrictEqual(cli.REFUND_FEE_RATE_PRESETS, srv.REFUND_FEE_RATE_PRESETS);
    for (const r of srv.REFUND_FEE_RATE_PRESETS) {
      assert.ok(r >= 0 && r <= 1, '預設值 ' + r + ' 不在 0–1 之間（這是比率不是百分比）');
    }
  });

  check('normalizeFeeRate：夾限 0–1，不合法一律 null', () => {
    const cases = [
      ['0.1', 0.1], [0.1, 0.1], ['0', 0], [0, 0], ['1', 1], [1, 1],
      ['0.15', 0.15], [0.12345, 0.1235],
      ['1.5', null], [1.5, null], ['-0.1', null], [-1, null],
      ['abc', null], ['', null], [null, null], [undefined, null], [NaN, null], [Infinity, null],
    ];
    for (const [input, want] of cases) {
      assert.strictEqual(srv.normalizeFeeRate(input), want,
        'normalizeFeeRate(' + JSON.stringify(input) + ') 應為 ' + want);
    }
  });

  check('normalizeFeeRatePercent：吃百分比、吐比率，兩邊行為一致', () => {
    for (const [input, want] of [['10', 0.1], ['0', 0], ['100', 1], ['12.3', 0.123],
                                 ['101', null], ['-1', null], ['x', null], ['', null]]) {
      assert.strictEqual(srv.normalizeFeeRatePercent(input), want, '後端 ' + input);
      assert.strictEqual(cli.normalizeFeeRatePercent(input), want, '前端 ' + input);
    }
    // 12.3 / 100 在浮點下是 0.12299999999999999，必須被修掉
    assert.strictEqual(srv.normalizeFeeRatePercent('12.3'), 0.123);
  });

  // ── 後端真的有在用這份白名單嗎（不然清單再對也沒意義）──
  check('退費端點確實用白名單擋 category，並要求 detail', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/routes/admin/enrollments.js'), 'utf8');
    assert.ok(/REFUND_REASON_CODES\.includes\(category\)/.test(src),
      '後端沒有用白名單驗證 category —— 前端傳什麼就吃什麼');
    assert.ok(/詳述原因必填/.test(src), '後端沒有擋空的詳述原因');
    assert.ok(/normalizeFeeRate\(body\.fee_rate\)/.test(src),
      '後端沒有正規化前端送來的 fee_rate —— 那個值直接決定退款金額');
  });

  check('手續費率被調整時，audit log 記得下原值、新值與操作者', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/routes/admin/enrollments.js'), 'utf8');
    assert.ok(/preview\.fee_rate !== preview\.default_fee_rate/.test(src),
      '沒有比對「實用費率 vs 全域設定」，調整不會留痕');
    assert.ok(/由 \$\{by\} 調整/.test(src), 'audit 沒有記下是誰調的');
    // 必須比對 preview 回來的值，不能信前端送的數字
    assert.ok(!/body\.fee_rate[^)]*!==/.test(src),
      'audit 用了前端送來的 fee_rate 做比對 —— 應以後端試算結果為準');
  });

  check('前端不自己算金額（金額只能有一個來源）', () => {
    const page = fs.readFileSync(path.join(ROOT, 'client/admin/src/pages/RefundPage.jsx'), 'utf8');
    assert.ok(/enrollmentsApi\.refundPreview\(target\.id,/.test(page),
      '改費率後沒有重新跟後端要試算');
    assert.ok(!/final_price\s*\*\s*/.test(page),
      '前端自己乘出退款金額 —— 畫面顯示與實際入帳會分岔');
  });

  if (failed) { console.error('refund_reason_parity_test: ' + failed + ' failed'); process.exit(1); }
  console.log('refund_reason_parity_test: all passed');
})();
