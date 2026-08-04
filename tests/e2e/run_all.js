// 跑完 8 條 E2E 路徑，回報 pass/fail
const { spawnSync } = require('child_process');
const path = require('path');
const { clearTokenCache } = require('./_lib');

// 整輪開始先清掉舊的 token 快取（避免用到上一輪過期 token）。
// 之後各子行程經 _lib.loginAdmin 以檔案快取共用 token，同帳號整輪只登入一次，
// 不會打爆後台登入限流（5 次 / 5 分鐘 / IP）。
clearTokenCache();

const PATHS = [
  ['A', 'path_a_purchase.js'],
  ['B', 'path_b_slot.js'],
  ['C', 'path_c_group_confirm.js'],
  ['D', 'path_d_self_cancel.js'],
  ['E', 'path_e_promotion.js'],
  ['F', 'path_f_mgm.js'],
  ['G', 'path_g_learning_history.js'],
  ['H', 'path_h_transfer.js'],
  ['Checkout', 'checkout_idempotency.js'],
  ['Checkout2x4', 'checkout_multi_student_periods.js'],
  ['CheckoutGroup', 'checkout_group_isolation.js'],
  ['F-M02Scope', 'admin_checkout_scope_cancel.js'],
  ['EnrollmentIdempotency', 'enrollment_idempotency.js'],
  ['GroupProofPersistence', 'group_proof_persistence.js'],
  ['ManualDeduction', 'admin_manual_deduction.js'],
  ['SessionsRegression', 'admin_sessions_regression.js'],
  ['FamilyShared', 'family_shared_period.js'],
  ['ParentReconcileLink', 'parent_reconcile_link.js'],
  ['CheckoutFamilyInvoices', 'checkout_family_invoices.js'],
  ['GroupPartnerCheckin', 'group_partner_checkin.js'],
  ['TrialFullChain', 'trial_full_chain.js'],
  ['Flex18', 'flex_templates_verify.js'],
  // 模組 1（時段供給）。三支都需要 server 已啟動，與上面各條同樣的前提。
  ['SlotSupply', 'slot_supply_e2e.js'],
  ['SlotSupplyPerm', 'slot_supply_permissions_smoke.js'],
  ['CoachAutoSlotVisible', 'coach_auto_slot_visibility.js'],
  ['CoachBlockFlow', 'coach_block_flow.js'],
];

// 已知未納入、尚待分流的 E2E。列在這裡不代表沒問題，只代表「有人知道它沒在跑」——
// 每輪都會印出來，不會像先前那樣完全無聲。要嘛補進 PATHS，要嘛刪掉。
// 模組 1 的三支原本就是這樣躺在清單外一整輪，期間的阻斷性迴歸沒有任何測試會擋。
const UNLISTED_PENDING_TRIAGE = new Set([
  'parent_local_first_registration.js',
  'path_r3_trial50.js',
  'path_r4_disabled_group.js',
  'path_r9_venue.js',
  'ragic_z01_z03_split_claim.js',
  'self_checkin_mode.js',
]);

// 漏網檢查：tests/e2e/ 底下每支 .js 都必須在 PATHS 或上面的待分流清單裡
//（_ 開頭的共用模組與這支 runner 自己除外）。新增的檔案不能靜悄悄地不被執行。
{
  const fs = require('fs');
  const listed = new Set(PATHS.map(([, f]) => f));
  const all = fs.readdirSync(__dirname)
    .filter((n) => n.endsWith('.js') && !n.startsWith('_') && n !== 'run_all.js');
  const missing = all.filter((n) => !listed.has(n) && !UNLISTED_PENDING_TRIAGE.has(n));
  if (missing.length) {
    console.error('未列入 run_all.js PATHS 的 E2E 檔（不會被執行）：');
    for (const m of missing) console.error(`  - tests/e2e/${m}`);
    process.exit(1);
  }
  const stillPending = all.filter((n) => UNLISTED_PENDING_TRIAGE.has(n));
  if (stillPending.length) {
    console.warn(`⚠ 以下 ${stillPending.length} 支 E2E 尚未納入本輪執行（待分流）：`);
    for (const m of stillPending) console.warn(`  - tests/e2e/${m}`);
  }
}

const results = [];
for (const [tag, file] of PATHS) {
  const r = spawnSync('node', [path.join(__dirname, file)], { stdio: 'inherit' });
  results.push({ tag, ok: r.status === 0 });
}

console.log('\n=== E2E summary ===');
for (const r of results) console.log(` Path ${r.tag}: ${r.ok ? '✅ PASS' : '❌ FAIL'}`);
const failed = results.filter((r) => !r.ok).length;
process.exit(failed === 0 ? 0 : 1);
