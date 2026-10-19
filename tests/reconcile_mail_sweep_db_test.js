'use strict';
// 對帳通知信補寄（sweepPendingMail）：真 PostgreSQL（拋棄式測試庫），mailer 換成假的。
// 用兩個獨立連線池模擬兩台機器同時補寄；只用 sweeptest_ 前綴的 ref_id，結束全刪。
const assert = require('node:assert/strict');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const target = new URL(url);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && /test|audit/.test(target.pathname),
  'disposable loopback test DB required');
process.env.DATABASE_URL = url;

// 假 mailer：依 recipient 決定結果，並記錄每封被交給 mailer 幾次。
const sends = new Map();
const outcome = new Map();
const mailerPath = require.resolve('../server/services/mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    sendMail: async ({ to }) => {
      sends.set(to, (sends.get(to) || 0) + 1);
      await new Promise((r) => setTimeout(r, 80));
      const o = outcome.get(to) || 'sent';
      if (o === 'throw') throw new Error('smtp exploded');
      return { status: o, reason: o === 'sent' ? null : `fake ${o}` };
    },
  },
};

const { Pool } = require(path.join(__dirname, '../server/node_modules/pg'));
const { pool } = require('../server/models/db');
const { sweepPendingMail, SWEEP_MAX_ATTEMPTS, KIND } = require('../server/services/reconcileNotify');

const PREFIX = `sweeptest_${Date.now().toString(36)}_`;
let passed = 0;
const ok = (label) => { passed += 1; console.log('  PASS ' + label); };

async function insert(ref, { status = 'pending', ageMin = 10, updatedAgeMin = ageMin, attempts = 0 } = {}) {
  const r = await pool.query(
    `INSERT INTO mail_outbox (kind, ref_id, recipient, subject, payload, status, attempts, created_at, updated_at)
     VALUES ($1, $2, $3, 's', $4::jsonb, $5, $6, NOW() - ($7 || ' minutes')::interval, NOW() - ($8 || ' minutes')::interval)
     RETURNING id`,
    [KIND, PREFIX + ref, `${PREFIX}${ref}@example.invalid`, JSON.stringify({ parentName: '合成家長', venueName: '合成館', orders: [] }),
      status, attempts, String(ageMin), String(updatedAgeMin)]
  );
  return r.rows[0].id;
}
const rowOf = async (id) => (await pool.query('SELECT status, attempts, sent_at, reason FROM mail_outbox WHERE id = $1', [id])).rows[0];
const to = (ref) => `${PREFIX}${ref}@example.invalid`;

(async () => {
  const machineA = new Pool({ connectionString: url, max: 2 });
  const machineB = new Pool({ connectionString: url, max: 2 });
  try {
    // 1. 兩台同時補寄：每封只寄一次
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push(await insert(`c${i}`));
    const fresh = await insert('fresh', { ageMin: 0 });
    const [a, b] = await Promise.all([
      sweepPendingMail({ db: machineA, limit: 50 }),
      sweepPendingMail({ db: machineB, limit: 50 }),
    ]);
    for (let i = 0; i < 6; i += 1) assert.equal(sends.get(to(`c${i}`)), 1, `c${i} 必須剛好寄一次`);
    assert.equal(a.sent + b.sent, 6);
    for (const id of ids) {
      const r = await rowOf(id);
      assert.equal(r.status, 'sent'); assert.equal(r.attempts, 1); assert.ok(r.sent_at);
    }
    ok('兩台同時補寄：6 封各只寄一次、全部標 sent');

    const f = await rowOf(fresh);
    assert.deepEqual([f.status, f.attempts, sends.has(to('fresh'))], ['pending', 0, false]);
    ok('剛建立的信（未滿 5 分鐘）不補，留給對帳當下的寄送');

    // 2. 寄送失敗留在待寄，不會被標成 sent
    outcome.set(to('fail'), 'failed');
    outcome.set(to('boom'), 'throw');
    const failId = await insert('fail');
    const boomId = await insert('boom');
    await sweepPendingMail({ limit: 50 });
    for (const id of [failId, boomId]) {
      const r = await rowOf(id);
      assert.equal(r.status, 'pending', '失敗必須退回 pending');
      assert.equal(r.attempts, 1);
      assert.equal(r.sent_at, null);
      assert.ok(r.reason);
    }
    ok('SMTP 回失敗或丟例外：退回 pending、次數 +1、沒有 sent_at');

    // 3. 失敗到上限才標 failed（不無限重寄）
    outcome.set(to('cap'), 'failed');
    const capId = await insert('cap', { attempts: SWEEP_MAX_ATTEMPTS - 1 });
    await sweepPendingMail({ limit: 50 });
    assert.deepEqual([(await rowOf(capId)).status, (await rowOf(capId)).attempts], ['failed', SWEEP_MAX_ATTEMPTS]);
    ok(`連續失敗到 ${SWEEP_MAX_ATTEMPTS} 次才標 failed`);

    // 4. dry_run／skipped 照實記錄，不當成寄出也不重試
    outcome.set(to('dry'), 'dry_run');
    outcome.set(to('skip'), 'skipped');
    const dryId = await insert('dry');
    const skipId = await insert('skip');
    await sweepPendingMail({ limit: 50 });
    assert.equal((await rowOf(dryId)).status, 'dry_run');
    assert.equal((await rowOf(skipId)).status, 'skipped');
    ok('dry_run／skipped 照實記錄');

    // 5. 寄到一半掛掉的（停在 sending 超過租約）會被重新認領；剛認領的不動
    const staleId = await insert('stale', { status: 'sending', updatedAgeMin: 30 });
    const busyId = await insert('busy', { status: 'sending', updatedAgeMin: 1 });
    await sweepPendingMail({ limit: 50 });
    assert.equal((await rowOf(staleId)).status, 'sent');
    assert.deepEqual([(await rowOf(busyId)).status, sends.has(to('busy'))], ['sending', false]);
    ok('sending 超過租約重新認領；租約內的不碰');

    console.log(`reconcile_mail_sweep_db: ${passed} PASS`);
  } finally {
    await pool.query('DELETE FROM mail_outbox WHERE ref_id LIKE $1', [PREFIX + '%']).catch(() => {});
    await Promise.all([machineA.end(), machineB.end(), pool.end()]).catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
