'use strict';
/** drilldown-v1：只讀失敗證據；所有文字及連結均由固定對應產生。 */
const { DAILY_JOBS, INTERVAL_JOBS } = require('./healthRules');
const { safeCode, taipei } = require('./healthErrors');

const ADMIN_HOSTNAME = 'daos-tutoring-courses.replit.app';
const adminLink = (label, page) => ({ label, url: `https://${ADMIN_HOSTNAME}/admin/${page}` });
const LINKS = Object.freeze({
  'job.ragic_backup': [adminLink('Ragic 同步狀態', 'ragic-status')],
  'job.ragic_pull': [adminLink('Ragic 同步狀態', 'ragic-status')],
  'job.ragic_staff_venues': [adminLink('Ragic 同步狀態', 'ragic-status')],
  'ragic.webhook': [adminLink('Ragic 通知紀錄', 'ragic-status')],
  'line.push': [adminLink('推播安全閥設定', 'settings')],
  'mail.reconcile': [adminLink('對帳通知狀態', 'reconcile')],
  'course-type.schedule': [adminLink('課程需求排程', 'course-types')],
  'chat.rooms': [adminLink('課期聊天室查詢', 'chat-logs')],
});
const JOBS = [...DAILY_JOBS, ...INTERVAL_JOBS];
const SOURCES = [
  ...JOBS.map(({ name }) => ({
    pipeline: `job.${name}`, route: `job_runs/${name}`, summary: '排程執行失敗', code: () => 'JOB_FAILED',
    requestId: (row) => row.id,
    sql: `SELECT id, COALESCE(finished_at, started_at) AS at FROM job_runs
      WHERE status = 'error' AND job_name = ANY($3::text[])
        AND COALESCE(finished_at, started_at) >= $1 AND COALESCE(finished_at, started_at) <= $2
      ORDER BY COALESCE(finished_at, started_at) DESC, id DESC LIMIT 5`,
    names: [name, `slot:${name}`],
  })),
  {
    pipeline: 'job.ragic_backup', route: 'ragic_sync_failures', summary: 'Ragic 拒收',
    code: (row) => safeCode(row.error_code, 'RAGIC_BACKUP_FAILED'),
    sql: `SELECT occurred_at AS at, error_code FROM ragic_sync_failures
      WHERE job_name = 'backup' AND occurred_at >= $1 AND occurred_at <= $2
      ORDER BY occurred_at DESC, id DESC LIMIT 5`,
  },
  {
    pipeline: 'ragic.outbox', route: 'ragic_sync_outbox', summary: 'Ragic 寫回佇列失敗',
    code: (row) => safeCode(row.last_error_code, 'OUTBOX_BLOCKED'),
    sql: `SELECT updated_at AS at, last_error_code FROM ragic_sync_outbox
      WHERE (state LIKE 'blocked%' OR state IN ('retryable', 'failed'))
        AND updated_at >= $1 AND updated_at <= $2
      ORDER BY updated_at DESC, id DESC LIMIT 5`,
  },
  {
    pipeline: 'ragic.webhook', route: 'ragic_webhook_inbox', summary: 'Ragic 即時通知處理受阻',
    code: (row) => safeCode(row.last_error_code, 'WEBHOOK_BLOCKED'),
    sql: `SELECT updated_at AS at, last_error_code FROM ragic_webhook_inbox
      WHERE state = 'blocked' AND updated_at >= $1 AND updated_at <= $2
      ORDER BY updated_at DESC LIMIT 5`,
  },
  {
    pipeline: 'ragic.webhook', route: 'ragic_webhook_attempts', summary: 'Ragic 即時通知未成功',
    code: (row) => safeCode(row.status, 'WEBHOOK_FAILED'),
    sql: `SELECT received_at AS at, status FROM ragic_webhook_attempts
      WHERE (status < 200 OR status >= 300) AND received_at >= $1 AND received_at <= $2
      ORDER BY received_at DESC, id DESC LIMIT 5`,
  },
  {
    pipeline: 'line.push', route: 'line_push_log', summary: 'LINE 推播失敗',
    code: (row) => Number(row.http_status) >= 400 && Number(row.http_status) <= 599
      ? safeCode(row.http_status, 'PUSH_FAILED') : 'PUSH_FAILED',
    sql: `SELECT at, http_status FROM line_push_log
      WHERE status = 'failed' AND at >= $1 AND at <= $2
      ORDER BY at DESC, id DESC LIMIT 5`,
  },
  {
    pipeline: 'mail.reconcile', route: 'mail_outbox', summary: '對帳通知信寄送失敗', code: () => 'MAIL_FAILED',
    sql: `SELECT updated_at AS at FROM mail_outbox
      WHERE status = 'failed' AND updated_at >= $1 AND updated_at <= $2
      ORDER BY updated_at DESC, id DESC LIMIT 5`,
  },
];

async function collectEvidence(now, { db, withTimeout, timeoutMs }) {
  const since = new Date(now.getTime() - 7 * 86400000);
  const batches = await Promise.all(SOURCES.map(async (source) => {
    try {
      const values = source.names ? [since, now, source.names] : [since, now];
      const { rows } = await withTimeout(Promise.resolve().then(() => db.query({
        text: source.sql, values, query_timeout: timeoutMs,
      })), timeoutMs);
      const evidence = rows.map((row) => {
        const requestId = source.requestId?.(row);
        return { at: taipei(row.at), requestId: typeof requestId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(requestId) ? requestId : null,
          code: source.code(row), route: source.route, summary: source.summary };
      });
      return { pipeline: source.pipeline, evidence };
    } catch {
      return { pipeline: source.pipeline, failed: true };
    }
  }));
  const failed = new Set(batches.filter((batch) => batch.failed).map((batch) => batch.pipeline));
  const evidence = {};
  for (const batch of batches) {
    if (failed.has(batch.pipeline)) continue;
    evidence[batch.pipeline] = [...(evidence[batch.pipeline] || []), ...batch.evidence];
  }
  for (const id of Object.keys(evidence)) {
    evidence[id] = evidence[id].filter((e) => new Date(e.at) >= since && new Date(e.at) <= now)
      .sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5);
  }
  return evidence;
}

function addDrilldown(report, evidence) {
  return { ...report, pipelines: report.pipelines.map((pipeline) => {
    const items = evidence[pipeline.id];
    const links = LINKS[pipeline.id];
    return { ...pipeline,
      ...(items?.length ? { evidence: items } : {}),
      ...(links && (pipeline.level !== 'green' || items?.length) ? { links } : {}),
    };
  }) };
}

module.exports = { ADMIN_HOSTNAME, LINKS, collectEvidence, addDrilldown };
