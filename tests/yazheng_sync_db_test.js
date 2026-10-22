'use strict';
/**
 * 雅正轉同步（SPEC YZ-A2／YZ-A3）對真的 PostgreSQL（拋棄式測試庫，已跑過 bootstrap）：
 * 查詢欄位、雅正轉標記、分頁不重不漏、推送失敗不前進游標、全量快照分頁。
 * 全部在一個交易裡做，最後 ROLLBACK。時間固定在 2031 年；姓名、電話、發票都是虛構值（公開 repo）。
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');
process.env.DATABASE_URL = url;

const ROOT = path.join(__dirname, '..');
const { pool } = require(path.join(ROOT, 'server/models/db'));
const yz = require(path.join(ROOT, 'server/services/yazhengSync'));

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

const SINCE = '2031-02-01T00:00:00+08:00';
const ENV = { YZ_WEBHOOK_URL: 'https://receiver.invalid/hook', YZ_WEBHOOK_SECRET: 's'.repeat(40) };

/** 假的接收端：記錄每次收到的請求，回應碼由 status 決定。 */
function receiver(status) {
  const got = [];
  const fetchImpl = async (u, init) => {
    got.push({ url: u, headers: init.headers, body: JSON.parse(init.body), raw: init.body });
    return { ok: status >= 200 && status < 300, status };
  };
  return { got, fetchImpl };
}

console.log('yazheng_sync_db_test');

