'use strict';
/**
 * LINE 小助理教練查課同步（SPEC v1.0 §7.1、v1.1 C1～C5）對真的 PostgreSQL（拋棄式測試庫）。
 *
 * 驗：推送內容和教練端「報名狀態」逐筆相同（實際以 HTTP 呼叫 GET /api/sessions/coach/:id/enrollments）、
 * 認人（教練檔／員工檔 LINE、停用、共用 LINE、佔位）、雅正舊課（姓名唯一、已轉入排除、沒學員姓名排除、
 * 取消後重新出現並重推對的人）、變動偵測、推送簽章與失敗不前進、快照總數、拉取 API、欄位白名單、
 * 推送格式和 tests/fixtures/line_bot_payload.json 一致。資料全部虛構，結束時刪掉本測試建立的列。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');
process.env.DATABASE_URL = url;

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const stub = (rel, exports) => {
  const p = require.resolve(path.join(SERVER, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
// 教練端登入換成替身：只驗資料，不驗 LINE 登入。
stub('middlewares/coachAuth', {
  requireCoach: (_req, _res, next) => next(),
  requireCoachOwner: () => (_req, _res, next) => next(),
});

const express = require(path.join(SERVER, 'node_modules/express'));
const { pool } = require(path.join(SERVER, 'models/db'));
const lb = require(path.join(SERVER, 'services/lineBotSync'));
const sessionsRouter = require(path.join(SERVER, 'routes/sessions'));
const lbRouter = require(path.join(SERVER, 'routes/lineBotSync'));
const FIXTURE = require(path.join(ROOT, 'tests/fixtures/line_bot_payload.json'));

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

const T = `lbt${Date.now().toString(36)}`;
const ORDER = T.toUpperCase();
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const LINE = { A: `Ulbtest_A_${T}`, AS: `Ulbtest_AS_${T}`, B: `Ulbtest_B_${T}`, C: `Ulbtest_C_${T}` };
const SECRET = 's'.repeat(40);
const coach = {}; // 代號 → coach id
const coachNames = {}; // 代號 → 姓名
const SEQ = { B1: '8881001', ORPHAN: '8881002', DUP: '8881003', BUILT: '8881004' };
let venueId;
let afterSetup;

async function addCoach(tag, { name, active = true, staffActive = true, coachLine = null, staffLine = null } = {}) {
  const staffId = `LBT${T}${tag}`;
  await pool.query(`INSERT INTO admin_staff (id, name, role, active, line_uid) VALUES ($1, $2, 'coach', $3, $4)`,
    [staffId, name, staffActive, staffLine]);
  const r = await pool.query(
    `INSERT INTO coaches (ragic_employee_id, name, phone, is_active, line_uid) VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
    [staffId, name, `T-${T}-${tag}`, active, coachLine]);
  coach[tag] = r.rows[0].id;
  coachNames[tag] = name;
}

let seq = 0;
async function addOrder({ coachTag = null, coachName = null, status = 'confirmed', total = 6, used = 0, students = ['測試學員'],
  invoiceAt = '2026-09-01T02:00:00Z', external = null, batch = crypto.randomUUID(), period = 1 } = {}) {
  seq += 1;
  const id = `${ORDER}${String(seq).padStart(3, '0')}`;
  await pool.query(
    `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
       original_price, final_price, status, submitted_at, total_sessions, used_sessions, period_number, period_count,
       enrollment_batch_id, invoice_issued_at, external_order_no)
     VALUES ($1, '測試家長', '0912000999', $2::text[], $3, $4::uuid, $5, 1, 6900, 6900, $6, NOW(), $7, $8, $9, 1, $10::uuid, $11, $12)`,
    [id, students, coachName || coachNames[coachTag], coachTag ? coach[coachTag] : null, venueId, status, total, used, period, batch,
      status === 'confirmed' ? invoiceAt : null, external]);
  return id;
}

async function addLegacy(s, coachName, students, remaining = 3, total = 6) {
  await pool.query(
    `INSERT INTO yz_legacy_packages (seq, coach, student_names, course_name, total_sessions, remaining_sessions, used_sessions, uses, snapshot_at)
     VALUES ($1, $2, $3::text[], '家教1VS1', $4, $5, 0, '[]'::jsonb, '2026-10-22T21:06:00+08:00')`,
    [s, coachName, students, total, remaining]);
}

function capture({ status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (u, opts) => { calls.push({ url: u, headers: opts.headers, body: opts.body }); return { ok: status < 300, status }; };
  return { calls, fetchImpl };
}
const ENV = { LB_WEBHOOK_URL: 'https://bot.example.invalid/api/tutor-sync/webhook', LB_WEBHOOK_SECRET: SECRET };
const mine = (list) => list.filter((r) => Object.values(coach).includes(r.coach_id));

console.log('line_bot_sync_db_test');

(async () => {
  const app = express();
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/integrations/line-bot', lbRouter);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    venueId = (await pool.query('SELECT id FROM admin_venues ORDER BY id LIMIT 1')).rows[0].id;
    await addCoach('A', { name: `甲教練${T}`, coachLine: LINE.A, staffLine: LINE.AS });
    await addCoach('B', { name: `乙教練${T}`, staffLine: LINE.B });                 // 只有員工檔綁 LINE
    await addCoach('C', { name: `丙教練${T}`, active: false, coachLine: LINE.C });   // 停用但有綁
    await addCoach('D', { name: `丁教練${T}` });                                      // 沒綁 LINE
    await addCoach('E1', { name: `同名教練${T}`, coachLine: `Ulbtest_E1_${T}` });
    await addCoach('E2', { name: ` 同名教練${T} `, coachLine: `Ulbtest_E2_${T}` });   // 正規化後同名
    await addCoach('F', { name: `戊教練${T}`, coachLine: LINE.AS });                 // 和 A 的員工檔共用同一個 LINE
    await addCoach('G', { name: `己教練${T}`, staffActive: false, coachLine: `Ulbtest_G_${T}` }); // 員工檔停用

    await addOrder({ coachTag: 'A', used: 2, students: ['林測一'] });                         // 進行中
    await addOrder({ coachTag: 'A', status: 'pending_payment', students: ['林測二'] });       // 待付款
    await addOrder({ coachTag: 'A', used: 6, students: ['林測三'] });                         // 已上完：不推
    await addOrder({ coachName: `甲教練${T}`, used: 1, students: ['林測四'] });               // 只有姓名（唯一）
    const sharedBatch = crypto.randomUUID();                                                  // 一筆兩列（1對2）
    await addOrder({ coachTag: 'A', used: 3, students: ['林測五'], batch: sharedBatch });
    await addOrder({ coachTag: 'A', used: 3, students: ['林測六'], batch: sharedBatch });
    await addOrder({ coachTag: 'C', used: 1, students: ['林測七'] });                         // 停用教練的課不推
    await addLegacy(SEQ.B1, `乙教練${T}`, ['陳舊一']);
    await addLegacy(SEQ.ORPHAN, `乙教練${T}`, []);                                           // 沒學員姓名：不推
    await addLegacy(SEQ.DUP, `同名教練${T}`, ['陳舊三']);                                     // 姓名不唯一：不推
    await addLegacy(SEQ.BUILT, `乙教練（50%）${T}`, ['陳舊四']);                              // 已轉入：先不推
    const builtOrder = await addOrder({ coachTag: 'A', used: 0, students: ['陳舊四'], external: `ABLEPOS:${SEQ.BUILT}` });
    await new Promise((r) => setTimeout(r, 30));
    afterSetup = (await pool.query(`SELECT clock_timestamp() AS t`)).rows[0].t.toISOString();

    const ctx = await lb.__test__.loadContext(pool);
    const rec = async (tag) => lb.__test__.buildCoachRecord(pool, ctx, coach[tag]);

    await check('BOT-04 一致性：推送的進行中／待付款和教練端「報名狀態」逐筆相同（實際 HTTP 呼叫）', async () => {
      const r = await fetch(`${base}/api/sessions/coach/${coach.A}/enrollments`).then((x) => x.json());
      const want = r.items.filter((it) => ['in_progress', 'pending_payment'].includes(it.bucket))
        .map((it) => [it.bucket, [...it.students].sort().join('、'), Number(it.total_sessions), Number(it.used_sessions), it.course_expires_at])
        .sort();
      const a = await rec('A');
      const got = a.new_system.map((c) => [c.status, c.students.join('、'), c.total_sessions, c.used_sessions, c.course_expires_at]).sort();
      assert.deepEqual(got, want);
      assert.equal(got.length, 5, '進行中 4 筆（含姓名回退、一筆兩列算一筆）＋待付款 1 筆；已上完不推');
      assert.ok(a.new_system.every((c) => c.remaining_sessions === Math.max(0, c.total_sessions - c.used_sessions)));
      assert.ok(a.new_system.some((c) => c.students.join('、') === '林測五、林測六'), '一筆兩列合成一筆、學員都在');
      assert.ok(a.new_system.find((c) => c.status === 'pending_payment').course_expires_at === null);
    });

    await check('BOT-03 認人：教練檔與員工檔的 LINE 都產生雜湊；只綁員工檔的也認得；不送原始 LINE', async () => {
      const a = await rec('A');
      assert.ok(a.line_uid_hashes.includes(sha(LINE.A)));
      assert.ok(!a.line_uid_hashes.includes(sha(LINE.AS)), 'A 員工檔的 LINE 和 F 共用 → 不推（C3）');
      const b = await rec('B');
      assert.deepEqual([b.active, b.line_uid_hashes], [true, [sha(LINE.B)]]);
    });

    await check('C1 停用：教練停用→active:false、雜湊保留、課程清空；員工檔停用也一樣', async () => {
      const c = await rec('C');
      assert.deepEqual([c.active, c.line_uid_hashes, c.new_system, c.legacy], [false, [sha(LINE.C)], [], []]);
      const g = await rec('G');
      assert.deepEqual([g.active, g.new_system.length], [false, 0]);
    });

    await check('C1／C3 刪除：沒綁 LINE 的、LINE 被共用而沒剩雜湊的 → {deleted:true}', async () => {
      assert.deepEqual(await rec('D'), { coach_id: coach.D, deleted: true });
      assert.deepEqual(await rec('F'), { coach_id: coach.F, deleted: true });
    });

    await check('BOT-05 雅正：姓名唯一才推、沒學員姓名不推、已轉入不推；括號裡的 % 不影響對應', async () => {
      const b = await rec('B');
      assert.deepEqual(b.legacy.map((l) => l.seq), [SEQ.B1]);
      assert.deepEqual(b.legacy[0].students, ['陳舊一']);
      assert.equal(b.legacy[0].snapshot_at, '2026-10-22T13:06:00.000Z');
      for (const t of ['E1', 'E2']) assert.deepEqual((await rec(t)).legacy, [], '同名不推');
    });

    await check('C5 訂單取消後舊包重新出現，重推的是舊包的教練（不是訂單的教練）', async () => {
      await pool.query(`UPDATE admin_enrollments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [builtOrder]);
      const ctx2 = await lb.__test__.loadContext(pool);
      const changed = await lb.__test__.changedCoachIds(pool, ctx2, afterSetup);
      assert.ok(changed.includes(coach.B), '舊包教練 B 要被當成有變動');
      assert.ok(changed.includes(coach.A), '訂單教練 A 也有變動');
      const b = await lb.__test__.buildCoachRecord(pool, ctx2, coach.B);
      assert.deepEqual(b.legacy.map((l) => l.seq).sort(), [SEQ.B1, SEQ.BUILT].sort());
    });

    await check('BOT-11 變動偵測：改已用堂數、改教練姓名、新增雅正連結，都讓對的教練出現', async () => {
      const since = (await pool.query(`SELECT clock_timestamp() AS t`)).rows[0].t.toISOString();
      await new Promise((r) => setTimeout(r, 20));
      let ctx2 = await lb.__test__.loadContext(pool);
      assert.deepEqual(mine([...(await lb.__test__.changedCoachIds(pool, ctx2, since))].map((id) => ({ coach_id: id }))), [], '還沒改：沒有人');
      const ord = (await pool.query(`SELECT id FROM admin_enrollments WHERE coach_id = $1 AND status = 'confirmed' LIMIT 1`, [coach.A])).rows[0].id;
      await pool.query(`UPDATE admin_enrollments SET used_sessions = used_sessions + 1, updated_at = NOW() WHERE id = $1`, [ord]);
      await pool.query(`UPDATE coaches SET name = name || '改', updated_at = NOW() WHERE id = $1`, [coach.G]);
      const linkOrder = await addOrder({ coachTag: 'D', students: ['陳舊一'] });
      await pool.query(`INSERT INTO yz_legacy_links (seq, enrollment_id) VALUES ($1, $2)`, [SEQ.B1, linkOrder]);
      ctx2 = await lb.__test__.loadContext(pool);
      const changed = await lb.__test__.changedCoachIds(pool, ctx2, since);
      for (const t of ['A', 'G', 'D', 'B']) assert.ok(changed.includes(coach[t]), `${t} 應該有變動`);
      assert.ok(!changed.includes(coach.C), 'C 沒改，不該出現');
      const b = await lb.__test__.buildCoachRecord(pool, ctx2, coach.B);
      assert.ok(!b.legacy.some((l) => l.seq === SEQ.B1), '連結後舊包消失');
    });

    await check('§4.2 推送：簽章驗得過、改一個字就驗不過；對方 500 時丟錯（游標不前進）；沒設定就跳過', async () => {
      const ok = capture();
      const res = await lb.pushChanges({ env: ENV, fetchImpl: ok.fetchImpl });
      assert.ok(res.sent > 0 && ok.calls.length >= 1 && res.cursor);
      const c0 = ok.calls[0];
      const ts = c0.headers['X-LB-Timestamp'];
      const want = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${c0.body}`).digest('hex');
      assert.equal(c0.headers['X-LB-Signature'], want);
      const tampered = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${c0.body.replace('"changes"', '"chang3s"')}`).digest('hex');
      assert.notEqual(c0.headers['X-LB-Signature'], tampered);
      assert.equal(JSON.parse(c0.body).type, 'changes');
      assert.ok(c0.headers['X-LB-Event-Id']);
      const bad = capture({ status: 500 });
      await assert.rejects(() => lb.pushChanges({ env: ENV, fetchImpl: bad.fetchImpl }), /webhook HTTP 500/);
      assert.deepEqual(await lb.pushChanges({ env: {}, fetchImpl: ok.fetchImpl }), { skipped: 'not_configured' });
      assert.equal(lb.webhookConfig({ LB_WEBHOOK_URL: 'http://x', LB_WEBHOOK_SECRET: SECRET }), null, '非 https 不啟動');
      assert.equal(lb.webhookConfig({ LB_WEBHOOK_URL: ENV.LB_WEBHOOK_URL, LB_WEBHOOK_SECRET: 'short' }), null, '金鑰太短不啟動');
    });

    await check('§4.2 游標：成功才記；預檢在游標之後沒變動就是 false，有變動才 true', async () => {
      const cur = (await pool.query(`SELECT date_trunc('milliseconds', clock_timestamp()) AS t`)).rows[0].t.toISOString();
      await pool.query(
        `INSERT INTO job_runs (job_name, holder_id, triggered_by, status, result_summary, started_at)
         VALUES ($1, $2, 'test', 'success', jsonb_build_object('cursor', $3::text), NOW() + interval '1 hour')`,
        [lb.CHANGE_JOB, `t-${T}`, cur]);
      assert.equal(await lb.readChangeCursor(pool), cur);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(await lb.hasChanges(pool), false);
      await pool.query(`UPDATE coaches SET updated_at = NOW() WHERE id = $1`, [coach.B]);
      assert.equal(await lb.hasChanges(pool), true);
    });

    await check('§4.2 快照：分頁、只有最後一頁 is_last 且帶 total_coaches／total_rows，數字等於送出的內容', async () => {
      const cap = capture();
      const res = await lb.pushSnapshot({ env: ENV, fetchImpl: cap.fetchImpl });
      const pages = cap.calls.map((c) => JSON.parse(c.body));
      assert.equal(pages.length, res.pages);
      assert.ok(pages.every((p, i) => p.type === 'snapshot' && p.page === i + 1 && p.snapshot_id === res.snapshot_id && p.is_last === (i === pages.length - 1)));
      const all = pages.flatMap((p) => p.coaches);
      const last = pages[pages.length - 1];
      assert.equal(last.total_coaches, all.length);
      assert.equal(last.total_rows, all.reduce((s, r) => s + r.new_system.length + r.legacy.length, 0));
      assert.ok(!all.some((r) => r.deleted), '快照不放刪除紀錄（快照外的就是刪掉）');
      const ids = new Set(all.map((r) => r.coach_id));
      for (const t of ['A', 'B', 'C', 'G', 'E1', 'E2']) assert.ok(ids.has(coach[t]), `${t} 在快照裡`);
      for (const t of ['D', 'F']) assert.ok(!ids.has(coach[t]), `${t} 不在快照裡`);
    });

    await check('§4.3 拉取 API：沒設 503、錯的金鑰 401、對的 200；分頁接起來不重複不漏；since 會帶刪除紀錄', async () => {
      const get = (q, key) => fetch(`${base}/api/integrations/line-bot/coaches${q}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
      delete process.env.LB_SYNC_API_KEY;
      assert.equal((await get('')).status, 503);
      process.env.LB_SYNC_API_KEY = 'k'.repeat(40);
      assert.equal((await get('', 'x'.repeat(40))).status, 401);
      assert.equal((await get('')).status, 401);
      assert.equal((await get('?since=nope', 'k'.repeat(40))).status, 400);
      const seen = [];
      let after = null;
      for (let i = 0; i < 1000; i += 1) {
        const r = await get(`?limit=2${after ? `&after_id=${after}` : ''}`, 'k'.repeat(40));
        assert.equal(r.status, 200);
        const j = await r.json();
        seen.push(...j.coaches.map((c) => c.coach_id));
        if (!j.next_after_id) break;
        after = j.next_after_id;
      }
      assert.equal(new Set(seen).size, seen.length, '不重複');
      const snap = capture();
      await lb.pushSnapshot({ env: ENV, fetchImpl: snap.fetchImpl });
      const snapIds = snap.calls.flatMap((c) => JSON.parse(c.body).coaches.map((r) => r.coach_id)).sort();
      assert.deepEqual([...seen].sort(), snapIds, '全量拉取＝快照的教練');
      await pool.query(`UPDATE coaches SET line_uid = NULL, updated_at = NOW() WHERE id = $1`, [coach.C]);
      const j = await (await get(`?since=${encodeURIComponent(afterSetup)}`, 'k'.repeat(40))).json();
      assert.ok(j.coaches.some((r) => r.coach_id === coach.C && r.deleted === true), '解綁後推刪除');
      delete process.env.LB_SYNC_API_KEY;
    });

    await check('BOT-09 白名單：推送與拉取裡沒有電話、家長、金額、發票、原始 LINE userId', async () => {
      const cap = capture();
      await lb.pushSnapshot({ env: ENV, fetchImpl: cap.fetchImpl });
      const ctx2 = await lb.__test__.loadContext(pool);
      const extra = [];
      for (const t of Object.keys(coach)) extra.push(await lb.__test__.buildCoachRecord(pool, ctx2, coach[t]));
      const text = cap.calls.map((c) => c.body).join('\n') + JSON.stringify(extra);
      // UUID 與 sha256 雜湊是 16 進位字串，偶爾會剛好含「09＋8 位數字」：電話只掃人看的文字欄位。
      const ID_KEYS = new Set(['coach_id', 'line_uid_hashes', 'key', 'snapshot_id', 'event_id']);
      const strip = (v) => (Array.isArray(v) ? v.map(strip)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !ID_KEYS.has(k)).map(([k, x]) => [k, strip(x)])) : v);
      const human = JSON.stringify(strip([...cap.calls.map((c) => JSON.parse(c.body)), ...extra]));
      assert.ok(!/09\d{8}/.test(human), '電話');
      assert.ok(/09\d{8}/.test(JSON.stringify(strip({ students: ['0912000999'] }))), '這條檢查本身抓得到電話');
      assert.ok(!/Ulbtest_/.test(text), '原始 LINE userId');
      for (const w of ['測試家長', 'parent', 'price', 'invoice', 'phone', '6900']) assert.ok(!text.includes(w), w);
    });

    await check('§4.1 格式：和 tests/fixtures/line_bot_payload.json 的四種情況欄位完全一致', async () => {
      const ctx2 = await lb.__test__.loadContext(pool);
      const keys = (o) => Object.keys(o).sort();
      const a = await lb.__test__.buildCoachRecord(pool, ctx2, coach.A);
      const b = await lb.__test__.buildCoachRecord(pool, ctx2, coach.B);
      const g = await lb.__test__.buildCoachRecord(pool, ctx2, coach.G);
      const d = await lb.__test__.buildCoachRecord(pool, ctx2, coach.D);
      assert.deepEqual(keys(a), keys(FIXTURE.active));
      assert.deepEqual(keys(a.new_system[0]), keys(FIXTURE.active.new_system[0]));
      assert.deepEqual(keys(b.legacy[0] || FIXTURE.legacy_only.legacy[0]), keys(FIXTURE.legacy_only.legacy[0]));
      assert.deepEqual(keys(g), keys(FIXTURE.inactive));
      assert.deepEqual(keys(d), keys(FIXTURE.deleted));
      assert.ok(a.line_uid_hashes.every((h) => /^[0-9a-f]{64}$/.test(h)));
    });
  } finally {
    await new Promise((r) => srv.close(r));
    const ids = Object.values(coach);
    await pool.query(`DELETE FROM yz_legacy_links WHERE seq LIKE '8881%'`).catch(() => {});
    await pool.query(`DELETE FROM admin_enrollments WHERE id LIKE $1`, [`${ORDER}%`]).catch(() => {});
    await pool.query(`DELETE FROM yz_legacy_packages WHERE seq LIKE '8881%'`).catch(() => {});
    await pool.query(`DELETE FROM job_runs WHERE holder_id = $1`, [`t-${T}`]).catch(() => {});
    if (ids.length) await pool.query(`DELETE FROM coaches WHERE id = ANY($1::uuid[])`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM admin_staff WHERE id LIKE $1`, [`LBT${T}%`]).catch(() => {});
    await pool.end();
  }
  if (failures) { console.error(`line_bot_sync_db_test: ${failures} 項失敗`); process.exit(1); }
  console.log('line_bot_sync_db_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
