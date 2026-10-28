'use strict';
/**
 * LINE 小助理教練查課同步（LINE 小助理教練查課 SPEC v1.0／v1.1；做法比照雅正轉同步）。
 *
 * 家教系統是真相來源，小助理存一份副本、用副本回覆教練。這裡以「教練」為單位組好資料推過去：
 *   - pushChanges：每 5 分鐘推送有變動的教練（對方 2xx 才前進游標，游標存在 job_runs.result_summary）。
 *   - pushSnapshot：每晚全量快照（分頁、最後一頁附 total_coaches／total_rows），小助理收齊才整批換。
 *   - listCoaches：拉取 API 用（第一次匯入、手動對帳、驗收比筆數）。
 *
 * 數字一律跟教練端「報名狀態」同一套算法：直接共用 routes/sessions.js 的 COACH_ORDER_CTE 與期限函式（D8）。
 * 雅正舊課只推「教練姓名全平台唯一」對得到、還沒轉入、而且有學員姓名的包（BOT-05、C2）。
 *
 * 欄位白名單（BOT-09）：只有學員姓名、課程類型、館別、堂數、到期日。沒有家長姓名、電話、金額、發票、
 * 原始 LINE userId（只送 sha256 雜湊）。
 */
const crypto = require('crypto');
const { pool } = require('../models/db');
const { coachOrders } = require('../routes/sessions');
const { normCoach, builtMap } = require('./yazhengLegacy');

const { COACH_ORDER_CTE, COACH_ENROLLMENT_SCOPE, COACH_ENROLLMENT_STATUSES, courseExpiryAt } = coachOrders;

const CHANGE_JOB = 'line_bot_webhook';
const CHANGE_OVERLAP_MS = 60 * 1000;
const PAGE = 100;
const PUSH_TIMEOUT_MS = 15 * 1000;
const PUSH_BUCKETS = ['in_progress', 'pending_payment']; // 已上完的不推（BOT-04）

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => (v == null ? null : Number(v));

// ── 教練與 LINE 對照（BOT-03、C1、C3）──────────────────────────────────────────

/** 全部教練的身分資料（約兩百筆，每輪全讀，才判斷得了 LINE 是否被兩位教練共用）。 */
async function loadCoachIdentities(db) {
  const { rows } = await db.query(
    `SELECT c.id::text AS id, c.name, c.is_active, COALESCE(c.is_placeholder, FALSE) AS is_placeholder,
            s.id IS NOT NULL AS has_staff, COALESCE(s.active, FALSE) AS staff_active,
            NULLIF(btrim(COALESCE(c.line_uid, '')), '') AS coach_line,
            NULLIF(btrim(COALESCE(s.line_uid, '')), '') AS staff_line,
            GREATEST(c.created_at, c.updated_at, s.created_at, s.updated_at) AS identity_updated_at
       FROM coaches c
       LEFT JOIN admin_staff s ON s.id = c.ragic_employee_id`);
  const owners = new Map(); // hash → Set(coach_id)
  const byId = new Map();
  for (const r of rows) {
    // userId 原字串（去頭尾空白）算 sha256，小寫 16 進位、不加鹽、不截斷；小助理用 source.userId 算同一個值。
    const hashes = r.is_placeholder || !r.has_staff ? [] : [...new Set([r.coach_line, r.staff_line].filter(Boolean).map(sha256))];
    for (const h of hashes) owners.set(h, new Set([...(owners.get(h) || []), r.id]));
    byId.set(r.id, { ...r, hashes });
  }
  // C3：同一個 LINE 對到多位教練時，只有「一位可查、其餘停用」才把雜湊留給可查的那位（例如離職回任、
  // 舊檔停用但 LINE 還在）；兩位以上都可查就全部拿掉（安全側），小助理那邊會回「查不到」。
  const eligible = (c) => c.is_active && c.staff_active;
  let sharedHashes = 0;
  for (const [h, ids] of owners) {
    if (ids.size < 2) continue;
    const live = [...ids].filter((id) => eligible(byId.get(id)));
    const keep = live.length === 1 ? live[0] : null;
    if (!keep) sharedHashes += 1;
    for (const id of ids) if (id !== keep) byId.get(id).hashes = byId.get(id).hashes.filter((x) => x !== h);
  }
  // 雅正姓名對應：只在姓名全平台唯一時成立（BOT-05），兩邊都用 yazhengLegacy.normCoach。
  const nameCount = new Map();
  for (const r of rows) {
    const k = normCoach(r.name);
    if (k) nameCount.set(k, (nameCount.get(k) || 0) + 1);
  }
  const coachByLegacyName = new Map();
  for (const r of rows) {
    const k = normCoach(r.name);
    if (k && nameCount.get(k) === 1) coachByLegacyName.set(k, r.id);
  }
  return { byId, coachByLegacyName, sharedHashes };
}

