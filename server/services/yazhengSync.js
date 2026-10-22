'use strict';
/**
 * 雅正轉同步（雅正轉同步 SPEC v1，YZ-A2／YZ-A3）。
 *
 * 雅正舊系統的課程包轉進新系統有兩條路：匯入工具（訂單 external_order_no='ABLEPOS:<單據序號>'、
 * notes 以「雅正轉」開頭）與櫃台手動建檔（凍結區，不改）。GPT 反查網站要知道哪些包已轉移，
 * 而且要能驗證，所以這裡提供兩樣東西：
 *   - listOrders：對帳 API 用，GPT 網站拉清單（真相來源）。
 *   - pushChanges／pushSnapshot：排程推送（Webhook）。兩條寫入路徑都不經過可以掛鉤的程式，
 *     所以用「有變動的訂單」輪詢推送；漏送由每晚全量快照補齊。
 *
 * 欄位白名單從 SQL 開始：不給姓名、完整電話，只給對帳要用的發票號碼、電話末 4 碼與堂數。
 */
const crypto = require('crypto');
const { pool } = require('../models/db');

const LEGACY_PREFIX = 'ABLEPOS:';
const YAZHENG_NOTE_PREFIX = '雅正轉';
const CHANGE_JOB = 'yazheng_webhook';
const CHANGE_OVERLAP_MS = 60 * 1000; // 交易提交時間晚於 updated_at 的列，靠重疊視窗補上；接收端去重
const CHANGE_BATCH = 200;
const CHANGE_MAX_BATCHES = 10;
const SNAPSHOT_PAGE = 500;
const PUSH_TIMEOUT_MS = 15 * 1000;

// changed_at＝GREATEST(created_at, updated_at)；匯入工具只填 created_at 的列也算得到。
const ORDER_COLUMNS = `
  ae.id::text AS enrollment_id,
  ae.external_order_no,
  CASE WHEN ae.external_order_no LIKE '${LEGACY_PREFIX}%'
       THEN substring(ae.external_order_no FROM ${LEGACY_PREFIX.length + 1}) END AS legacy_seq,
  COALESCE(ae.notes, '') LIKE '${YAZHENG_NOTE_PREFIX}%' AS yazheng_tag,
  NULLIF(upper(btrim(COALESCE(ae.invoice_number, ''))), '') AS invoice_number,
  NULLIF(right(regexp_replace(NORMALIZE(COALESCE(ae.parent_phone, ''), NFKC), '\\D', '', 'g'), 4), '') AS parent_phone_last4,
  ae.course_type,
  ae.total_sessions,
  ae.used_sessions,
  ae.status,
  ae.created_at,
  ae.updated_at,
  GREATEST(ae.created_at, COALESCE(ae.updated_at, ae.created_at)) AS changed_at`;

function toRecord(row) {
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  return {
    enrollment_id: row.enrollment_id,
    external_order_no: row.external_order_no || null,
    legacy_seq: row.legacy_seq || null,
    yazheng_tag: Boolean(row.yazheng_tag),
    invoice_number: row.invoice_number || null,
    parent_phone_last4: row.parent_phone_last4 || null,
    course_type: row.course_type == null ? null : Number(row.course_type),
    total_sessions: row.total_sessions == null ? null : Number(row.total_sessions),
    used_sessions: row.used_sessions == null ? null : Number(row.used_sessions),
    status: row.status || null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    changed_at: iso(row.changed_at),
  };
}

/** 分頁游標：changed_at 的 ISO 加訂單 id，用「|」接起來。 */
function encodeCursor(rec) {
  return Buffer.from(`${rec.changed_at}|${rec.enrollment_id}`).toString('base64url');
}
function decodeCursor(s) {
  if (!s) return null;
  const raw = Buffer.from(String(s), 'base64url').toString();
  const i = raw.indexOf('|');
  const at = raw.slice(0, i);
  if (i < 1 || Number.isNaN(Date.parse(at))) throw Object.assign(new Error('bad cursor'), { code: 'BAD_CURSOR' });
  return { at, id: raw.slice(i + 1) };
}

/** 依 (changed_at, id) 遞增分頁。since：只要 changed_at >= since 的；after：上一頁最後一筆之後。 */
async function listOrders({ since = null, after = null, limit = SNAPSHOT_PAGE, db = pool } = {}) {
  const n = Math.min(Math.max(Number(limit) || SNAPSHOT_PAGE, 1), 1000);
  const params = [];
  const where = [];
  if (since) {
    params.push(since);
    where.push(`GREATEST(ae.created_at, COALESCE(ae.updated_at, ae.created_at)) >= $${params.length}::timestamptz`);
  }
  if (after) {
    params.push(after.at, after.id);
    where.push(`(GREATEST(ae.created_at, COALESCE(ae.updated_at, ae.created_at)), ae.id::text)
                > ($${params.length - 1}::timestamptz, $${params.length}::text)`);
  }
  params.push(n + 1);
  const { rows } = await db.query(
    `SELECT ${ORDER_COLUMNS} FROM admin_enrollments ae
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY changed_at, enrollment_id
      LIMIT $${params.length}`, params);
  const page = rows.slice(0, n).map(toRecord);
  return { orders: page, next: rows.length > n ? encodeCursor(page[page.length - 1]) : null };
}

