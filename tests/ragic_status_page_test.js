/**
 * Ragic 狀態頁（/admin/ragic-status，2026-09-23 整理）
 *
 *  1. 排程時間只有一個來源（server/constants/ragicJobSchedules.js），而且逐條對得上
 *     server/cron/index.js。整理前頁面寫「每 10 分鐘」「01:00 拉回」「02:00 備份」，
 *     實際是 00:30 寫回、02:30 拉回、03:30 員工與場館，錯了好幾個月沒人發現。
 *  2. 每晚寫回 Ragic 只因「資料本身有問題」（缺生日、身分證重複）而失敗時，顯示「部分完成」
 *     而不是紅色「失敗」——正式站每晚其實都有寫回 5～16 筆，只是被 61 筆壞資料拖成 error。
 *  3. 版面整理後，管理員的每個操作都還在。
 *
 * 原始碼比對一律先把 CRLF 正規化，本機（autocrlf）與 Replit（LF）結果一致。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { RAGIC_JOB_SCHEDULES, RAGIC_BACKGROUND_SCHEDULES } = require('../server/constants/ragicJobSchedules');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

// ── 1. 排程對照 ─────────────────────────────────────────────────────────────
const cronSrc = read('server/cron/index.js');
// 以 scheduleTaipei( 切塊：每塊開頭是排程運算式，內容到下一個 scheduleTaipei( 為止
const blocks = cronSrc.split('scheduleTaipei(').slice(1)
  .map((body) => ({ expr: (/^\s*'([^']+)'/.exec(body) || [])[1], body }));

for (const [job, s] of Object.entries(RAGIC_JOB_SCHEDULES)) {
  check(`${job}（${s.text}）對得上 cron/index.js`, () => {
    if (s.cron === null) {
      assert.equal(s.text, '手動');
      return;
    }
    const hit = blocks.find((b) => b.expr === s.cron && b.body.includes(`${s.runner}(`));
    assert.ok(hit, `找不到 scheduleTaipei('${s.cron}') 且呼叫 ${s.runner}() 的區塊`);
  });
}
for (const s of RAGIC_BACKGROUND_SCHEDULES) {
  check(`${s.name}（${s.text}）對得上 cron/index.js`, () => {
    const hit = blocks.find((b) => b.expr === s.cron && b.body.includes(`${s.runner}(`));
    assert.ok(hit, `找不到 scheduleTaipei('${s.cron}') 且呼叫 ${s.runner}() 的區塊`);
  });
}
check('連線測試確實沒有排程（畫面寫「手動」是真的）', () => {
  for (const fn of ['pingParentsFromRagic', 'pingStudentsFromRagic']) {
    assert.ok(!cronSrc.includes(`${fn}(`), `${fn} 出現在 cron/index.js`);
  }
});

const routeSrc = read('server/routes/admin/ragicStatus.js');
check('狀態頁的每個工作都有名稱與時間', () => {
  const runners = /const JOB_RUNNERS = \{([\s\S]*?)\};/.exec(routeSrc)[1];
  const jobs = [...runners.matchAll(/^\s*([a-z]+)\s*:/gm)].map((m) => m[1]);
  assert.ok(jobs.length >= 7, `JOB_RUNNERS 只解析到 ${jobs.length} 個`);
  for (const job of jobs) assert.ok(RAGIC_JOB_SCHEDULES[job], `${job} 不在 ragicJobSchedules.js`);
});
check('後端不再回傳寫死的「每 10 分鐘」', () => {
  assert.ok(!routeSrc.includes("'*/10 * * * *'"));
  assert.ok(routeSrc.includes('schedules: { jobs: RAGIC_JOB_SCHEDULES, background: RAGIC_BACKGROUND_SCHEDULES }'));
  assert.ok(routeSrc.includes('by_job_code: byJobCode.rows'), 'sync-failures 要提供依工作彙整的原因');
});

