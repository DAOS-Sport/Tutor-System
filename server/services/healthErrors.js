'use strict';
/**
 * errors-v1：記憶體 HTTP 錯誤環＋既有失敗表的唯讀彙整。
 * retainedSince 只代表記憶體部分的保留起點（程序啟動時間）；資料表來源不受重啟影響。
 */
const crypto = require('crypto');
const path = require('path');
const { SYSTEM_ID, DAILY_JOBS, ERROR_PIPELINES } = require('./healthRules');
const DAY_MS = 86400000;
const MAX_FINGERPRINTS = 200;
const RING_CAPACITY = 1000;
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000);
const BUILD = (() => {
  try { return require('../build-info.json').sha || 'unknown'; } catch { /* 尚未 build */ }
  try {
    return require('child_process').execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || 'unknown';
  } catch { return 'unknown'; }
})();
const envName = () => process.env.NODE_ENV === 'production' ? 'production' : 'development';
const taipei = (v) => new Date(new Date(v).getTime() + 8 * 3600000).toISOString().replace('Z', '+08:00');
const fingerprint = (source, route, code) => crypto.createHash('sha1')
  .update([source, route, code].join('\n')).digest('hex').slice(0, 12);

function parseSince(value, now) {
  if (value === undefined) return new Date(now.getTime() - DAY_MS);
  // Date.parse 會接受無時區與 2/30 的進位，先確認 RFC 3339 的日曆與時區。
  const m = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i);
  if (!m) throw new Error('INVALID_HEALTH_SINCE');
  const [, year, month, day, hour, minute, second, zone] = m;
  const y = Number(year), mo = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const validZone = /^Z$/i.test(zone) || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59);
  const at = Date.parse(value);
  if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || Number(hour) > 23 || Number(minute) > 59
    || Number(second) > 59 || !validZone || !Number.isFinite(at)) throw new Error('INVALID_HEALTH_SINCE');
  return new Date(Math.max(at, now.getTime() - 7 * DAY_MS));
}

function normalizePath(input) {
  return String(input || '/').split('/').map((segment) => {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return ':id'; }
    if (/^\d+$/.test(decoded) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)
      || /^U[0-9a-f]{32}$/i.test(decoded) || /@|[^\x20-\x7e]|\d{8,}/.test(decoded)) return ':id';
    return segment;
  }).join('/');
}