(async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const venue = (await db.query('SELECT id FROM venues ORDER BY id LIMIT 1')).rows[0].id;
    const ins = (id, { phone, notes = null, ext = null, inv = null, at, status = 'confirmed' }) => db.query(
      `INSERT INTO admin_enrollments (id, parent_name, parent_phone, students, coach, venue_id, course_type, original_price,
         final_price, status, submitted_at, total_sessions, used_sessions, notes, external_order_no, invoice_number, created_at, updated_at)
       VALUES ($1, '測試家長', $2, ARRAY['測試學員'], '測試教練', $3, 1, 0, 0, $4, $5, 6, 2, $6, $7, $8, $5, $5)`,
      [id, phone, venue, status, at, notes, ext, inv]);
    await ins('yz-test-1', { phone: '0912-000-101', notes: '雅正轉｜單據序號 99001｜測試', ext: 'ABLEPOS:99001', at: '2031-02-01T10:00:00+08:00' });
    await ins('yz-test-2', { phone: '+886912000202', inv: ' zz00000001 ', at: '2031-02-01T10:00:00+08:00' });
    await ins('yz-test-3', { phone: '0912000303', notes: '一般訂單', at: '2031-02-01T11:00:00+08:00', status: 'refunded' });
    // 正式庫的時間有微秒；Node 讀出來只到毫秒。兩筆落在同一毫秒、id 不同，分頁和預檢都不能重複或卡住。
    await ins('yz-test-4a', { phone: '0912000404', at: '2031-02-01T12:00:00.123456+08:00' });
    await ins('yz-test-4b', { phone: '0912000405', at: '2031-02-01T12:00:00.123999+08:00' });

    await check('YZ-A2 欄位：單據序號、雅正轉標記、發票正規化、電話只給末 4 碼', async () => {
      const { orders, next } = await yz.listOrders({ since: SINCE, db });
      assert.equal(next, null);
      assert.deepEqual(orders.map((o) => o.enrollment_id), ['yz-test-1', 'yz-test-2', 'yz-test-3', 'yz-test-4a', 'yz-test-4b']);
      const [a, b, c] = orders;
      assert.equal(a.legacy_seq, '99001');
      assert.equal(a.yazheng_tag, true);
      assert.equal(b.yazheng_tag, false);
      assert.equal(b.legacy_seq, null);
      assert.equal(b.invoice_number, 'ZZ00000001');
      assert.deepEqual(orders.map((o) => o.parent_phone_last4), ['0101', '0202', '0303', '0404', '0405']);
      assert.equal(c.status, 'refunded');
      assert.ok(!/09\d{8}/.test(JSON.stringify(orders)), '輸出不可出現完整手機號碼');
      assert.ok(!JSON.stringify(orders).includes('測試家長'), '輸出不可出現姓名');
    });

    await check('YZ-A2 分頁：一頁一筆，接起來不重複、不漏、最後 next=null', async () => {
      const seen = [];
      let after = null;
      for (let i = 0; i < 10; i += 1) {
        const { orders, next } = await yz.listOrders({ since: SINCE, after, limit: 1, db });
        seen.push(...orders.map((o) => o.enrollment_id));
        if (!next) break;
        after = yz.decodeCursor(next);
      }
      assert.deepEqual(seen, ['yz-test-1', 'yz-test-2', 'yz-test-3', 'yz-test-4a', 'yz-test-4b']);
    });

    await check('YZ-A3 沒設定就不推送', async () => {
      const r = receiver(200);
      assert.deepEqual(await yz.pushChanges({ db, env: {}, fetchImpl: r.fetchImpl }), { skipped: 'not_configured' });
      assert.equal(r.got.length, 0);
    });

    // 從 2031 的訂單開始推：把游標設在測試資料之前（模擬上一輪已推到 2031-02-01 09:00）。
    await db.query(
      `INSERT INTO job_runs (id, job_name, holder_id, status, triggered_by, started_at, finished_at, result_summary)
       VALUES (gen_random_uuid(), $1, 'yz-test', 'success', 'cron', NOW() + interval '1 day', NOW() + interval '1 day', $2::jsonb)`,
      [yz.CHANGE_JOB, JSON.stringify({ cursor: yz.encodeCursor({ changed_at: '2031-02-01T01:00:00.000Z', enrollment_id: '' }) })]);

    await check('YZ-A3 對方回 500 → 丟錯（游標不前進，下一輪重送）', async () => {
      const before = await yz.readChangeCursor(db);
      const r = receiver(500);
      await assert.rejects(yz.pushChanges({ db, env: ENV, fetchImpl: r.fetchImpl }), /webhook HTTP 500/);
      assert.equal(r.got.length, 1);
      assert.equal(await yz.readChangeCursor(db), before);
    });

    await check('YZ-A3 對方回 200 → 推出變動、簽章驗得過、回傳新游標', async () => {
      const r = receiver(200);
      const res = await yz.pushChanges({ db, env: ENV, fetchImpl: r.fetchImpl });
      assert.equal(r.got.length, 1);
      const { headers, body, raw } = r.got[0];
      assert.equal(body.type, 'changes');
      assert.deepEqual(body.orders.map((o) => o.enrollment_id), ['yz-test-1', 'yz-test-2', 'yz-test-3', 'yz-test-4a', 'yz-test-4b']);
      assert.equal(headers['X-YZ-Event-Id'], body.event_id);
      assert.equal(headers['X-YZ-Signature'], yz.sign(ENV.YZ_WEBHOOK_SECRET, headers['X-YZ-Timestamp'], raw));
      assert.equal(res.sent, 5);
      assert.deepEqual(yz.decodeCursor(res.cursor), { at: '2031-02-01T04:00:00.123Z', id: 'yz-test-4b' });
    });

    await check('YZ-A3 預檢：游標之後有變動 → true；游標已在最後一筆 → false（不因重疊視窗永遠為真）', async () => {
      assert.equal(await yz.hasChanges(db), true);
      const last = (await yz.listOrders({ db, limit: 1000 })).orders.at(-1);
      await db.query(
        `INSERT INTO job_runs (id, job_name, holder_id, status, triggered_by, started_at, finished_at, result_summary)
         VALUES (gen_random_uuid(), $1, 'yz-test', 'success', 'cron', NOW() + interval '2 day', NOW() + interval '2 day', $2::jsonb)`,
        [yz.CHANGE_JOB, JSON.stringify({ cursor: yz.encodeCursor(last) })]);
      assert.equal(await yz.hasChanges(db), false);
    });

    await check('YZ-A3 全量快照：分頁送出、snapshot_id 相同、只有最後一頁 is_last', async () => {
      const r = receiver(200);
      const total = Number((await db.query('SELECT count(*) FROM admin_enrollments')).rows[0].count);
      const res = await yz.pushSnapshot({ db, env: ENV, fetchImpl: r.fetchImpl });
      assert.equal(res.orders, total);
      assert.equal(new Set(r.got.map((g) => g.body.snapshot_id)).size, 1);
      assert.deepEqual(r.got.map((g) => g.body.is_last), r.got.map((_, i) => i === r.got.length - 1));
      const ids = r.got.flatMap((g) => g.body.orders.map((o) => o.enrollment_id));
      assert.equal(new Set(ids).size, total);
    });
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    db.release();
    await pool.end();
  }
  if (failures) { console.error(`yazheng_sync_db_test: ${failures} 項失敗`); process.exit(1); }
  console.log('yazheng_sync_db_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
