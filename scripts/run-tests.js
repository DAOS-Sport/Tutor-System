#!/usr/bin/env node
'use strict';
/**
 * 測試分層 runner
 *
 * tests/ 底下是腳本式測試（頂層 assert + exit 0/1，見 tests/README.md），
 * 原本沒有任何 npm 入口、只能手動一支一支 node 跑。這支把它們接起來。
 *
 *   node scripts/run-tests.js unit   零外部相依（預設）：不連 DB、不打網路
 *   node scripts/run-tests.js db     需要真實 Postgres；只吃 TEST_DATABASE_URL
 *   node scripts/run-tests.js e2e    委派既有的 tests/e2e/run_all.js（需先起 server）
 *
 * 分層是安全邊界，不是分類美學：DB 那層多數會 DELETE FROM identity_claims /
 * ragic_sync_outbox 做前置清理，對正式庫跑會直接毀資料。故 db 層採白名單式
 * fail-closed —— 只認 TEST_DATABASE_URL，永遠不會沿用 DATABASE_URL。
 *
 * 新增測試檔請同步加進下面的清單；未列入的檔案會讓 runner 直接失敗，
 * 避免有測試被靜默漏掉。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');

// 零外部相依：Ragic/LINE/物件儲存都是 stub 或純字串斷言，不碰 DB 也不出網路。
const UNIT = [
  'tests/error_boundary_test.js',
  // 測試套件本身的體檢。放第一個：它抓的是「其他測試有沒有在說謊」，
  // 而 manual_deduction_backdate 就這樣瞎了一段時間 —— 指向的元件早已搬走、
  // 每次 ENOENT，但檔尾沒有 exitCode，runner 一直記成 PASS。
  'tests/test_suite_integrity_test.js',
  'tests/admin_group_order_filter_ui_test.js',
  'tests/admin_role_gate_consistency_test.js',
  'tests/coach_order_bucket_test.js',
  'tests/liff_nav_consistency_test.js',
  'tests/coach_checkin_badge_style_test.js',
  'tests/coach_checkin_removed_test.js',
  'tests/shared_class_checkin_contract_test.js',
  'tests/reconcile_email_test.js',
  'tests/venue_oa_deeplink_test.js',
  'tests/mail_describe_test.js',
  'tests/coach_session_date_range_test.js',
  'tests/coach_push_scope_test.js',
  'tests/manual_deduction_backdate_test.js',
  'tests/shared_datepicker_rollout_test.js',
  'tests/coach_bio_limit_test.js',
  'tests/db_client_error_guard_test.js',
  'tests/coach_avatar_test.js',
  'tests/enrollment_success_push_test.js',
  'tests/upload_error_test.js',
  'tests/course_tier_price_test.js',
  'tests/checkin_label_test.js',
  'tests/force_trigger_outbox_cli_test.js',
  'tests/group_payment_proof_test.js',
  'tests/group_auto_submit_test.js',
  'tests/integration_api_exposure_test.js',
  'tests/pricing_zone_schema_test.js',
  'tests/course_config_zone_test.js',
  'tests/course_config_zone_scan_test.js',
  'tests/course_types_zone_ui_test.js',
  'tests/h05_empty_guard_test.js',
  'tests/line_single_push_channel_test.js',
  'tests/line_parent_bind_compat_test.js',
  'tests/object_storage_db_fallback_test.js',
  'tests/object_storage_driver_test.js',
  'tests/object_storage_existence_test.js',
  'tests/piiMask_test.js',
  'tests/preflight_release_20260712_test.js',
  'tests/public_api_exposure_test.js',
  'tests/public_coach_field_exposure_test.js',
  'tests/refund_reason_parity_test.js',
  'tests/session_note_visibility_test.js',
  'tests/promotion_label_test.js',
  'tests/promotion_order_test.js',
  'tests/parent_missing_email_test.js',
  'tests/missing_email_banner_test.js',
  'tests/identity_claim_constraint_test.js',
  'tests/rate_limit_test.js',
  'tests/ragic_canary_state_test.js',
  'tests/lifeguard_login_test.js',
  'tests/frontend_backoffice_gate_test.js',
  'tests/role_conflict_test.js',
  // 每個 modal 都要有高度上限與可捲的內層。原本 7 個彈窗在 375px 上
  // 底部按鈕永久不可達（其中手動扣課那個是 overflow-hidden，內容直接被裁掉），
  // 而唯一的出路是重整整頁 —— 那種壞法不會有人回報成 bug。
  'tests/mobile_modal_test.js',
  // 手機上彈窗要從底部升起（Uber 的做法：拇指在螢幕下半部，置中彈窗的按鈕
  // 落在最難按的位置），桌機維持置中。與上面那支管的是不同的事 ——
  // 那支管「有沒有高度上限與可捲內層」，這支管「位置與圓角有沒有跟著斷點換」。
  'tests/mobile_sheet_test.js',
  // 手機字級底線：抬得起來，而且絕不能漏到桌機。使用者明確要求桌機零變動，
  // 而全域覆寫 Tailwind 工具類最容易漏 —— max-width 寫成 768 就與 md: 重疊
  // 一個像素，桌機的 text-xs 跟著變大，而那種重疊看不出來、只有量了才知道。
  'tests/mobile_type_floor_test.js',
  // 橫排工具列要嘛收編 FilterBar、要嘛自帶手機規則。判準是「配對」：
  // 只有 w-full 而沒有對應的 md: 還原，等於為了手機把桌機也改掉了。
  'tests/filter_bar_adoption_test.js',
  // 救生員動線上的可點元素，手機上都要有 44px 命中區（桌機維持原密度）。
  // 第一版的解析器遇到屬性裡的箭頭函式就把標籤切斷，掃出 16 個假陽性 ——
  // 所以測試自己有一條在盯「抓不到 className 的比例」。
  'tests/mobile_touch_target_test.js',
  // 兩類「安靜壞掉」的前端錯誤：呼叫檔案裡不存在的函式（ReferenceError 被
  // try/catch 吃掉，症狀是「動作其實成功了，畫面卻說失敗」），以及把清單 API
  // 的資料當詳情 API 用（.map on undefined → ErrorBoundary → 整頁掛掉，
  // 而 mock 資料補齊了欄位，開發時看不到）。專案沒有 eslint。
  'tests/frontend_undefined_call_test.js',
  // 清單分批載入。全量載入的壞法只在正式庫（破千筆）才會撞到 axios 的 10 秒逾時，
  // 開發機 151 筆怎麼點都是好的 —— 所以只能靠測試盯著 limit 有沒有被拿掉。
  'tests/list_pagination_test.js',
  // 學員的隔離區自癒判準要跟著家長的 updated_at 走：櫃檯補的是 parents.email，
  // 而 students.updated_at 一動也不動 —— 沒有這條，Email 補完之後那批學員會
  // 永遠留在隔離區、再也不會被推上 Ragic，而且完全沒有錯誤訊息。
  'tests/ragic_backup_quarantine_selfheal_test.js',
  // 檔案搬回 bucket 的安全性質：預設 dry-run、驗證通過才寫帳本、
  // 刪除是獨立旗標且刪前重驗。這支腳本會動到 334 MB 的正式資料。
  'tests/uploaded_files_bucket_migration_test.js',
  'tests/role_derive_test.js',
  'tests/staff_multi_role_test.js',
  'tests/admin_api_gate_coverage_test.js',
  'tests/role_gate_coverage_test.js',
  'tests/role_permissions_test.js',
  'tests/base_price_venue_test.js',
  'tests/z01_uid_naming_test.js',
  'tests/role_source_of_truth_test.js',
  'tests/ragic_data_no_visibility_test.js',
  'tests/ragic_freshness_test.js',
  'tests/ragic_h01_line_uid_test.js',
  'tests/ragic_h23_coefficient_test.js',
  'tests/ragic_parent_outbox_flag_test.js',
  'tests/ragic_query_retry_test.js',
  'tests/ragic_writer_test.js',
  'tests/reconcile_payment_proof_visibility_test.js',
  'tests/sync_failure_log_test.js',
  'tests/taipei_input_test.js',
  'tests/release/canary_config_test.js',
  'tests/release/reconcile_image_pipeline_test.js',
];

// 需要真實 Postgres。多數含破壞性前置清理，只可對拋棄式測試庫執行。
const DB = [
  // 端到端：自己 spawn 一台 server、自己建 smoke_ 帳號、try/finally 清乾淨。
  // 不破壞既有資料，但需要真實 DATABASE_URL，所以歸在這一層而不是 unit。
  'tests/permission_smoke_test.js',
  'tests/coach_session_date_range_db_test.js',
  'tests/parent_identity_closure_test.js',
  'tests/push_gate_test.js',
  'tests/ragic_incremental_sync_test.js',
  'tests/ragic_z03_clean_delete_test.js',
  'tests/ragic_z03_tombstone_test.js',
  'tests/release/account_recovery_integration.js',
  'tests/release/admin_enrollment_line_name_test.js',
  'tests/release/application_rollback_rehearsal.js',
  'tests/release/multiple_candidate_integration.js',
  'tests/release/outbox_exact_processor_test.js',
  'tests/release/outbox_failure_test.js',
  'tests/release/parent_identity_release_cases.js',
  'tests/release/parent_registration_business_closure.js',
  'tests/release/record_652_registration_simulation.js',
  'tests/release/safety_invariants_test.js',
  'tests/release/schema_freshness_test.js',
  'tests/release/source_claim_concurrency_test.js',
  'tests/release/z03_persisted_error_recovery_test.js',
  'tests/release/z03_random_sample_login_test.js',
  'tests/release/z03_registration_form_50_batch_test.js',
  'tests/release/z03_same_source_duplicate_student_bind_test.js',
];

/** 漏網檢查：tests/ 與 tests/release/ 的每個 .js 都必須被分層，否則整輪失敗。 */
function assertNoUnclassified() {
  const listed = new Set([...UNIT, ...DB]);
  const found = [];
  for (const dir of ['tests', 'tests/release']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js')) found.push(`${dir}/${name}`);
    }
  }
  const missing = found.filter((f) => !listed.has(f));
  if (missing.length) {
    console.error('未分類的測試檔（請加進 scripts/run-tests.js 的 UNIT 或 DB 清單）：');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
}

