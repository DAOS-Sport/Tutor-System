// 跑完 8 條 E2E 路徑，回報 pass/fail
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const { requireTestDatabaseUrl, childEnv, EXTERNAL_SERVER } = require('./_testDb');

// 只認 TEST_DATABASE_URL；沒設或與 DATABASE_URL 指向同一個庫，就在任何子行程與連線之前結束。
const TEST_DATABASE_URL = requireTestDatabaseUrl();
// 之後載入的 _lib 與所有子行程都只看得到測試庫。
Object.assign(process.env, childEnv(TEST_DATABASE_URL));
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
  ['Rules20261014', 'rules_20261014_group_trial.js'],
  ['RulesD18b', 'rules_20261015_d18_remaining.js'],
  ['CourseTypesReadonly', 'course_types_counter_readonly.js'],
  ['RulesD18', 'rules_20261014_d18_booking_cancel.js'],
  ['Flex18', 'flex_templates_verify.js'],
  ['FamilyPhase2', 'family_phase2.js'],
  ['FamilyFrozenRoutes', 'family_frozen_routes.js'],
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// 路徑檔透過 BASE_URL 的 server 寫資料；server 連哪個庫，資料就寫進哪個庫。
// 所以預設由這裡用測試庫起一台：排程、LINE 推播、寄信關閉（PREVIEW_SAFE_MODE），
// 不連 Ragic、上傳寫本機。要打既有的 server，必須自己確認它連測試庫並設 E2E_EXTERNAL_SERVER=1。
async function startTestServer() {
  if (process.env.BASE_URL && process.env[EXTERNAL_SERVER] !== '1') {
    console.error(`已設 BASE_URL=${process.env.BASE_URL}，但無法確認那台 server 連的是測試庫。`
      + `確認後請加 ${EXTERNAL_SERVER}=1；或拿掉 BASE_URL，讓 run_all 自己用測試庫起 server。`);
    process.exit(1);
  }
  if (process.env.BASE_URL) return null;
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), PREVIEW_SAFE_MODE: '1', OBJECT_STORAGE_DRIVER: 'local',
    JWT_SECRET: process.env.JWT_SECRET || 'e2e-local-jwt-secret-not-for-production',
  };
  for (const k of ['NODE_ENV', 'REPLIT_DEPLOYMENT', 'RAGIC_API_KEY', 'RAGIC_BASE_URL']) delete env[k];
  const child = spawn(process.execPath, ['index.js'], { cwd: path.join(__dirname, '..', '..', 'server'), env, stdio: 'inherit' });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/health`)).ok) { process.env.BASE_URL = base; return child; } } catch { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGTERM');
  console.error('e2e 測試 server 沒有在 90 秒內就緒（見上方 server log）。');
  process.exit(1);
}

(async () => {
  const server = await startTestServer();
  const results = [];
  try {
    for (const [tag, file] of PATHS) {
      const r = spawnSync('node', [path.join(__dirname, file)], { stdio: 'inherit', env: process.env });
      results.push({ tag, ok: r.status === 0 });
    }
  } finally {
    if (server) server.kill('SIGTERM');
  }
  console.log('\n=== E2E summary ===');
  for (const r of results) console.log(` Path ${r.tag}: ${r.ok ? '✅ PASS' : '❌ FAIL'}`);
  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed === 0 ? 0 : 1);
})();
