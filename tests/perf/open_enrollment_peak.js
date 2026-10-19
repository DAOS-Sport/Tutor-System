#!/usr/bin/env node
'use strict';
// 「開放報名」尖峰壓測（GitHub #10）。
//
// 模擬開放報名那一刻：大量家長同時瀏覽報名頁（場館／課別／定價／教練／優惠），
// 同時有一批家長搶「限量 K 名」的優惠代碼送出報名。驗證：
//   1. 瀏覽與報名的延遲（p50／p95／p99／max）、錯誤數；
//   2. 不超賣：優惠 current_uses ≤ max_uses，且 = promotion_usages 列數 = 實際拿到折扣的訂單數；
//      搶輸的只能拿到 400 COUPON_*（不可 5xx、不可默默照原價成立又扣名額）；
//   3. 重送（同一 request_id 並發送兩次）只成立一張付款單。
//
// 只能對「本機伺服器＋拋棄式測試庫」執行（DATABASE_URL 必須是 localhost 且庫名含 test/audit）。
// 伺服器請以 PREVIEW_SAFE_MODE=1 啟動（關排程、LINE、寄信）。不打 Ragic／LINE。
//
// 用法：
//   DATABASE_URL=postgresql://...localhost.../daos_test_x JWT_SECRET=<與伺服器相同的本機測試值> \
//   BASE_URL=http://127.0.0.1:3910 node tests/perf/open_enrollment_peak.js
// 參數（環境變數）：PARENTS=200 QUOTA=20 ENROLL_CONC=50 REPLAYS=20 BROWSE_CONN=20 BROWSE_SECONDS=20
//   REQ_TIMEOUT_MS=30000（單一請求逾時即算錯誤）　KEEP=1 不清除測試資料（預設會清）。
// 任何非預期狀態碼、5xx、連線錯誤或超賣都會讓程式以非 0 結束。
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const jwt = require('../../server/node_modules/jsonwebtoken');
const { Pool } = require('../../server/node_modules/pg');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const DB_URL = process.env.DATABASE_URL || '';
const SECRET = process.env.JWT_SECRET || '';
const PARENTS = Number(process.env.PARENTS || 200);
const QUOTA = Number(process.env.QUOTA || 20);
const ENROLL_CONC = Number(process.env.ENROLL_CONC || 50);
const REPLAYS = Number(process.env.REPLAYS || 20);
const BROWSE_CONN = Number(process.env.BROWSE_CONN || 20);
const BROWSE_SECONDS = Number(process.env.BROWSE_SECONDS || 20);
const KEEP = process.env.KEEP === '1';
// 單一請求逾時：伺服器卡死（例如連線池互等）時要判失敗，而不是讓壓測永遠掛著。
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 30000);

function guard() {
  const u = new URL(DB_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(u.hostname), 'DATABASE_URL 必須是本機');
  assert.match(u.pathname, /test|audit/, 'DATABASE_URL 必須是拋棄式測試庫（庫名含 test/audit）');
  const b = new URL(BASE);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(b.hostname), 'BASE_URL 必須是本機伺服器');
  assert.ok(SECRET.length >= 16, 'JWT_SECRET 必須設定（與本機伺服器相同的測試值）');
  assert.ok(QUOTA > 0 && PARENTS > QUOTA, 'PARENTS 必須大於 QUOTA 才有搶名額');
  assert.ok(REPLAYS <= PARENTS);
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] * 10) / 10;
}
function summarize(durations) {
  const s = [...durations].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), max: s.length ? Math.round(s.at(-1)) : null };
}

async function timedFetch(path, { method = 'GET', token, body } = {}) {
  const t0 = performance.now();
  let status = 0;
  let json = null;
  let error = null;
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  } catch (err) {
    error = err.cause?.code || err.code || err.message;
  }
  return { status, json, error, ms: performance.now() - t0 };
}

