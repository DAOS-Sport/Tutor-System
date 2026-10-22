'use strict';
/**
 * 收集 health-v1 報告要的訊號，交給 services/healthRules.js 判燈號。
 * 只讀：查既有的紀錄表與環境變數，不寫任何東西、不打 Ragic／LINE／SMTP。
 * 每個訊號各自設時限；讀不到只讓那一條管線變紅，不讓整份報告失敗。
 */
const path = require('path');
const { pool } = require('../models/db');
const slots = require('../cron/slots');
const rules = require('./healthRules');

const READ_TIMEOUT_MS = 5000;
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000);

const BUILD = (() => {
  try { return require('../build-info.json').sha || 'unknown'; } catch { /* 尚未 build */ }
  try {
    return require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'unknown';
  } catch { return 'unknown'; }
})();

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超過 ${ms / 1000} 秒沒有回應`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function attempt(read) {
  try {
    return await withTimeout(Promise.resolve().then(read), READ_TIMEOUT_MS);
  } catch (err) {
    return { readError: String(err?.message || err).slice(0, 200) };
  }
}

async function readDatabase(db) {
  const t0 = Date.now();
  await db.query('SELECT 1');
  return { latencyMs: Date.now() - t0 };
}

async function readBackupFailures(db, row) {
  const r = await db.query(
    `WITH cur AS (
       SELECT DISTINCT local_id, error_kind FROM ragic_sync_failures
        WHERE job_name = 'backup' AND occurred_at >= $1 AND occurred_at <= $2
     )
     SELECT COUNT(DISTINCT local_id)::int AS failed_ids,
            COUNT(DISTINCT local_id) FILTER (WHERE error_kind <> 'permanent')::int AS not_permanent,
            COUNT(DISTINCT local_id) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM ragic_sync_failures p
               WHERE p.job_name = 'backup' AND p.local_id = cur.local_id
                 AND p.occurred_at < $1 AND p.occurred_at >= $1::timestamptz - INTERVAL '7 days'
            ))::int AS new_ids
       FROM cur`,
    [row.started_at, row.finished_at || new Date()]
  );
  const x = r.rows[0];
  return { failedIds: x.failed_ids, notPermanent: x.not_permanent, newIds: x.new_ids };
}

async function readDailyJobs(db, now) {
  const wanted = rules.DAILY_JOBS.map((job) => ({ job, keys: rules.slotsToJudge(job.hhmm, now) }));
  const ids = wanted.flatMap(({ job, keys }) => [slots.slotRunId(job.name, keys.current), slots.slotRunId(job.name, keys.previous)]);
  const names = rules.DAILY_JOBS.map((job) => slots.JOB_PREFIX + job.name);
  const [rows, agg] = await Promise.all([
    db.query(
      `SELECT id, status, started_at, finished_at, error_message, result_summary
         FROM job_runs WHERE id = ANY($1::uuid[])`, [ids]),
    db.query(
      `SELECT job_name,
              MAX(finished_at) FILTER (WHERE status = 'success') AS last_success,
              MAX(finished_at) FILTER (WHERE status = 'error') AS last_failure
         FROM job_runs WHERE job_name = ANY($1::text[]) GROUP BY job_name`, [names]),
  ]);
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  const byName = new Map(agg.rows.map((r) => [r.job_name, r]));
  const out = {};
  for (const { job, keys } of wanted) {
    const a = byName.get(slots.JOB_PREFIX + job.name) || {};
    out[job.name] = {
      current: byId.get(slots.slotRunId(job.name, keys.current)) || null,
      previous: byId.get(slots.slotRunId(job.name, keys.previous)) || null,
      lastSuccessAt: a.last_success || null,
      lastFailureAt: a.last_failure || null,
    };
  }
  const backup = out.ragic_backup.current;
  if (backup && backup.status === 'success' && backup.result_summary?.result?.error) {
    out.ragic_backup.failures = await attempt(() => readBackupFailures(db, backup));
  }
  return out;
}

async function readRagicOutbox(db) {
  const [open, last] = await Promise.all([
    db.query(
      `SELECT state, next_retry_at FROM ragic_sync_outbox
        WHERE state <> 'synced' ORDER BY next_retry_at LIMIT 2000`),
    db.query(`SELECT MAX(completed_at) AS at FROM ragic_sync_outbox WHERE state = 'synced'`),
  ]);
  return { open: open.rows, lastSyncedAt: last.rows[0]?.at || null };
}

async function readRagicWebhook(db, now) {
  const [attempts, open, last] = await Promise.all([
    db.query(
      `SELECT outcome, COUNT(*) FILTER (WHERE received_at > $2)::int AS n24, MAX(received_at) AS last
         FROM ragic_webhook_attempts WHERE received_at > $1 GROUP BY outcome`,
      [new Date(now.getTime() - 7 * 24 * 3600e3), new Date(now.getTime() - 24 * 3600e3)]),
    db.query(
      `SELECT state, next_retry_at FROM ragic_webhook_inbox
        WHERE state <> 'completed' ORDER BY next_retry_at LIMIT 2000`),
    db.query(`SELECT MAX(completed_at) AS at FROM ragic_webhook_inbox WHERE state = 'completed'`),
  ]);
  const attempts24h = {};
  let lastAttemptAt = null;
  for (const r of attempts.rows) {
    attempts24h[r.outcome] = r.n24;
    if (!lastAttemptAt || r.last > lastAttemptAt) lastAttemptAt = r.last;
  }
  return {
    secretConfigured: Boolean(String(process.env.RAGIC_WEBHOOK_SECRET || '').trim()),
    attempts24h,
    lastAttemptAt,
    open: open.rows,
    lastCompletedAt: last.rows[0]?.at || null,
  };
}

async function readZ01Schema(db) {
  const { ragicEnabled } = require('./ragicAdmin');
  if (!ragicEnabled() || !process.env.RAGIC_FORM_Z01) return { configured: false };
  const [latest, verified] = await Promise.all([
    db.query(`SELECT fetched_at, verified, failure_code FROM ragic_z01_uid_schema_verifications ORDER BY fetched_at DESC LIMIT 1`),
    db.query(`SELECT fetched_at FROM ragic_z01_uid_schema_verifications WHERE verified ORDER BY fetched_at DESC LIMIT 1`),
  ]);
  return { configured: true, latest: latest.rows[0] || null, lastVerifiedAt: verified.rows[0]?.fetched_at || null };
}

async function readLinePush(db, now) {
  const pushGate = require('./pushGate');
  const line = require('./line');
  const [gate, counts, lastSent] = await Promise.all([
    pushGate.describe(db),
    db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
              COUNT(*) FILTER (WHERE status = 'failed' AND COALESCE(reason, '') <> 'MONTHLY_QUOTA_EXHAUSTED')::int AS failed,
              COUNT(*) FILTER (WHERE status = 'failed' AND reason = 'MONTHLY_QUOTA_EXHAUSTED')::int AS quota,
              COUNT(*) FILTER (WHERE status = 'skipped' AND reason LIKE 'NO\\_TOKEN%' ESCAPE '\\')::int AS no_token,
              COUNT(*) FILTER (WHERE status = 'skipped' AND (reason LIKE 'RATE\\_LIMIT%' ESCAPE '\\' OR reason LIKE 'RATE\\_CHECK\\_FAILED%' ESCAPE '\\'))::int AS rate_limited,
              MAX(at) FILTER (WHERE status = 'failed') AS last_failed
         FROM line_push_log WHERE at > $1`,
      [new Date(now.getTime() - 24 * 3600e3)]),
    db.query(`SELECT at FROM line_push_log WHERE status = 'sent' ORDER BY at DESC LIMIT 1`),
  ]);
  const c = counts.rows[0];
  return {
    gate,
    tokens: line.tokenSummary(),
    testUidSet: Boolean(String(process.env.LINE_PUSH_TEST_UID || '').trim()),
    last24h: { sent: c.sent, failed: c.failed, quota: c.quota, noToken: c.no_token, rateLimited: c.rate_limited },
    lastSentAt: lastSent.rows[0]?.at || null,
    lastFailedAt: c.last_failed || null,
  };
}

