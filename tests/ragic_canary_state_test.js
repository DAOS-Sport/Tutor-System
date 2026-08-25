/**
 * 「未啟用」不可以偽裝成「未通過」。
 *
 * 這是正式庫真實發生過的事：canary 從 2026-07-07 上線起就沒設定過，
 * 而未設定的那條路徑把 freshness_verified 記成 false —— 也就是「驗證未通過」。
 * 於是狀態頁 H01/H05 常紅、累積 12,366 次假故障、通過 0 次，
 * 姓名品質掃描因為「拿不到經驗證的快照」而從來沒有跑過一次。
 * 沒有人知道真正要做的只是去 Ragic 建一筆記錄、填兩個環境變數。
 *
 * 三條界線在這裡釘死：
 *   1. 沒設定 → freshness_verified 是 null（沒有驗），不是 false（驗了沒過）
 *   2. isCanaryConfigured 誠實反映設定狀態
 *   3. 未設定時 canary_skipped 為真 —— 這是「別發警報、畫面顯示未啟用」的依據
 *
 * 刻意不測「未設定時仍拒絕使用快照」以外的行為變更：fail-closed 必須原封不動，
 * 這次改的只有「怎麼描述這個狀態」，不是「這個狀態下做什麼」。
 */
const assert = require('assert');
const path = require('path');

const F = require(path.resolve(__dirname, '../server/services/ragicFreshness'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

(async () => {
  // ── 1. isCanaryConfigured 要誠實 ────────────────────────────
  check('環境變數全空 → isCanaryConfigured 為 false', () => {
    assert.strictEqual(F.isCanaryConfigured('H01', {}), false);
  });

  check('只給 RECORD_ID 不算設定完成（少了 nonce 欄位就驗不了）', () => {
    assert.strictEqual(F.isCanaryConfigured('H01', { RAGIC_CANARY_H01_RECORD_ID: '5' }), false);
  });

  check('兩者都給 → true', () => {
    assert.strictEqual(F.isCanaryConfigured('H01', {
      RAGIC_CANARY_H01_RECORD_ID: '5',
      RAGIC_CANARY_H01_NONCE_FIELD_ID: '1000123',
    }), true);
  });

  check('sheetCode 是空的不該炸掉，回 false 即可（狀態頁會拿它算顯示）', () => {
    assert.strictEqual(F.isCanaryConfigured('', {}), false);
    assert.strictEqual(F.isCanaryConfigured(undefined, {}), false);
  });

  // ── 2. 未設定的那條路徑：null，不是 false ──────────────────
  const snapshot = { data: [{ _ragicId: 1, name: 'x' }] };
  const skipResult = await F.runCanaryWriteReadProof({
    config: F.getCanaryConfig('H01', {}),      // 未設定
    runId: 'test-run',
    writeNonce: async () => { throw new Error('未設定時不該去寫 canary'); },
    fetchCanary: async () => { throw new Error('未設定時不該去讀 canary'); },
    fetchSnapshot: async () => snapshot,
  });

  await checkAsync('未設定 → canary_skipped 為 true（警報與畫面文案的依據）', async () => {
    assert.strictEqual(skipResult.freshness.canary_skipped, true);
  });

  await checkAsync('未設定 → freshness_verified 是 null，不是 false', async () => {
    assert.strictEqual(skipResult.freshness.freshness_verified, null,
      `實際拿到 ${JSON.stringify(skipResult.freshness.freshness_verified)}；`
      + 'false 代表「驗過但沒通過」，會讓純設定缺漏長得像真故障');
  });

  await checkAsync('未設定 → 不是 stale_read（沒驗過就不能宣稱資料過期）', async () => {
    assert.strictEqual(skipResult.stale_read, false);
  });

  // ── 3. fail-closed 行為不可以被這次改動放寬 ────────────────
  // 用不到 DB，直接讀原始碼確認判準仍是「= TRUE」而非「IS NOT FALSE」之類的放寬。
  const fs = require('fs');
  const adminSrc = fs.readFileSync(
    path.resolve(__dirname, '../server/services/ragicAdmin.js'), 'utf8');
  check('hasRecentFreshPull 仍要求 freshness_verified = TRUE（null 一樣擋）', () => {
    const m = adminSrc.match(/function hasRecentFreshPull[\s\S]{0,900}?\n}/);
    assert.ok(m, '找不到 hasRecentFreshPull');
    assert.ok(/freshness_verified\s*=\s*TRUE/i.test(m[0]),
      '判準被改寬了：null（未驗證）必須跟 false 一樣不能通過');
  });

  check('未設定時的警報被抑制（canary_skipped 直接 return）', () => {
    const m = adminSrc.match(/async function _alertFreshnessIfNeeded[\s\S]*?\n}/);
    assert.ok(m, '找不到 _alertFreshnessIfNeeded');
    assert.ok(/canary_skipped\)\s*return;/.test(m[0]),
      '未設定是設定狀態不是事故，每輪叫一次只會讓人把警報整個靜音');
  });

  // ── 4. 旗標必須撐過中途的白名單複製 ──────────────────────
  // _withFreshness / _freshnessFromResult 是逐欄複製的，漏掉 canary_skipped
  // 的話，警報抑制到底生不生效就要看呼叫點剛好傳原始物件還是複製品 ——
  // 那種「剛好對」的正確性遲早會被一次無關的重構弄壞。
  function bodyOf(name) {
    const i = adminSrc.indexOf('function ' + name);
    assert.ok(i >= 0, '找不到 ' + name);
    const j = adminSrc.indexOf('\n}', i);
    assert.ok(j > i, name + ' 找不到結尾');
    return adminSrc.slice(i, j);
  }

  check('_withFreshness 保留 canary_skipped', () => {
    assert.ok(bodyOf('_withFreshness').includes('canary_skipped'),
      '旗標在這裡被吃掉，未設定時仍會每輪發警報');
  });

  check('_freshnessFromResult 保留 canary_skipped', () => {
    assert.ok(bodyOf('_freshnessFromResult').includes('canary_skipped'),
      '旗標在這裡被吃掉，未設定時仍會每輪發警報');
  });

  console.log(failures ? `\n${failures} FAILED` : '\nragic_canary_state: ALL PASS');
  process.exitCode = failures ? 1 : 0;
})();