async function seed(db, marker) {
  const venue = (await db.query(
    `SELECT v.id FROM venues v
       JOIN course_type_configs c ON c.pricing_zone_id = v.pricing_zone_id AND c.course_type = 1
      WHERE v.is_active = TRUE AND c.is_active = TRUE AND c.base_price > 0 AND c.max_students = 1
      ORDER BY v.id LIMIT 1`)).rows[0];
  assert.ok(venue, '測試庫沒有可報名一對一的場館（venue＋定價區＋course_type 1）');
  const coach = (await db.query(
    `SELECT c.id FROM coaches c LEFT JOIN admin_staff s ON s.id = c.ragic_employee_id
      WHERE c.is_active = TRUE AND COALESCE(c.is_placeholder, FALSE) = FALSE
        AND COALESCE(s.multiplier, c.pricing_multiplier) > 0
      ORDER BY c.id LIMIT 1`)).rows[0];
  assert.ok(coach, '測試庫沒有可報名的教練');
  const parents = [];
  for (let i = 0; i < PARENTS; i += 1) {
    const pid = randomUUID();
    const sid = randomUUID();
    const phone = `${marker}${String(i).padStart(4, '0')}`.slice(0, 20);
    await db.query(`INSERT INTO parents(id, name, phone) VALUES ($1, $2, $3)`, [pid, `壓測家長${i}`, phone]);
    await db.query(`INSERT INTO students(id, parent_id, name) VALUES ($1, $2, $3)`, [sid, pid, `壓測學員${i}`]);
    parents.push({
      id: pid, sid, phone,
      token: jwt.sign({ parentId: pid, phone, type: 'parent' }, SECRET, { expiresIn: '1h' }),
    });
  }
  const coupon = `PERF${marker.slice(2).toUpperCase()}`.slice(0, 40);
  const promo = (await db.query(
    `INSERT INTO promotions(name, type, discount_value, applicable_course_types, applicable_venue_ids,
        coupon_code, start_date, end_date, max_uses, status, show_on_parent_home)
     VALUES ($1, 'FIXED_AMOUNT', 500, ARRAY[1], ARRAY[$2]::varchar[], $3,
             NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', $4, 'active', FALSE)
     RETURNING id`, [`壓測早鳥 ${marker}`, venue.id, coupon, QUOTA])).rows[0];
  return { venueId: venue.id, coachId: coach.id, parents, coupon, promoId: promo.id };
}

async function cleanup(db, fx) {
  const ids = fx.parents.map((p) => p.id);
  const phones = fx.parents.map((p) => p.phone);
  await db.query(`DELETE FROM promotion_usages WHERE promotion_id = $1`, [fx.promoId]);
  await db.query(`DELETE FROM admin_enrollment_audit_logs WHERE enrollment_id IN (SELECT id FROM admin_enrollments WHERE parent_phone = ANY($1))`, [phones]);
  await db.query(`DELETE FROM admin_enrollments WHERE parent_phone = ANY($1)`, [phones]);
  await db.query(`DELETE FROM checkout_sessions WHERE parent_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM request_idempotency_ledger WHERE actor_type = 'parent' AND actor_id::text = ANY($1::text[])`, [ids]);
  await db.query(`DELETE FROM promotion_audit_logs WHERE promotion_id = $1`, [fx.promoId]);
  await db.query(`DELETE FROM promotions WHERE id = $1`, [fx.promoId]);
  await db.query(`DELETE FROM students WHERE parent_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM parents WHERE id = ANY($1::uuid[])`, [ids]);
}

/** 瀏覽負載：BROWSE_CONN 條連線輪流打報名頁會呼叫的唯讀端點，直到 stop()。 */
function startBrowse(fx) {
  const paths = [
    '/api/venues',
    `/api/courses/types?venue=${fx.venueId}`,
    `/api/courses/base-price?courseType=1&venue=${fx.venueId}`,
    '/api/promotions',
    `/api/coaches?venueId=${fx.venueId}`,
  ];
  const stats = { durations: [], byPath: {}, statuses: {}, errors: 0, unexpected: [] };
  let running = true;
  let k = 0;
  const workers = Array.from({ length: BROWSE_CONN }, async (_, w) => {
    while (running) {
      const path = paths[k % paths.length];
      const parent = fx.parents[(k + w) % fx.parents.length];
      k += 1;
      const r = await timedFetch(path, { token: parent.token });
      stats.durations.push(r.ms);
      (stats.byPath[path] ||= []).push(r.ms);
      stats.statuses[r.status] = (stats.statuses[r.status] || 0) + 1;
      if (r.error) stats.errors += 1;
      else if (r.status !== 200 && stats.unexpected.length < 5) stats.unexpected.push({ path, status: r.status, body: r.json });
    }
  });
  return {
    stats,
    async stop() { running = false; await Promise.all(workers); },
  };
}