function requestRoute(req) {
  const template = req.route?.path;
  const original = String(req.originalUrl || req.path || '/').split(/[?#]/, 1)[0];
  let route = original;
  if (typeof template === 'string') {
    let mount = req.baseUrl || '';
    // 錯誤離開 Router 後 Express 會清掉 baseUrl；用已匹配樣板的尾段還原掛載前綴。
    if (!mount && template === '/') {
      mount = original.replace(/\/+$/, '');
    } else if (!mount && !/[?*()]/.test(template)) {
      const actual = original.split('/').filter(Boolean);
      const parts = template.split('/').filter(Boolean);
      const tail = actual.slice(-parts.length);
      if (parts.length && actual.length >= parts.length
        && parts.every((part, i) => part.startsWith(':') || part === tail[i])) {
        mount = actual.length > parts.length ? '/' + actual.slice(0, -parts.length).join('/') : '';
      }
    }
    route = `${mount}${template}`;
  }
  return `${req.method} ${normalizePath(route)}`;
}

function createErrorRing({ capacity = RING_CAPACITY, startedAt = PROCESS_STARTED_AT, build = BUILD } = {}) {
  const events = [];
  const captured = new WeakMap();
  let droppedThrough = null;
  const retainedSince = new Date(startedAt);
  return {
    retainedSince,
    // 不信任外來 X-Request-Id；自行產生識別碼，不收 body、query 或 header 值。
    middleware(req, res, next) {
      const requestId = crypto.randomUUID();
      res.once('finish', () => {
        if (res.statusCode < 500) return;
        const code = String(res.statusCode);
        const kind = captured.get(res);
        const ts = new Date();
        events.push({ source: 'http', route: requestRoute(req), code, level: 'error',
          message: `程式回應 HTTP ${code}${kind ? `（${kind}）` : ''}`,
          request_id: requestId, count: 1, first_seen: ts, last_seen: ts, release: build, env: envName() });
        if (events.length > capacity) droppedThrough = events.shift().last_seen;
      });
      next();
    },
    captureError(err, req, res) {
      const kind = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'AggregateError']
        .includes(err?.name) ? err.name : 'Error';
      captured.set(res, kind);
    },
    read(since, now = new Date()) {
      return events.filter((e) => e.last_seen >= since && e.last_seen <= now).map((e) => ({ ...e }));
    },
    truncated(since) { return droppedThrough !== null && droppedThrough >= since; },
  };
}
const errorRing = createErrorRing();

// 只取固定代碼與時間，不選收件人、姓名、記錄 ID、payload 或原始錯誤訊息。
// 先在 DB 彙整，避免把 7 天內的每一筆失敗載入程序；最後才合併並截 fingerprint。
const SOURCES = [
  { name: 'job_runs', sql: `SELECT job_name, COUNT(*)::int AS count,
      MIN(COALESCE(finished_at, started_at)) AS first_seen, MAX(COALESCE(finished_at, started_at)) AS last_seen
    FROM job_runs WHERE status = 'error' AND COALESCE(finished_at, started_at) >= $1
      AND COALESCE(finished_at, started_at) <= $2 GROUP BY job_name` },
  { name: 'line_push_log', sql: `SELECT http_status, COUNT(*)::int AS count, MIN(at) AS first_seen, MAX(at) AS last_seen
    FROM line_push_log WHERE status = 'failed' AND at >= $1 AND at <= $2 GROUP BY http_status` },
  { name: 'ragic_sync_failures', sql: `SELECT error_code, error_kind, COUNT(*)::int AS count,
      MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen
    FROM ragic_sync_failures WHERE occurred_at >= $1 AND occurred_at <= $2 GROUP BY error_code, error_kind` },
  { name: 'mail_outbox', sql: `SELECT COUNT(*)::int AS count, MIN(updated_at) AS first_seen, MAX(updated_at) AS last_seen
    FROM mail_outbox WHERE status = 'failed' AND updated_at >= $1 AND updated_at <= $2 HAVING COUNT(*) > 0` },
  { name: 'ragic_webhook_inbox', sql: `SELECT last_error_code, COUNT(*)::int AS count,
      MIN(updated_at) AS first_seen, MAX(updated_at) AS last_seen
    FROM ragic_webhook_inbox WHERE state = 'blocked' AND updated_at >= $1 AND updated_at <= $2 GROUP BY last_error_code` },
  { name: 'ragic_sync_outbox', sql: `SELECT state, last_error_code, COUNT(*)::int AS count,
      MIN(updated_at) AS first_seen, MAX(updated_at) AS last_seen
    FROM ragic_sync_outbox WHERE (state LIKE 'blocked%' OR state IN ('retryable', 'failed'))
      AND updated_at >= $1 AND updated_at <= $2 GROUP BY state, last_error_code` },
];
const JOB_NAMES = new Set(['ragic_sync', 'line_bot_webhook', 'yazheng_webhook',
  ...DAILY_JOBS.flatMap((job) => [job.name, `slot:${job.name}`])]);
function safeCode(value, fallback) {
  const s = String(value || '');
  // 不把自由文字、Email、UUID、LINE UID 或長數字偽裝成代碼輸出。
  return /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|E[A-Z]+|\d{3,5})$/.test(s)
    && s.length <= 80 && !/\d{8,}/.test(s) ? s : fallback;
}
function databaseEvent(source, row, build, env) {
  let code, level = 'error', route = source;
  switch (source) {
    case 'job_runs':
      code = 'JOB_FAILED';
      route += `/${JOB_NAMES.has(row.job_name) ? row.job_name : 'other'}`;
      break;
    case 'line_push_log': {
      const status = Number(row.http_status);
      code = status >= 400 && status <= 599 ? String(status) : 'PUSH_FAILED';
      if (status >= 400 && status < 500) level = 'warn';
      break;
    }
    case 'ragic_sync_failures':
      code = safeCode(row.error_code, ['permanent', 'transient', 'unknown'].includes(row.error_kind) ? row.error_kind : 'UNKNOWN_ERROR');
      if (row.error_kind === 'permanent' || code === 'RAGIC_VALIDATION_ERROR') level = 'warn';
      break;
    case 'mail_outbox': code = 'MAIL_FAILED'; break;
    case 'ragic_webhook_inbox': code = safeCode(row.last_error_code, 'WEBHOOK_BLOCKED'); break;
    case 'ragic_sync_outbox':
      code = safeCode(row.last_error_code, ['blocked_data_conflict', 'blocked_schema', 'blocked_retry_exhausted', 'retryable', 'failed'].includes(row.state) ? row.state : 'OUTBOX_BLOCKED');
      if (row.state === 'blocked_data_conflict' || row.state === 'blocked_schema') level = 'warn';
      break;
  }
  // job_runs 也採固定句，不帶原文，因此不會把原文中的姓名或其他個資帶出。
  return { source, route, code, level, message: `${source}：${code}`, request_id: null,
    count: Number(row.count), first_seen: new Date(row.first_seen), last_seen: new Date(row.last_seen), release: build, env };
}