/** 有綁 LINE（扣掉共用的）才出現在小助理；教練與員工檔都啟用才算「可查」。 */
function identityState(c) {
  if (!c || !c.hashes.length) return 'deleted';
  return c.is_active && c.staff_active ? 'active' : 'inactive';
}

// ── 課程資料（BOT-04、BOT-05）──────────────────────────────────────────────────

async function newSystemCourses(db, coachId) {
  const { rows } = await db.query(
    `${COACH_ORDER_CTE},
     names AS (
       SELECT s.batch_key, s.period_number, array_agg(DISTINCT btrim(st)) AS students
         FROM scoped s, unnest(s.students) AS st
        WHERE btrim(st) <> ''
        GROUP BY 1, 2
     )
     SELECT b.batch_key, b.period_number, b.bucket, b.course_type, v.name AS venue_name,
            b.total_sessions, b.used_sessions, b.invoice_issued_at,
            COALESCE(n.students, '{}') AS students
       FROM bucketed b
       LEFT JOIN admin_venues v ON v.id = b.venue_id
       LEFT JOIN names n ON n.batch_key = b.batch_key AND n.period_number = b.period_number
      WHERE b.bucket = ANY($2::text[])
      ORDER BY b.batch_key, b.period_number`,
    [coachId, PUSH_BUCKETS]
  );
  return rows.map((r) => {
    const total = num(r.total_sessions);
    const used = num(r.used_sessions) || 0;
    const expires = courseExpiryAt(r.invoice_issued_at);
    return {
      key: `${r.batch_key}:${r.period_number}`,
      status: r.bucket,
      students: [...r.students].sort(),
      course_type: num(r.course_type),
      venue_name: r.venue_name || null,
      total_sessions: total,
      used_sessions: used,
      remaining_sessions: total == null ? null : Math.max(0, total - used),
      course_expires_at: expires ? expires.toISOString() : null,
    };
  });
}

/** 還沒轉入、有學員姓名、剩餘大於 0 的舊包，依 normCoach 分到教練。 */
async function legacyByCoach(db, coachByLegacyName) {
  const { rows } = await db.query(
    `SELECT seq, coach, student_names, course_name, total_sessions, remaining_sessions, snapshot_at
       FROM yz_legacy_packages
      WHERE remaining_sessions > 0 AND cardinality(student_names) > 0
      ORDER BY seq`);
  const built = await builtMap(db, rows.map((r) => r.seq));
  const out = new Map();
  for (const r of rows) {
    if (built.has(r.seq)) continue;
    const coachId = coachByLegacyName.get(normCoach(r.coach));
    if (!coachId) continue;
    out.set(coachId, [...(out.get(coachId) || []), {
      seq: r.seq,
      students: [...r.student_names],
      course_name: r.course_name || null,
      total_sessions: num(r.total_sessions),
      remaining_sessions: num(r.remaining_sessions),
      snapshot_at: iso(r.snapshot_at),
    }]);
  }
  return out;
}

async function ordersUpdatedAt(db, coachId) {
  const { rows } = await db.query(
    `SELECT max(GREATEST(ae.created_at, COALESCE(ae.updated_at, ae.created_at))) AS at
       FROM admin_enrollments ae
      WHERE ${COACH_ENROLLMENT_SCOPE} AND ae.status::text IN ${COACH_ENROLLMENT_STATUSES}`,
    [coachId]);
  return rows[0]?.at || null;
}

/** 一位教練的推送資料（§4.1）。不可查的教練：停用給 active:false（雜湊保留、課程清空），其餘給刪除。 */
async function buildCoachRecord(db, ctx, coachId) {
  const c = ctx.byId.get(coachId);
  const state = identityState(c);
  if (state === 'deleted') return { coach_id: coachId, deleted: true };
  const base = { coach_id: coachId, line_uid_hashes: c.hashes, coach_name: c.name };
  if (state === 'inactive') {
    return { ...base, active: false, source_updated_at: iso(c.identity_updated_at), new_system: [], legacy: [] };
  }
  const [courses, ordersAt] = await Promise.all([newSystemCourses(db, coachId), ordersUpdatedAt(db, coachId)]);
  const legacy = ctx.legacy.get(coachId) || [];
  const stamps = [c.identity_updated_at, ordersAt, ...legacy.map((l) => l.snapshot_at)].filter(Boolean).map((v) => new Date(v).getTime());
  return {
    ...base,
    active: true,
    source_updated_at: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
    new_system: courses,
    legacy,
  };
}