// ── 3. 頁面 ────────────────────────────────────────────────────────────────
const page = read('client/admin/src/pages/RagicStatusPage.jsx');
check('頁面不再寫死排程時間', () => {
  for (const stale of ['每 10 分鐘', '01:00', '02:00', 'cron_schedule', 'next_cron_run_at']) {
    assert.ok(!page.includes(stale), `頁面仍含「${stale}」`);
  }
  assert.ok(page.includes('data.schedules'));
});
check('管理員操作都還在', () => {
  for (const needle of ["runSync('all')", 'onSync(job)', 'onToggle(job, next)', 'ragicStatusApi.purgeGhosts()',
    '<WebhookInboxPanel canRetry={isAdmin}']) {
    assert.ok(page.includes(needle), `少了 ${needle}`);
  }
  assert.ok(read('client/admin/src/components/WebhookInboxPanel.jsx').includes('ragicStatusApi.retryWebhook(item)'));
});
check('PageHeader 用 subtitle（傳 description 會被忽略、說明不會顯示）', () => {
  assert.ok(page.includes('subtitle={PAGE_DESCRIPTION}'));
  assert.ok(!/<PageHeader[^>]*description=/.test(page));
});

// ── 2. 判斷邏輯：直接 import 前端用的同一支模組 ─────────────────────────────
(async () => {
  const view = await import(pathToFileURL(path.join(ROOT, 'client/admin/src/utils/ragicStatusView.mjs')).href);
  const issues = view.summarizeFailures({
    by_job_code: [
      { job_name: 'backup', error_code: 'STUDENT_ID_NUMBER_EXISTS', error_kind: 'permanent', distinct_records: 31 },
      { job_name: 'backup', error_code: 'RAGIC_VALIDATION_ERROR', error_kind: 'permanent', distinct_records: 30 },
    ],
  });
  check('寫不進 Ragic 的資料依工作彙整', () => {
    assert.equal(issues.backup.permanent, 61);
    assert.equal(issues.backup.transient, 0);
    assert.deepEqual(issues.backup.reasons.map((r) => r.code), ['STUDENT_ID_NUMBER_EXISTS', 'RAGIC_VALIDATION_ERROR']);
  });
  check('只因資料問題失敗 → 部分完成', () => {
    assert.equal(view.jobState({ last_status: 'error' }, issues.backup).key, 'partial');
  });
  check('夾帶暫時性錯誤、或沒有資料問題的失敗 → 仍然是失敗', () => {
    assert.equal(view.jobState({ last_status: 'error' }, { permanent: 3, transient: 1, reasons: [] }).key, 'error');
    assert.equal(view.jobState({ last_status: 'error' }, undefined).key, 'error');
    assert.equal(view.jobState({ last_status: 'stale_read' }, undefined).key, 'error');
  });
  check('執行中、暫停優先於上次結果', () => {
    assert.equal(view.jobState({ last_status: 'error', in_progress: true }, issues.backup).key, 'running');
    assert.equal(view.jobState({ last_status: 'ok', admin_enabled: false }, undefined).key, 'paused');
    assert.equal(view.jobState({ last_status: 'ok' }, undefined).key, 'ok');
    assert.equal(view.jobState({}, undefined).key, 'none');
  });
  check('原因代碼翻成白話，未知代碼不外露', () => {
    assert.match(view.reasonText('STUDENT_ID_NUMBER_EXISTS'), /重複/);
    assert.match(view.reasonText('RAGIC_VALIDATION_ERROR'), /生日/);
    assert.equal(view.reasonText('SOMETHING_NEW'), '其他資料問題');
  });
  check('說明區時間軸：依時間排序、同一時間合併、每分鐘的另列', () => {
    const t = view.buildTimeline({ jobs: RAGIC_JOB_SCHEDULES, background: RAGIC_BACKGROUND_SCHEDULES });
    assert.deepEqual(t.daily.map((r) => r.time), ['00:10', '00:30', '02:30', '02:45', '03:30']);
    assert.deepEqual(t.daily.find((r) => r.time === '03:30').names, ['員工與教練', '場館']);
    assert.deepEqual(t.frequent.map((s) => s.key), ['webhook']);
  });

  if (failures) {
    console.error(`ragic_status_page_test: ${failures} FAIL`);
    process.exit(1);
  }
  console.log('ragic_status_page_test: PASS');
})().catch((e) => { console.error(e); process.exit(1); });