/** X-YZ-Signature：sha256=HMAC-SHA256(secret, "<timestamp>.<body>")，接收端用同一把 secret 驗。 */
function sign(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function webhookConfig(env = process.env) {
  const url = String(env.YZ_WEBHOOK_URL || '').trim();
  const secret = String(env.YZ_WEBHOOK_SECRET || '').trim();
  if (!/^https:\/\//.test(url) || secret.length < 32) return null;
  return { url, secret };
}

async function post(cfg, payload, fetchImpl = fetch) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YZ-Event-Id': payload.event_id,
        'X-YZ-Timestamp': ts,
        'X-YZ-Signature': sign(cfg.secret, ts, body),
      },
      body,
      signal: ctl.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`webhook HTTP ${res.status}`), { code: 'WEBHOOK_HTTP' });
  } finally {
    clearTimeout(timer);
  }
}

/** 上次成功推送到哪裡（存在 job_runs.result_summary，不另開表也不放後台設定）。 */
async function readChangeCursor(db = pool) {
  const { rows } = await db.query(
    `SELECT result_summary->>'cursor' AS cursor FROM job_runs
      WHERE job_name = $1 AND status = 'success' AND result_summary ? 'cursor'
      ORDER BY started_at DESC LIMIT 1`, [CHANGE_JOB]);
  return rows[0]?.cursor || null;
}

/**
 * 便宜的預檢：游標之後有沒有新變動。沒有就不必掛鎖、也不留執行紀錄（每 5 分鐘一次）。
 * 這裡刻意不加 CHANGE_OVERLAP_MS：重疊視窗裡一定有上一輪送過的最後一筆，加了就永遠是 true。
 * 交易晚提交、落在游標之前的列，由下一次真的推送的重疊視窗或每晚快照補上。
 */
async function hasChanges(db = pool) {
  const cursor = await readChangeCursor(db);
  const c = cursor ? decodeCursor(cursor) : null;
  const { rows } = c
    ? await db.query(
      `SELECT 1 FROM admin_enrollments ae
        WHERE (GREATEST(ae.created_at, COALESCE(ae.updated_at, ae.created_at)), ae.id::text) > ($1::timestamptz, $2::text)
        LIMIT 1`, [c.at, c.id])
    : await db.query('SELECT 1 FROM admin_enrollments LIMIT 1');
  return rows.length > 0;
}

/**
 * 推送有變動的訂單。對方回 2xx 才前進游標；失敗就丟錯（runWithLock 記成 error，游標不動，下一輪重送）。
 * 回傳值會被 runWithLock 存進 job_runs.result_summary，其中的 cursor 就是下一輪的起點。
 */
async function pushChanges({ db = pool, env = process.env, fetchImpl = fetch } = {}) {
  const cfg = webhookConfig(env);
  if (!cfg) return { skipped: 'not_configured' };
  const prev = await readChangeCursor(db);
  const since = prev ? new Date(new Date(decodeCursor(prev).at).getTime() - CHANGE_OVERLAP_MS).toISOString() : null;
  let after = null;
  let cursor = prev;
  let sent = 0;
  for (let i = 0; i < CHANGE_MAX_BATCHES; i += 1) {
    const { orders, next } = await listOrders({ since, after, limit: CHANGE_BATCH, db });
    if (!orders.length) break;
    await post(cfg, { type: 'changes', event_id: crypto.randomUUID(), generated_at: new Date().toISOString(), orders }, fetchImpl);
    sent += orders.length;
    cursor = encodeCursor(orders[orders.length - 1]);
    if (!next) break;
    after = decodeCursor(next);
  }
  return { sent, cursor };
}

/** 每晚全量快照：分頁送出，最後一頁 is_last=true；接收端收齊後做一次完整對帳。 */
async function pushSnapshot({ db = pool, env = process.env, fetchImpl = fetch } = {}) {
  const cfg = webhookConfig(env);
  if (!cfg) return { skipped: 'not_configured' };
  const snapshotId = crypto.randomUUID();
  let after = null;
  let page = 0;
  let total = 0;
  for (;;) {
    const { orders, next } = await listOrders({ after, limit: SNAPSHOT_PAGE, db });
    page += 1;
    total += orders.length;
    await post(cfg, {
      type: 'snapshot', event_id: crypto.randomUUID(), snapshot_id: snapshotId, page,
      is_last: !next, generated_at: new Date().toISOString(), orders,
    }, fetchImpl);
    if (!next) break;
    after = decodeCursor(next);
  }
  return { snapshot_id: snapshotId, pages: page, orders: total };
}

module.exports = {
  CHANGE_JOB, listOrders, toRecord, sign, webhookConfig, encodeCursor, decodeCursor,
  readChangeCursor, hasChanges, pushChanges, pushSnapshot,
};