/** 逐支 spawn，cwd 固定為 server/（與 tests/README.md 的手動跑法一致）。 */
function runFiles(files, extraEnv) {
  const results = [];
  for (const f of files) {
    const r = spawnSync('node', [path.join(ROOT, f)], {
      cwd: SERVER,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    results.push({ f, ok: r.status === 0 });
  }
  return results;
}

function report(results, label) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n── ${label}：${results.length - failed.length}/${results.length} PASS`);
  for (const r of failed) console.log(`   FAIL  ${r.f}`);
  return failed.length === 0;
}

const tier = process.argv[2] || 'unit';

if (tier === 'unit') {
  assertNoUnclassified();
  // server/ 內建的 node:test 單元測試（原本的 npm test 內容）
  const nodeTest = spawnSync('node', ['--test', 'test/'], { cwd: SERVER, stdio: 'inherit' });
  const ok = report(runFiles(UNIT), 'unit') && nodeTest.status === 0;
  if (nodeTest.status !== 0) console.log('   FAIL  server/test（node --test）');
  process.exit(ok ? 0 : 1);
}

if (tier === 'db') {
  assertNoUnclassified();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.error('db 層需要 TEST_DATABASE_URL（指向拋棄式測試庫）。');
    console.error('刻意不沿用 DATABASE_URL：這些測試含 DELETE，對正式庫執行會毀資料。');
    process.exit(1);
  }
  if (url === process.env.DATABASE_URL) {
    console.error('TEST_DATABASE_URL 與 DATABASE_URL 相同，拒絕執行。');
    process.exit(1);
  }
  process.exit(report(runFiles(DB, { DATABASE_URL: url }), 'db') ? 0 : 1);
}

if (tier === 'e2e') {
  const r = spawnSync('node', [path.join(ROOT, 'tests/e2e/run_all.js')], {
    cwd: ROOT, stdio: 'inherit',
  });
  process.exit(r.status === 0 ? 0 : 1);
}

console.error(`未知的層級：${tier}（可用：unit / db / e2e）`);
process.exit(1);