function enrollBody(fx, parent, requestId) {
  return {
    request_id: requestId,
    coach: { id: fx.coachId },
    venue: { id: fx.venueId },
    course_type: 1,
    period_count: 1,
    students: [{ id: parent.sid }],
    promotion: { coupon_code: fx.coupon },
  };
}

async function runPool(items, conc, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

(async () => {
  guard();
  const db = new Pool({ connectionString: DB_URL, max: 4 });
  const marker = 'pf' + Date.now().toString(36);
  const health = await timedFetch('/health');
  assert.equal(health.status, 200, `伺服器 ${BASE}/health 沒有回 200（${health.status} ${health.error || ''}）`);
  let fx;
  const failures = [];
  try {
    fx = await seed(db, marker);
    console.log(`seed: marker=${marker} parents=${PARENTS} quota=${QUOTA} venue=${fx.venueId}`);

    // ── 階段 1：只有瀏覽 ──
    const browse1 = startBrowse(fx);
    await new Promise((r) => setTimeout(r, BROWSE_SECONDS * 1000));
    await browse1.stop();

    // ── 階段 2：瀏覽持續 + 報名搶名額 + 重送 ──
    const browse2 = startBrowse(fx);
    const replaySet = new Set(fx.parents.slice(0, REPLAYS).map((p) => p.id));
    const jobs = [];
    for (const parent of fx.parents) {
      const rid = randomUUID();
      jobs.push({ parent, rid, replay: false });
      if (replaySet.has(parent.id)) jobs.push({ parent, rid, replay: true });
    }
    // 打散順序：重送和原請求可能同時在飛
    for (let i = jobs.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
    }
    const t0 = performance.now();
    const results = await runPool(jobs, ENROLL_CONC, (job) =>
      timedFetch('/api/enrollments', { method: 'POST', token: job.parent.token, body: enrollBody(fx, job.parent, job.rid) })
        .then((r) => ({ ...r, job })));
    const enrollWallMs = performance.now() - t0;
    await browse2.stop();

    // ── 判定 ──
    const statusCount = {};
    for (const r of results) {
      const key = r.error ? `ERR:${r.error}` : `${r.status}${r.json?.code ? ':' + r.json.code : ''}`;
      statusCount[key] = (statusCount[key] || 0) + 1;
    }
    const created = results.filter((r) => r.status === 201);
    const idem = results.filter((r) => r.status === 200 && r.json?.idempotent);
    const couponRejected = results.filter((r) => r.status === 400 && String(r.json?.code || '').startsWith('COUPON_'));
    const other = results.filter((r) => !created.includes(r) && !idem.includes(r) && !couponRejected.includes(r));
    if (other.length) failures.push(`非預期回應 ${other.length} 筆：${JSON.stringify(other.slice(0, 3).map((r) => ({ s: r.status, e: r.error, b: r.json })))}`);
    if (created.length !== QUOTA) failures.push(`成立訂單 ${created.length} 筆，應剛好等於名額 ${QUOTA}`);
    if (created.some((r) => !r.json?.promotion || r.json.promotion.discount !== 500)) failures.push('有成立訂單沒有拿到優惠（不該以原價默默成立）');

    // 重送：同一 request_id 的兩個回應必須一致（同一張付款單，或同樣被拒）
    const byRid = new Map();
    for (const r of results) (byRid.get(r.job.rid) || byRid.set(r.job.rid, []).get(r.job.rid)).push(r);
    let replayMismatch = 0;
    for (const [, rs] of byRid) {
      if (rs.length < 2) continue;
      const ids = new Set(rs.map((r) => r.json?.checkout_id || `rejected:${r.status}`));
      if (ids.size !== 1) replayMismatch += 1;
    }
    if (replayMismatch) failures.push(`重送不一致 ${replayMismatch} 組`);

    const promo = (await db.query(`SELECT max_uses, current_uses FROM promotions WHERE id = $1`, [fx.promoId])).rows[0];
    const usages = Number((await db.query(`SELECT COUNT(*) FROM promotion_usages WHERE promotion_id = $1`, [fx.promoId])).rows[0].count);
    const ids = fx.parents.map((p) => p.id);
    const checkouts = Number((await db.query(`SELECT COUNT(*) FROM checkout_sessions WHERE parent_id = ANY($1::uuid[])`, [ids])).rows[0].count);
    const enrollRows = Number((await db.query(`SELECT COUNT(*) FROM admin_enrollments WHERE parent_phone = ANY($1)`, [fx.parents.map((p) => p.phone)])).rows[0].count);
    if (promo.current_uses > promo.max_uses) failures.push(`超賣：current_uses=${promo.current_uses} > max_uses=${promo.max_uses}`);
    if (promo.current_uses !== usages) failures.push(`current_uses=${promo.current_uses} 與 promotion_usages=${usages} 不一致`);
    if (usages !== created.length) failures.push(`promotion_usages=${usages} 與成立訂單 ${created.length} 不一致`);
    if (checkouts !== created.length) failures.push(`checkout_sessions=${checkouts} 與成立訂單 ${created.length} 不一致（重送不可多建）`);
    if (enrollRows !== created.length) failures.push(`admin_enrollments=${enrollRows} 與成立訂單 ${created.length} 不一致`);

    for (const [name, b] of [['browse_only', browse1.stats], ['browse_during_enroll', browse2.stats]]) {
      const bad = Object.entries(b.statuses).filter(([s]) => s !== '200').reduce((n, [, c]) => n + c, 0);
      if (bad || b.errors) failures.push(`${name}: 非 200 ${bad} 筆、連線錯誤 ${b.errors} 筆 ${JSON.stringify(b.unexpected)}`);
    }

    const report = {
      scope: 'LOCAL SANDBOX ONLY — 本機單一 Node 行程＋本機 PostgreSQL，非正式環境數字',
      base_url: BASE,
      params: { PARENTS, QUOTA, ENROLL_CONC, REPLAYS, BROWSE_CONN, BROWSE_SECONDS },
      browse_only: {
        ...summarize(browse1.stats.durations),
        rps: Math.round(browse1.stats.durations.length / BROWSE_SECONDS),
        statuses: browse1.stats.statuses,
        by_path: Object.fromEntries(Object.entries(browse1.stats.byPath).map(([p, d]) => [p, summarize(d)])),
      },
      browse_during_enroll: { ...summarize(browse2.stats.durations), statuses: browse2.stats.statuses },
      enroll: {
        ...summarize(results.map((r) => r.ms)),
        wall_ms: Math.round(enrollWallMs),
        requests: results.length,
        statuses: statusCount,
        created_201: summarize(created.map((r) => r.ms)),
        rejected_coupon_400: summarize(couponRejected.map((r) => r.ms)),
        idempotent_200: idem.length,
      },
      oversell_check: { max_uses: promo.max_uses, current_uses: promo.current_uses, promotion_usages: usages, checkout_sessions: checkouts, admin_enrollments: enrollRows },
      result: failures.length ? 'FAIL' : 'PASS',
      failures,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (fx && !KEEP) {
      try { await cleanup(db, fx); } catch (err) { failures.push(`cleanup failed: ${err.message}`); console.error(`cleanup failed (marker=${marker}): ${err.message}`); }
    }
    await db.end();
  }
  if (failures.length) process.exitCode = 1;
})().catch((err) => { console.error(err); process.exitCode = 1; });