async function buildErrorsReport(now = new Date(), since = parseSince(undefined, now), options = {}) {
  const { db = require('../models/db').pool, ring = errorRing, build = BUILD, env = envName() } = options;
  const batches = await Promise.all(SOURCES.map(async ({ name, sql }) => {
    // PG 的唯讀查詢限時，避免 errors 端點無限等待；不影響其他連線設定。
    const result = await db.query({ text: sql, values: [since, now], query_timeout: 5000 });
    return result.rows.map((row) => databaseEvent(name, row, build, env));
  }));
  const grouped = new Map();
  for (const event of [...batches.flat(), ...ring.read(since, now)]) {
    const key = fingerprint(event.source, event.route, event.code);
    const prev = grouped.get(key);
    if (!prev) { grouped.set(key, { ...event, fingerprint: key }); continue; }
    const latest = event.last_seen >= prev.last_seen ? event : prev;
    grouped.set(key, { ...latest, fingerprint: key,
      count: prev.count + event.count, first_seen: new Date(Math.min(prev.first_seen, event.first_seen)),
      last_seen: new Date(Math.max(prev.last_seen, event.last_seen)),
      level: prev.level === 'error' || event.level === 'error' ? 'error' : 'warn' });
  }
  const all = [...grouped.values()].sort((a, b) => b.last_seen - a.last_seen || a.fingerprint.localeCompare(b.fingerprint));
  return { system: SYSTEM_ID, build, checkedAt: taipei(now), since: taipei(since), retainedSince: taipei(ring.retainedSince),
    truncated: all.length > MAX_FINGERPRINTS || ring.truncated(since),
    errors: all.slice(0, MAX_FINGERPRINTS).map((event) => ({ system: SYSTEM_ID, env: event.env, ts: taipei(event.last_seen),
      level: event.level, code: event.code, message: event.message, request_id: event.request_id, route: event.route,
      fingerprint: event.fingerprint, count: event.count, first_seen: taipei(event.first_seen), last_seen: taipei(event.last_seen), release: event.release,
      pipeline: event.source === 'http' ? null : ERROR_PIPELINES[event.route] || null })) };
}

module.exports = { parseSince, createErrorRing, errorRing, buildErrorsReport, safeCode, taipei };