async function readMail(db, now) {
  const mailer = require('./mailer');
  const sweep = require('./reconcileMailSweep');
  const [counts, lastSent] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'sent' AND created_at > $1)::int AS sent,
              COUNT(*) FILTER (WHERE status = 'failed' AND created_at > $1)::int AS failed,
              COUNT(*) FILTER (WHERE status = 'pending' AND created_at < $2)::int AS stale_pending,
              MAX(updated_at) FILTER (WHERE status = 'failed') AS last_failed
         FROM mail_outbox WHERE created_at > $1 OR status = 'pending'`,
      [new Date(now.getTime() - 24 * 3600e3), new Date(now.getTime() - 30 * 60e3)]),
    db.query(`SELECT sent_at FROM mail_outbox WHERE status = 'sent' ORDER BY created_at DESC LIMIT 1`),
  ]);
  const c = counts.rows[0];
  const d = mailer.describe();
  return {
    configured: d.configured,
    dryRun: d.dryRun,
    testRecipientSet: d.testRecipientSet,
    sweepEnabled: sweep.isEnabled(),
    last24h: { sent: c.sent, failed: c.failed },
    stalePending: c.stale_pending,
    lastSentAt: lastSent.rows[0]?.sent_at || null,
    lastFailedAt: c.last_failed || null,
  };
}

async function readCourseTypeSchedule(db, now) {
  // zone-scan-exempt：刻意跨定價區數「到期未套用」的排程，只回筆數與時間，不回任何價格欄位。
  const r = await db.query(
    `SELECT COUNT(*)::int AS n, MIN(scheduled_effective_date) AS oldest
       FROM course_type_configs
      WHERE pending_changes IS NOT NULL AND scheduled_effective_date IS NOT NULL AND scheduled_effective_date <= $1`,
    [now]);
  return { overdue: r.rows[0].n, oldestDueAt: r.rows[0].oldest };
}

async function readChatRooms(db) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM course_periods cp
       LEFT JOIN chat_rooms cr ON cr.course_period_id = cp.id
      WHERE cp.status = 'active' AND cr.id IS NULL`);
  return { missing: r.rows[0].n };
}