async function loadContext(db) {
  const ids = await loadCoachIdentities(db);
  return { ...ids, legacy: await legacyByCoach(db, ids.coachByLegacyName) };
}

const rowCount = (rec) => (rec.deleted ? 0 : rec.new_system.length + rec.legacy.length);

// ── 誰有變動（BOT-11、C5）──────────────────────────────────────────────────────

/**
 * since 之後有變動的教練：範圍內訂單（含被取消的）、教練檔、員工檔、雅正連結與快照。
 * 訂單帶舊單號（ABLEPOS: 或連結）時，舊包上雅正教練對到的那一位也要重推：訂單取消後舊包會重新出現在他名下。
 */
async function changedCoachIds(db, ctx, since) {
  const ids = new Set();
  const orders = (await db.query(
    `SELECT COALESCE(ae.coach_id::text, (
              SELECT c.id::text FROM coaches c
               WHERE btrim(COALESCE(ae.coach, '')) <> '' AND btrim(c.name) = btrim(ae.coach)
                 AND (SELECT COUNT(*) FROM coaches c2 WHERE btrim(c2.name) = btrim(c.name)) = 1)) AS coach_id,
            CASE WHEN ae.external_order_no LIKE 'ABLEPOS:%' THEN substring(ae.external_order_no FROM 9) END AS legacy_seq,
            ARRAY(SELECT l.seq FROM yz_legacy_links l WHERE l.enrollment_id = ae.id) AS link_seqs
       FROM admin_enrollments ae
      WHERE GREATEST(ae.created_at, COALESCE(ae.updated_at, ae.created_at)) > $1::timestamptz`, [since])).rows;
  const seqs = new Set();
  for (const o of orders) {
    if (o.coach_id) ids.add(o.coach_id);
    for (const s of [o.legacy_seq, ...(o.link_seqs || [])]) if (s) seqs.add(String(s));
  }
  for (const r of (await db.query(
    `SELECT seq FROM yz_legacy_links WHERE linked_at > $1::timestamptz
     UNION SELECT seq FROM yz_legacy_packages WHERE loaded_at > $1::timestamptz`, [since])).rows) seqs.add(r.seq);
  if (seqs.size) {
    for (const r of (await db.query(`SELECT coach FROM yz_legacy_packages WHERE seq = ANY($1::text[])`, [[...seqs]])).rows) {
      const id = ctx.coachByLegacyName.get(normCoach(r.coach));
      if (id) ids.add(id);
    }
  }
  for (const c of ctx.byId.values()) {
    if (c.identity_updated_at && new Date(c.identity_updated_at) > new Date(since)) ids.add(c.id);
  }
  return [...ids].sort();
}

// ── 拉取 API（§4.3）────────────────────────────────────────────────────────────

/**
 * since 有給：since 之後有變動的教練（含刪除紀錄）。沒給：小助理該有的全部教練（有綁 LINE 的，含停用）。
 * 依 coach_id 排序分頁；afterId＝上一頁最後一位。
 */
async function listCoaches({ since = null, afterId = null, limit = PAGE, db = pool } = {}) {
  const n = Math.min(Math.max(Number(limit) || PAGE, 1), 500);
  const ctx = await loadContext(db);
  const universe = since
    ? await changedCoachIds(db, ctx, since)
    : [...ctx.byId.values()].filter((c) => identityState(c) !== 'deleted').map((c) => c.id).sort();
  const rest = afterId ? universe.filter((id) => id > afterId) : universe;
  const page = rest.slice(0, n);
  const coaches = [];
  for (const id of page) coaches.push(await buildCoachRecord(db, ctx, id));
  return { coaches, next_after_id: rest.length > n ? page[page.length - 1] : null };
}

// ── 推送（§4.2）────────────────────────────────────────────────────────────────

/** X-LB-Signature：sha256=HMAC-SHA256(secret, "<timestamp>.<body>")。 */
function sign(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function webhookConfig(env = process.env) {
  const url = String(env.LB_WEBHOOK_URL || '').trim();
  const secret = String(env.LB_WEBHOOK_SECRET || '').trim();
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
        'X-LB-Event-Id': payload.event_id,
        'X-LB-Timestamp': ts,
        'X-LB-Signature': sign(cfg.secret, ts, body),
      },
      body,
      signal: ctl.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`webhook HTTP ${res.status}`), { code: 'WEBHOOK_HTTP' });
  } finally {
    clearTimeout(timer);
  }
}

