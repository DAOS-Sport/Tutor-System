/**
 * Ragic 狀態頁（/admin/ragic-status，2026-09-23）
 *
 *  1. 排程時間只有一個來源（server/constants/ragicJobSchedules.js），而且逐條對得上
 *     server/cron/index.js。原頁面寫「每 10 分鐘」「01:00 拉回」「02:00 備份」，
 *     實際是 00:30 備份、02:30 拉回、03:30 員工與場館，錯了好幾個月沒人發現。
 *  2. 「Z01 姓名品質掃描」（quarantine）退役：擁有者確認不需要；卡片拿掉、不能手動觸發，
 *     夜間排程（凍結檔 cron/index.js 照舊呼叫）經 ragicAdmin 的單一閘門一律跳過。
 *  3. 版面維持原本的卡片（擁有者要求），只改：排程列、「部分完成」、錯誤時間的文字。
 *     每晚寫回 Ragic 只因「資料本身有問題」（缺生日、身分證重複）而失敗時顯示「部分完成」
 *     與原因，不是紅色「失敗」——正式站每晚其實都有寫回 5～16 筆，只是被 61 筆壞資料拖成 error。
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
const jobRunners = (() => {
  const body = /const JOB_RUNNERS = \{([\s\S]*?)\};/.exec(routeSrc)[1];
  return [...body.matchAll(/^\s*([a-z]+)\s*:/gm)].map((m) => m[1]);
})();
check('狀態頁的每個工作都有排程說明', () => {
  assert.ok(jobRunners.length >= 6, `JOB_RUNNERS 只解析到 ${jobRunners.length} 個`);
  for (const job of jobRunners) assert.ok(RAGIC_JOB_SCHEDULES[job], `${job} 不在 ragicJobSchedules.js`);
});
check('後端不再回傳寫死的「每 10 分鐘」', () => {
  assert.ok(!routeSrc.includes("'*/10 * * * *'"));
  assert.ok(routeSrc.includes('schedules: { jobs: RAGIC_JOB_SCHEDULES, background: RAGIC_BACKGROUND_SCHEDULES }'));
  assert.ok(routeSrc.includes('by_job_code: byJobCode.rows'), 'sync-failures 要提供依工作彙整的原因');
});

// ── 2. quarantine 退役 ────────────────────────────────────────────────────
const adminSrc = read('server/services/ragicAdmin.js');
check('quarantine 退役：不在狀態頁、不能手動觸發、排程經閘門跳過', () => {
  assert.ok(!jobRunners.includes('quarantine'), 'JOB_RUNNERS 不該再有 quarantine（全部同步／開關都吃這張表）');
  assert.ok(!RAGIC_JOB_SCHEDULES.quarantine, '排程對照表不該再列 quarantine');
  assert.ok(adminSrc.includes("const RETIRED_JOBS = new Set(['quarantine']);"));
  const isEnabled = /async function isJobEnabled\(jobName\) \{([\s\S]*?)\n\}/.exec(adminSrc)[1];
  assert.ok(/^\s*if \(RETIRED_JOBS\.has\(jobName\)\) return false;/.test(isEnabled), 'isJobEnabled 第一行就要擋掉退役工作');
  assert.ok(adminSrc.includes("async function quarantineBadZ01Names(triggeredBy = 'cron') { return _singleflight('quarantine', triggeredBy); }"),
    '排程呼叫的入口必須經 _singleflight → _runWithLog → isJobEnabled');
  assert.ok(/\n  RETIRED_JOBS,\n/.test(adminSrc), 'RETIRED_JOBS 要匯出');
  // 列表與開關回應都只列還在用的工作
  assert.equal((routeSrc.match(/await ragicAdmin\.getSyncStatusSnapshot\(\)/g) || []).length, 1, '只有 activeJobSnapshot 可以直接讀全部');
  assert.equal((routeSrc.match(/await activeJobSnapshot\(\)/g) || []).length, 2);
});

// ── 3. 頁面：原本的卡片，只改必要處 ─────────────────────────────────────────
const page = read('client/admin/src/pages/RagicStatusPage.jsx');
check('維持原本的卡片版面', () => {
  for (const needle of ['function FormCard(', '<LiveProbePanel probe={data.live_probe} />', '單獨同步此表', '發送連線 Ping', '⚠ 資料維護']) {
    assert.ok(page.includes(needle), `少了 ${needle}`);
  }
});
check('管理員操作都還在', () => {
  for (const needle of ["runSync('all')", 'onSync(job)', 'onToggle(job, next)', 'ragicStatusApi.purgeGhosts()',
    '<WebhookInboxPanel canRetry={isAdmin}']) {
    assert.ok(page.includes(needle), `少了 ${needle}`);
  }
  assert.ok(read('client/admin/src/components/WebhookInboxPanel.jsx').includes('ragicStatusApi.retryWebhook(item)'));
});
check('頁面不再寫死排程時間，改用後端 schedules', () => {
  for (const stale of ['每 10 分鐘', '01:00', '02:00', 'cron_schedule', 'next_cron_run_at']) {
    assert.ok(!page.includes(stale), `頁面仍含「${stale}」`);
  }
  assert.ok(page.includes("{schedule?.text || '—'}"), '卡片要有排程列');
  assert.ok(page.includes("sched('pull')") && page.includes("sched('backup')"), '說明要用實際排程');
  assert.ok(!/<PageHeader[^>]*description=/.test(page), 'PageHeader 不吃 description，錯的說明也不要留');
});
check('「部分完成」走共用判斷，並列出原因', () => {
  assert.ok(page.includes("jobState({ last_status: 'error' }, issues).key === 'partial'"));
  assert.ok(page.includes('reasonText(r.code)'));
});

// ── 判斷邏輯：直接 import 前端用的同一支模組 ────────────────────────────────
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
  check('Webhook 請求結果翻成白話，被拒的標出來', () => {
    assert.equal(view.attemptOutcome('ok').rejected, false);
    for (const o of ['unauthorized', 'invalid_payload', 'method_not_allowed']) {
      assert.equal(view.attemptOutcome(o).rejected, true, o);
    }
    assert.equal(view.attemptOutcome('???').text, '其他');
  });

  if (failures) {
    console.error(`ragic_status_page_test: ${failures} FAIL`);
    process.exit(1);
  }
  console.log('ragic_status_page_test: PASS');
})().catch((e) => { console.error(e); process.exit(1); });