async function collectSignals(now, { db = pool } = {}) {
  const [database, dailyJobs, ragicOutbox, ragicWebhook, z01Schema, linePush, mail, courseTypeSchedule, chatRooms] = await Promise.all([
    attempt(() => readDatabase(db)),
    attempt(() => readDailyJobs(db, now)),
    attempt(() => readRagicOutbox(db)),
    attempt(() => readRagicWebhook(db, now)),
    attempt(() => readZ01Schema(db)),
    attempt(() => readLinePush(db, now)),
    attempt(() => readMail(db, now)),
    attempt(() => readCourseTypeSchedule(db, now)),
    attempt(() => readChatRooms(db)),
  ]);
  return {
    now,
    build: BUILD,
    processStartedAt: PROCESS_STARTED_AT,
    schedulerActive: process.env.PREVIEW_SAFE_MODE !== '1',
    isProduction: process.env.NODE_ENV === 'production',
    database,
    dailyJobs,
    ragicOutbox,
    ragicWebhook,
    z01Schema,
    linePush,
    mail,
    courseTypeSchedule,
    chatRooms,
    storage: { driver: require('./objectStorage').driverName },
  };
}

async function buildHealthReport(now = new Date(), options) {
  return rules.assembleReport(await collectSignals(now, options));
}

module.exports = { collectSignals, buildHealthReport };