async function readChangeCursor(db = pool) {
  const { rows } = await db.query(
    `SELECT result_summary->>'cursor' AS cursor FROM job_runs
      WHERE job_name = $1 AND status = 'success' AND result_summary ? 'cursor'
      ORDER BY started_at DESC LIMIT 1`, [CHANGE_JOB]);
  const c = rows[0]?.cursor || null;
  return c && !Number.isNaN(Date.parse(c)) ? c : null;
}

/** 便宜的預檢：游標之後（嚴格大於，不加重疊）任一來源有變動才值得掛鎖推送。 */
async function hasChanges(db = pool) {
  const cursor = await readChangeCursor(db);
  if (!cursor) return true;
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM admin_enrollments WHERE GREATEST(created_at, COALESCE(updated_at, created_at)) > $1::timestamptz)
         OR EXISTS (SELECT 1 FROM coaches WHERE GREATEST(created_at, updated_at) > $1::timestamptz)
         OR EXISTS (SELECT 1 FROM admin_staff WHERE GREATEST(created_at, updated_at) > $1::timestamptz)
         OR EXISTS (SELECT 1 FROM yz_legacy_links WHERE linked_at > $1::timestamptz)
         OR EXISTS (SELECT 1 FROM yz_legacy_packages WHERE loaded_at > $1::timestamptz) AS changed`, [cursor]);
  return Boolean(rows[0]?.changed);
}

/**
 * 推送有變動的教練，每批最多 100 位、整位換掉。游標＝這一輪開始時的資料庫時間（毫秒）；
 * 下一輪從游標往前重疊 60 秒找變動（重送無害，接收端是整位教練換掉）。
 */
async function pushChanges({ db = pool, env = process.env, fetchImpl = fetch } = {}) {
  const cfg = webhookConfig(env);
  if (!cfg) return { skipped: 'not_configured' };
  const startedAt = (await db.query(`SELECT date_trunc('milliseconds', clock_timestamp()) AS t`)).rows[0].t;
  const prev = await readChangeCursor(db);
  const ctx = await loadContext(db);
  const ids = prev
    ? await changedCoachIds(db, ctx, new Date(new Date(prev).getTime() - CHANGE_OVERLAP_MS).toISOString())
    : [...ctx.byId.values()].filter((c) => identityState(c) !== 'deleted').map((c) => c.id).sort();
  let sent = 0;
  let rows = 0;
  for (let i = 0; i < ids.length; i += PAGE) {
    const coaches = [];
    for (const id of ids.slice(i, i + PAGE)) coaches.push(await buildCoachRecord(db, ctx, id));
    await post(cfg, { type: 'changes', event_id: crypto.randomUUID(), generated_at: new Date().toISOString(), coaches }, fetchImpl);
    sent += coaches.length;
    rows += coaches.reduce((s, r) => s + rowCount(r), 0);
  }
  return { sent, rows, shared_hashes: ctx.sharedHashes, cursor: new Date(startedAt).toISOString() };
}

/** 每晚全量快照：先全部組好，分頁送出；最後一頁附 total_coaches、total_rows，小助理收齊且數字相符才換。 */
async function pushSnapshot({ db = pool, env = process.env, fetchImpl = fetch } = {}) {
  const cfg = webhookConfig(env);
  if (!cfg) return { skipped: 'not_configured' };
  const ctx = await loadContext(db);
  const ids = [...ctx.byId.values()].filter((c) => identityState(c) !== 'deleted').map((c) => c.id).sort();
  const records = [];
  for (const id of ids) records.push(await buildCoachRecord(db, ctx, id));
  const totalRows = records.reduce((s, r) => s + rowCount(r), 0);
  const snapshotId = crypto.randomUUID();
  const pages = Math.max(1, Math.ceil(records.length / PAGE));
  for (let p = 1; p <= pages; p += 1) {
    const last = p === pages;
    await post(cfg, {
      type: 'snapshot', event_id: crypto.randomUUID(), snapshot_id: snapshotId, page: p, is_last: last,
      generated_at: new Date().toISOString(), coaches: records.slice((p - 1) * PAGE, p * PAGE),
      ...(last ? { total_coaches: records.length, total_rows: totalRows } : {}),
    }, fetchImpl);
  }
  return { snapshot_id: snapshotId, pages, coaches: records.length, rows: totalRows, shared_hashes: ctx.sharedHashes };
}

module.exports = {
  CHANGE_JOB, sign, webhookConfig, readChangeCursor, hasChanges, pushChanges, pushSnapshot, listCoaches,
  __test__: { loadContext, buildCoachRecord, changedCoachIds, identityState, sha256 },
};
