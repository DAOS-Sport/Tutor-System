'use strict';
/**
 * 健康 API（GET /api/health/pipelines）的燈號規則：純函式，不連 DB。
 * 每條規則測綠／黃／紅的邊界；整份報告用中樞同一份 health-v1 範例檢查格式。
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rules = require(path.join(ROOT, 'server/services/healthRules'));
const slots = require(path.join(ROOT, 'server/cron/slots'));
const { contractProblems } = require('./fixtures/health_contract');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

console.log('health_rules_test');

const T = (taipei) => new Date(`${taipei}+08:00`);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const job = (name) => rules.DAILY_JOBS.find((j) => j.name === name);
const ctx = (now, extra = {}) => ({ now, schedulerActive: true, processStartedAt: new Date(now.getTime() - 3 * HOUR), isProduction: true, ...extra });
const run = (status, { started, finished, result, error } = {}) => ({
  status,
  started_at: started || null,
  finished_at: finished || null,
  error_message: error || null,
  result_summary: result === undefined ? null : { slot: 'x', result },
});

// ── 合約 ──────────────────────────────────────────────────────────────
const EXAMPLE_PATH = path.join(__dirname, 'fixtures/health-v1.example.json');
const EXAMPLE_SHA256 = '39192e13f6656e1512dea6b3c0615ce94ddddb24b2bc4d5b5df3dc727b632939';

check('合約範例與中樞 contract/health-v1.example.json 同一份（sha256，CRLF 視同 LF）', () => {
  const bytes = fs.readFileSync(EXAMPLE_PATH, 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), EXAMPLE_SHA256);
});

check('格式檢查本身有效：範例通過，改壞的範例被擋', () => {
  const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  assert.deepStrictEqual(contractProblems(example), []);
  const bad = JSON.parse(JSON.stringify(example));
  bad.pipelines[1].level = 'orange';
  bad.pipelines[2].id = bad.pipelines[0].id;
  bad.overall = 'green';
  bad.checkedAt = '2026-10-21 08:00';
  assert.strictEqual(contractProblems(bad).length >= 4, true, JSON.stringify(contractProblems(bad)));
  assert.ok(contractProblems({ ...example, pipelines: [] }).length > 0, '空的 pipelines 要被擋');
});

// ── 每日排程對照 cron/index.js ─────────────────────────────────────────
check('DAILY_JOBS 與 cron/index.js 的 slots.daily() 一一對應（名稱、時間、補跑方式）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/cron/index.js'), 'utf8');
  const starts = [...src.matchAll(/slots\.daily\('([a-z_]+)',\s*'(\d{2}:\d{2})'/g)];
  assert.ok(starts.length >= 8, '只解析到 ' + starts.length + ' 支每日排程 —— 正則失效');
  const fromCron = starts.map((m, i) => {
    const seg = src.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : src.length);
    return { name: m[1], hhmm: m[2], catchUp: /catchUp:\s*'same_day'/.test(seg) ? 'same_day' : 'any' };
  }).filter((j) => !rules.RETIRED_DAILY_JOBS.includes(j.name));
  const mine = rules.DAILY_JOBS.map(({ name, hhmm, catchUp }) => ({ name, hhmm, catchUp }));
  const key = (j) => j.name;
  assert.deepStrictEqual([...mine].sort((a, b) => key(a).localeCompare(key(b))), fromCron.sort((a, b) => key(a).localeCompare(key(b))));
});

check('slotsToJudge 的時段 key 與 cron/slots.js 相同（排定時間＋15 分鐘寬限）', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 300; i++) {
    const now = new Date(Date.parse('2026-01-01T00:00:00Z') + Math.floor(rand() * 400 * 24 * HOUR));
    for (const j of rules.DAILY_JOBS) {
      const expected = slots.latestDueSlot(j.hhmm, new Date(now.getTime() - 15 * MIN)).slotKey;
      assert.strictEqual(rules.slotsToJudge(j.hhmm, now).current, expected, `${j.name} @ ${now.toISOString()}`);
    }
  }
  assert.deepStrictEqual(rules.slotsToJudge('02:30', T('2026-10-22T02:44:59')), { current: '2026-10-21T02:30', previous: '2026-10-20T02:30' });
  assert.deepStrictEqual(rules.slotsToJudge('02:30', T('2026-10-22T02:45:00')), { current: '2026-10-22T02:30', previous: '2026-10-21T02:30' });
  assert.deepStrictEqual(rules.slotsToJudge('00:10', T('2026-10-01T00:30:00')), { current: '2026-10-01T00:10', previous: '2026-09-30T00:10' });
});

// ── 每日排程燈號 ───────────────────────────────────────────────────────
const NOW = T('2026-10-22T10:00:00');
const pull = job('ragic_pull');
const ok = run('success', { started: T('2026-10-22T02:30:01'), finished: T('2026-10-22T02:31:25'), result: { synced: 681, error: null, retry: false } });
const okYesterday = run('success', { started: T('2026-10-21T02:30:01'), finished: T('2026-10-21T02:31:25'), result: { synced: 680 } });
const sig = (current, previous, extra = {}) => ({ current, previous, lastSuccessAt: T('2026-10-22T02:31:25'), lastFailureAt: null, ...extra });

check('每日排程：這一輪成功 → 綠，並帶最後成功時間', () => {
  const r = rules.evaluateDailyJob(pull, sig(ok, okYesterday), ctx(NOW));
  assert.strictEqual(r.level, 'green', r.reason);
  assert.strictEqual(r.lastSuccessAt, '2026-10-21T18:31:25.000Z');
});

check('每日排程：成功但回報錯誤 → 黃；子項 err(...) → 黃', () => {
  const withError = run('success', { finished: T('2026-10-22T02:31:00'), result: { synced: 0, error: 'Ragic 逾時' } });
  assert.strictEqual(rules.evaluateDailyJob(pull, sig(withError, okYesterday), ctx(NOW)).level, 'yellow');
  const staff = job('ragic_staff_venues');
  const part = run('success', { finished: T('2026-10-22T03:32:00'), result: { staff: 'err(timeout)', venues: 'ok(0)', retry: false } });
  assert.strictEqual(rules.evaluateDailyJob(staff, sig(part, okYesterday), ctx(NOW)).level, 'yellow');
  const fine = run('success', { finished: T('2026-10-22T03:32:00'), result: { staff: 'ok(436)', venues: 'ok(0)', retry: false } });
  assert.strictEqual(rules.evaluateDailyJob(staff, sig(fine, okYesterday), ctx(NOW)).level, 'green');
});

check('每日排程：拋錯 → 紅；拿不到 Ragic 鎖（retry）→ 黃', () => {
  assert.strictEqual(rules.evaluateDailyJob(pull, sig(run('error', { error: 'boom' }), okYesterday), ctx(NOW)).level, 'red');
  assert.strictEqual(rules.evaluateDailyJob(pull, sig(run('retry'), okYesterday), ctx(NOW)).level, 'yellow');
});

check('每日排程：執行中 119 分鐘 → 綠，121 分鐘 → 紅（卡住）', () => {
  const r119 = rules.evaluateDailyJob(pull, sig(run('running', { started: new Date(NOW.getTime() - 119 * MIN) }), okYesterday), ctx(NOW));
  const r121 = rules.evaluateDailyJob(pull, sig(run('running', { started: new Date(NOW.getTime() - 121 * MIN) }), okYesterday), ctx(NOW));
  assert.strictEqual(r119.level, 'green', r119.reason);
  assert.strictEqual(r121.level, 'red', r121.reason);
});

check('每日排程：這一輪沒跑但上一輪成功 → 黃（休眠，醒來會補）；連兩輪沒成功 → 紅', () => {
  const missed = rules.evaluateDailyJob(pull, sig(null, okYesterday), ctx(NOW));
  assert.strictEqual(missed.level, 'yellow', missed.reason);
  assert.ok(/補跑/.test(missed.reason), missed.reason);
  assert.strictEqual(rules.evaluateDailyJob(pull, sig(null, null), ctx(NOW)).level, 'red');
  assert.strictEqual(rules.evaluateDailyJob(pull, sig(null, run('error', { error: 'x' })), ctx(NOW)).level, 'red');
  assert.strictEqual(rules.evaluateDailyJob(pull, sig(null, run('retry')), ctx(NOW)).level, 'red');
});

check('每日排程：只補當天的推播排程過了 20:00 → 黃且說明不會補', () => {
  const expiry = job('expiry_reminder');
  const yesterday = run('success', { finished: T('2026-10-21T09:00:03'), result: { candidates: 3 } });
  const noon = rules.evaluateDailyJob(expiry, sig(null, yesterday), ctx(T('2026-10-22T12:00:00')));
  const night = rules.evaluateDailyJob(expiry, sig(null, yesterday), ctx(T('2026-10-22T20:01:00')));
  assert.strictEqual(noon.level, 'yellow');
  assert.ok(!/不會補/.test(noon.reason), noon.reason);
  assert.strictEqual(night.level, 'yellow');
  assert.ok(/不會補/.test(night.reason), night.reason);
});

check('每日排程：沒有任何紀錄或只有上線起點（seeded）→ 黃「無法觀測」；不跑排程的環境 → 黃', () => {
  const none = rules.evaluateDailyJob(pull, { current: null, previous: null, lastSuccessAt: null, lastFailureAt: null }, ctx(NOW));
  const seeded = rules.evaluateDailyJob(pull, { current: run('seeded'), previous: null, lastSuccessAt: null, lastFailureAt: null }, ctx(NOW));
  const safe = rules.evaluateDailyJob(pull, sig(ok, okYesterday), ctx(NOW, { schedulerActive: false }));
  for (const r of [none, seeded, safe]) {
    assert.strictEqual(r.level, 'yellow', r.reason);
    assert.ok(/無法觀測/.test(r.reason), r.reason);
  }
});

check('家長學員寫回 Ragic：只有 7 天前就有的永久拒收 → 綠；新的、暫時性、整批失敗才改燈號', () => {
  const backup = job('ragic_backup');
  const row = run('success', { finished: T('2026-10-22T00:30:38'), result: { synced: 7, error: '66 筆同步失敗', retry: false } });
  const with_ = (failures) => rules.evaluateDailyJob(backup, sig(row, okYesterday, { failures }), ctx(NOW));
  assert.strictEqual(with_({ failedIds: 66, newIds: 0, notPermanent: 0 }).level, 'green');
  assert.strictEqual(with_({ failedIds: 66, newIds: 1, notPermanent: 0 }).level, 'yellow');
  assert.strictEqual(with_({ failedIds: 66, newIds: 0, notPermanent: 2 }).level, 'yellow');
  assert.strictEqual(with_({ failedIds: 0, newIds: 0, notPermanent: 0 }).level, 'red');
  assert.strictEqual(with_({ readError: 'timeout' }).level, 'yellow');
  const clean = run('success', { finished: T('2026-10-22T00:30:38'), result: { synced: 7, error: null } });
  assert.strictEqual(rules.evaluateDailyJob(backup, sig(clean, okYesterday), ctx(NOW)).level, 'green');
});

// ── 其他管線 ───────────────────────────────────────────────────────────
check('資料庫：499 ms 綠、500 ms 黃、1999 ms 黃、2000 ms 紅、連不上紅', () => {
  assert.strictEqual(rules.evaluateDatabase({ latencyMs: 499 }).level, 'green');
  assert.strictEqual(rules.evaluateDatabase({ latencyMs: 500 }).level, 'yellow');
  assert.strictEqual(rules.evaluateDatabase({ latencyMs: 1999 }).level, 'yellow');
  assert.strictEqual(rules.evaluateDatabase({ latencyMs: 2000 }).level, 'red');
  assert.strictEqual(rules.evaluateDatabase({ readError: 'ECONNREFUSED' }).level, 'red');
});

check('Ragic 寫回佇列：卡住待櫃檯 → 黃；上次批次前就該處理 → 黃；跨兩次批次 → 紅；只有今晚要處理的 → 綠', () => {
  const o = (state, at) => ({ state, next_retry_at: T(at) });
  const ev = (open) => rules.evaluateRagicOutbox({ open, lastSyncedAt: T('2026-10-22T00:10:07') }, ctx(NOW));
  assert.strictEqual(ev([]).level, 'green');
  const tonight = ev([o('pending', '2026-10-22T09:00:00')]);
  assert.strictEqual(tonight.level, 'green', tonight.reason);
  assert.ok(/1 筆等下次/.test(tonight.reason), tonight.reason);
  assert.strictEqual(ev([o('blocked_data_conflict', '2026-07-15T00:00:00'), o('blocked_schema', '2026-07-14T00:00:00')]).level, 'yellow');
  assert.strictEqual(ev([o('pending', '2026-10-21T23:00:00')]).level, 'yellow');
  assert.strictEqual(ev([o('pending', '2026-10-21T00:10:01')]).level, 'yellow');
  assert.strictEqual(ev([o('pending', '2026-10-21T00:09:59')]).level, 'red');
  assert.strictEqual(ev([o('retryable', '2026-10-23T00:10:00')]).level, 'yellow');
});

check('Ragic 即時通知：正式站沒設 secret → 紅；24 小時 3 次全被拒 → 紅、2 次不紅', () => {
  const base = { secretConfigured: true, attempts24h: { ok: 10 }, lastAttemptAt: T('2026-10-22T09:00:00'), open: [], lastCompletedAt: T('2026-10-22T09:00:01') };
  assert.strictEqual(rules.evaluateRagicWebhook(base, ctx(NOW)).level, 'green');
  assert.strictEqual(rules.evaluateRagicWebhook({ ...base, secretConfigured: false }, ctx(NOW)).level, 'red');
  assert.strictEqual(rules.evaluateRagicWebhook({ ...base, secretConfigured: false }, ctx(NOW, { isProduction: false })).level, 'green');
  assert.strictEqual(rules.evaluateRagicWebhook({ ...base, attempts24h: { unauthorized: 3 } }, ctx(NOW)).level, 'red');
  assert.notStrictEqual(rules.evaluateRagicWebhook({ ...base, attempts24h: { unauthorized: 2 } }, ctx(NOW)).level, 'red');
  assert.strictEqual(rules.evaluateRagicWebhook({ ...base, attempts24h: { ok: 10, unavailable: 1 } }, ctx(NOW)).level, 'yellow');
});

check('Ragic 即時通知：到期未處理超過 15 分鐘（以程序啟動時間起算）→ 紅；剛啟動 → 黃；重試用盡 → 黃；7 天沒收到 → 黃', () => {
  const base = { secretConfigured: true, attempts24h: { ok: 10 }, lastAttemptAt: T('2026-10-22T09:00:00'), lastCompletedAt: null };
  const due = { open: [{ state: 'retryable', next_retry_at: T('2026-10-22T06:00:00') }] };
  assert.strictEqual(rules.evaluateRagicWebhook({ ...base, ...due }, ctx(NOW)).level, 'red');
  assert.strictEqual(rules.evaluateRagicWebhook({ ...base, ...due }, ctx(NOW, { processStartedAt: new Date(NOW.getTime() - 14 * MIN) })).level, 'yellow');
  assert.strictEqual(rules.evaluateRagicWebhook({ ...base, ...due }, ctx(NOW, { processStartedAt: new Date(NOW.getTime() - 16 * MIN) })).level, 'red');
  assert.strictEqual(rules.evaluateRagicWebhook({ ...base, open: [{ state: 'blocked', next_retry_at: T('2026-10-20T00:00:00') }] }, ctx(NOW)).level, 'yellow');
  const quiet = rules.evaluateRagicWebhook({ ...base, open: [], attempts24h: {}, lastAttemptAt: T('2026-10-14T09:00:00') }, ctx(NOW));
  assert.strictEqual(quiet.level, 'yellow');
  assert.ok(/無法觀測/.test(quiet.reason), quiet.reason);
});

check('Z01 欄位驗證：通過 → 綠；最近失敗但 26 小時內通過過 → 黃；超過 26 小時沒通過 → 紅；沒紀錄或太舊 → 黃；沒設定 → 綠', () => {
  const ev = (s) => rules.evaluateZ01Schema(s, ctx(NOW)).level;
  const latest = (verified, at) => ({ fetched_at: T(at), verified, failure_code: verified ? null : 'FIELD_MISSING' });
  assert.strictEqual(ev({ configured: false }), 'green');
  assert.strictEqual(ev({ configured: true, latest: latest(true, '2026-10-22T09:55:00'), lastVerifiedAt: T('2026-10-22T09:55:00') }), 'green');
  assert.strictEqual(ev({ configured: true, latest: latest(false, '2026-10-22T09:55:00'), lastVerifiedAt: T('2026-10-21T08:01:00') }), 'yellow');
  assert.strictEqual(ev({ configured: true, latest: latest(false, '2026-10-22T09:55:00'), lastVerifiedAt: T('2026-10-21T07:59:00') }), 'red');
  assert.strictEqual(ev({ configured: true, latest: latest(false, '2026-10-22T09:55:00'), lastVerifiedAt: null }), 'red');
  assert.strictEqual(ev({ configured: true, latest: null, lastVerifiedAt: null }), 'yellow');
  assert.strictEqual(ev({ configured: true, latest: latest(true, '2026-10-21T07:00:00'), lastVerifiedAt: T('2026-10-21T07:00:00') }), 'yellow');
});

check('LINE 推播：關閉 → 綠；缺 token、額度用完 → 紅；失敗過半（≥5 則）→ 紅；133 則失敗 1 則 → 綠', () => {
  const base = { gate: { enabled: true, dryRun: false }, tokens: { staffChannel: true, monthlyQuotaBlockedUntil: null }, testUidSet: false,
    last24h: { sent: 132, failed: 1, quota: 0, noToken: 0, rateLimited: 0 }, lastSentAt: T('2026-10-22T09:00:00'), lastFailedAt: null };
  const ev = (patch) => rules.evaluateLinePush({ ...base, ...patch }).level;
  assert.strictEqual(ev({}), 'green');
  assert.strictEqual(ev({ gate: { enabled: false, dryRun: true } }), 'green');
  assert.strictEqual(ev({ tokens: { staffChannel: false } }), 'red');
  assert.strictEqual(ev({ tokens: { staffChannel: true, monthlyQuotaBlockedUntil: '2026-10-22T10:01:00Z' } }), 'red');
  assert.strictEqual(ev({ last24h: { ...base.last24h, quota: 1 } }), 'red');
  assert.strictEqual(ev({ last24h: { sent: 0, failed: 0, noToken: 2 } }), 'red');
  assert.strictEqual(ev({ last24h: { sent: 3, failed: 3 } }), 'red');
  assert.strictEqual(ev({ last24h: { sent: 2, failed: 2 } }), 'green');
  assert.strictEqual(ev({ last24h: { sent: 27, failed: 3 } }), 'yellow');
  assert.strictEqual(ev({ last24h: { sent: 28, failed: 3 } }), 'green');
  assert.strictEqual(ev({ last24h: { ...base.last24h, rateLimited: 1 } }), 'yellow');
  assert.strictEqual(ev({ gate: { enabled: true, dryRun: true } }), 'yellow');
  assert.strictEqual(ev({ testUidSet: true }), 'yellow');
});

check('對帳通知信：沒設 SMTP → 紅；24 小時 3 封全失敗 → 紅；有失敗或卡在待寄 → 黃；正常 → 綠', () => {
  const base = { configured: true, dryRun: false, testRecipientSet: false, sweepEnabled: false, last24h: { sent: 4, failed: 0 }, stalePending: 0, lastSentAt: null, lastFailedAt: null };
  const ev = (patch) => rules.evaluateMail({ ...base, ...patch });
  assert.strictEqual(ev({}).level, 'green');
  assert.strictEqual(ev({ configured: false }).level, 'red');
  assert.strictEqual(ev({ last24h: { sent: 0, failed: 3 } }).level, 'red');
  assert.strictEqual(ev({ last24h: { sent: 0, failed: 2 } }).level, 'yellow');
  assert.strictEqual(ev({ last24h: { sent: 1, failed: 3 } }).level, 'yellow');
  const stale = ev({ stalePending: 2 });
  assert.strictEqual(stale.level, 'yellow');
  assert.ok(/RECONCILE_MAIL_SWEEP/.test(stale.reason), stale.reason);
  assert.strictEqual(ev({ dryRun: true }).level, 'yellow');
});

check('課程需求排程：到期 15 分鐘內 → 黃、超過 → 紅（從程序啟動與到期時間較晚者起算）；沒有 → 綠', () => {
  const ev = (overdue, oldest, extra) => rules.evaluateCourseTypeSchedule({ overdue, oldestDueAt: oldest }, ctx(NOW, extra)).level;
  assert.strictEqual(ev(0, null), 'green');
  assert.strictEqual(ev(1, new Date(NOW.getTime() - 14 * MIN)), 'yellow');
  assert.strictEqual(ev(1, new Date(NOW.getTime() - 16 * MIN)), 'red');
  assert.strictEqual(ev(1, new Date(NOW.getTime() - 5 * HOUR), { processStartedAt: new Date(NOW.getTime() - 10 * MIN) }), 'yellow');
  assert.strictEqual(ev(1, new Date(NOW.getTime() - 5 * HOUR), { schedulerActive: false }), 'yellow');
});

check('聊天室補建：缺聊天室且程序已跑超過 15 分鐘 → 黃；剛啟動或沒缺 → 綠', () => {
  assert.strictEqual(rules.evaluateChatRooms({ missing: 0 }, ctx(NOW)).level, 'green');
  assert.strictEqual(rules.evaluateChatRooms({ missing: 2 }, ctx(NOW)).level, 'yellow');
  assert.strictEqual(rules.evaluateChatRooms({ missing: 2 }, ctx(NOW, { processStartedAt: new Date(NOW.getTime() - 5 * MIN) })).level, 'green');
});

check('上傳檔案儲存：bucket 綠、資料庫備援黃、本機磁碟黃', () => {
  assert.strictEqual(rules.evaluateStorage({ driver: 'replit' }).level, 'green');
  assert.strictEqual(rules.evaluateStorage({ driver: 'db' }).level, 'yellow');
  assert.strictEqual(rules.evaluateStorage({ driver: 'local' }).level, 'yellow');
});

// ── 整份報告 ───────────────────────────────────────────────────────────
function healthySignals(now) {
  const daily = {};
  for (const j of rules.DAILY_JOBS) {
    const keys = rules.slotsToJudge(j.hhmm, now);
    const t = new Date(`${keys.current}:00+08:00`);
    daily[j.name] = {
      current: run('success', { started: t, finished: new Date(t.getTime() + MIN), result: { synced: 1 } }),
      previous: run('success', { started: new Date(t.getTime() - 24 * HOUR), finished: new Date(t.getTime() - 24 * HOUR + MIN), result: {} }),
      lastSuccessAt: new Date(t.getTime() + MIN),
      lastFailureAt: null,
    };
  }
  return {
    now,
    build: 'abc1234',
    processStartedAt: new Date(now.getTime() - 3 * HOUR),
    schedulerActive: true,
    isProduction: true,
    database: { latencyMs: 12 },
    dailyJobs: daily,
    ragicOutbox: { open: [], lastSyncedAt: T('2026-10-22T00:10:07') },
    ragicWebhook: { secretConfigured: true, attempts24h: { ok: 3 }, lastAttemptAt: T('2026-10-22T09:00:00'), open: [], lastCompletedAt: T('2026-10-22T09:00:01') },
    z01Schema: { configured: true, latest: { fetched_at: T('2026-10-22T09:55:00'), verified: true }, lastVerifiedAt: T('2026-10-22T09:55:00') },
    linePush: { gate: { enabled: true, dryRun: false }, tokens: { staffChannel: true }, testUidSet: false, last24h: { sent: 20, failed: 0 }, lastSentAt: T('2026-10-22T09:00:00'), lastFailedAt: null },
    mail: { configured: true, dryRun: false, testRecipientSet: false, sweepEnabled: false, last24h: { sent: 3, failed: 0 }, stalePending: 0, lastSentAt: T('2026-10-22T08:00:00'), lastFailedAt: null },
    courseTypeSchedule: { overdue: 0, oldestDueAt: null },
    chatRooms: { missing: 0 },
    storage: { driver: 'replit' },
  };
}

check('整份報告：全部正常 → 符合 health-v1、system=daos-tutoring、overall 綠、id 不重複', () => {
  const report = rules.assembleReport(healthySignals(NOW));
  assert.deepStrictEqual(contractProblems(report), []);
  assert.strictEqual(report.system, 'daos-tutoring');
  assert.strictEqual(report.overall, 'green', JSON.stringify(report.pipelines.filter((p) => p.level !== 'green')));
  assert.strictEqual(report.pipelines.length, 9 + rules.DAILY_JOBS.length);
  assert.strictEqual(report.checkedAt, NOW.toISOString());
});

check('整份報告：一個訊號讀不到只讓那一條變紅，overall 跟著變紅，其他不受影響', () => {
  const s = healthySignals(NOW);
  s.mail = { readError: 'relation "mail_outbox" does not exist' };
  const report = rules.assembleReport(s);
  assert.deepStrictEqual(contractProblems(report), []);
  assert.strictEqual(report.overall, 'red');
  const red = report.pipelines.filter((p) => p.level === 'red').map((p) => p.id);
  assert.deepStrictEqual(red, ['mail.reconcile']);
  assert.ok(/讀取狀態失敗/.test(report.pipelines.find((p) => p.id === 'mail.reconcile').reason));
});

check('整份報告：每日排程整批讀不到 → 每一支都紅；缺一支訊號 → 那一支黃「無法觀測」', () => {
  const s = healthySignals(NOW);
  s.dailyJobs = { readError: 'timeout' };
  const all = rules.assembleReport(s).pipelines.filter((p) => p.id.startsWith('job.'));
  assert.strictEqual(all.length, rules.DAILY_JOBS.length);
  assert.ok(all.every((p) => p.level === 'red'));
  const s2 = healthySignals(NOW);
  delete s2.dailyJobs.ragic_pull;
  const p = rules.assembleReport(s2).pipelines.find((x) => x.id === 'job.ragic_pull');
  assert.strictEqual(p.level, 'yellow');
  assert.ok(/無法觀測/.test(p.reason));
});

if (failures) { console.error('\nhealth_rules_test: ' + failures + ' FAILED'); }
else console.log('\nhealth_rules_test: ALL PASS');
process.exitCode = failures ? 1 : 0;
