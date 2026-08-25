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
  ['GroupAutoSubmit', 'group_auto_submit.js'],
  ['IntegrationSessions', 'integration_sessions.js'],
  ['ZonePriceIsolation', 'zone_price_isolation.js'],
  ['PricingZones', 'pricing_zones.js'],
  ['VenuePurchasable', 'venue_purchasable.js'],
  ['ParentPriceMatch', 'parent_price_match.js'],
  ['ManualDeduction', 'admin_manual_deduction.js'],
  ['SessionsRegression', 'admin_sessions_regression.js'],
  ['FamilyShared', 'family_shared_period.js'],
  ['ParentReconcileLink', 'parent_reconcile_link.js'],
  ['CheckoutFamilyInvoices', 'checkout_family_invoices.js'],
  ['GroupPartnerCheckin', 'group_partner_checkin.js'],
  ['TrialFullChain', 'trial_full_chain.js'],
  ['Flex18', 'flex_templates_verify.js'],
];

const results = [];
for (const [tag, file] of PATHS) {
  const r = spawnSync('node', [path.join(__dirname, file)], { stdio: 'inherit' });
  results.push({ tag, ok: r.status === 0 });
}

console.log('\n=== E2E summary ===');
for (const r of results) console.log(` Path ${r.tag}: ${r.ok ? '✅ PASS' : '❌ FAIL'}`);
const failed = results.filter((r) => !r.ok).length;
process.exit(failed === 0 ? 0 : 1);
