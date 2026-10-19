'use strict';
// 對帳通知信補寄的 feature flag：沒開時不排程、不連 DB、不寄信（部署後行為與現在相同）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schedules = [];
const cronPath = require.resolve('node-cron', { paths: [path.join(__dirname, '../server')] });
require.cache[cronPath] = {
  id: cronPath, filename: cronPath, loaded: true,
  exports: { schedule: (expr, fn, opts) => { schedules.push({ expr, opts }); return { stop() {} }; } },
};
const forbid = (what) => () => { throw new Error(`flag 關閉時不可${what}`); };
for (const [rel, exportsObj] of [
  ['../server/models/db', { pool: { query: forbid('查 DB'), connect: forbid('連 DB') } }],
  ['../server/services/mailer', { sendMail: forbid('寄信') }],
]) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

const sweep = require('../server/services/reconcileMailSweep');
const quiet = (fn) => { const info = console.info; console.info = () => {}; try { return fn(); } finally { console.info = info; } };

assert.equal(quiet(() => sweep.startReconcileMailSweep({})), null);
assert.equal(quiet(() => sweep.startReconcileMailSweep({ RECONCILE_MAIL_SWEEP: '0' })), null);
assert.equal(quiet(() => sweep.startReconcileMailSweep({ RECONCILE_MAIL_SWEEP: 'true' })), null, '只有明確的 1 才算開');
assert.equal(quiet(() => sweep.startReconcileMailSweep({ RECONCILE_MAIL_SWEEP: '1', PREVIEW_SAFE_MODE: '1' })), null, '預覽安全模式一律不排程');
assert.equal(schedules.length, 0, 'flag 關閉時不可註冊任何排程');

assert.ok(quiet(() => sweep.startReconcileMailSweep({ RECONCILE_MAIL_SWEEP: '1' })));
assert.deepEqual(schedules, [{ expr: '*/5 * * * *', opts: { timezone: 'Asia/Taipei' } }]);

// server/index.js 在排程啟動處呼叫；預設由 flag 決定，不另外排程。
const index = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
assert.match(index, /initCronJobs\(\);\s*\n(?:\s*\/\/.*\n)*\s*require\('\.\/services\/reconcileMailSweep'\)\.startReconcileMailSweep\(\);/);
assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../server/cron/index.js'), 'utf8'), /reconcileMailSweep|sweepPendingMail/,
  '凍結的 cron/index.js 不可接補寄');

console.log('PASS 補寄 flag：未設／非 1／預覽模式都不排程、不連 DB、不寄信；設 1 才每 5 分鐘排程');
