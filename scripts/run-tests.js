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
  'tests/admin_group_order_filter_ui_test.js',
  'tests/admin_role_gate_consistency_test.js',
  'tests/coach_order_bucket_test.js',
  'tests/liff_nav_consistency_test.js',
  'tests/coach_checkin_badge_style_test.js',
  'tests/coach_checkin_removed_test.js',
  'tests/reconcile_email_test.js',
  'tests/venue_oa_deeplink_test.js',
  'tests/mail_describe_test.js',
  'tests/coach_session_date_range_test.js',
  'tests/coach_push_scope_test.js',
  'tests/course_tier_price_test.js',
  'tests/checkin_label_test.js',
  'tests/force_trigger_outbox_cli_test.js',
  'tests/group_payment_proof_test.js',
  'tests/line_single_push_channel_test.js',
  'tests/line_parent_bind_compat_test.js',
  'tests/object_storage_db_fallback_test.js',
  'tests/object_storage_driver_test.js',
  'tests/object_storage_existence_test.js',
  'tests/piiMask_test.js',
  'tests/preflight_release_20260712_test.js',
  'tests/public_coach_field_exposure_test.js',
  'tests/refund_list_perf_test.js',
  'tests/refund_reason_parity_test.js',
  'tests/session_note_visibility_test.js',
  'tests/promotion_label_test.js',
  'tests/promotion_order_test.js',
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