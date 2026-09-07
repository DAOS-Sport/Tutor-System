/**
 * outbox 毒資料守門：_markFailure 自己炸掉時，該筆要被隔離、不能拖垮整批
 *
 * 由來：2026-09-07 正式站 2 筆 CREATE_Z01_PARENT 卡在 processing、attempts 56/45、
 * last_error_code 全空。機制：_claimNextJob 每晚回收 15 分鐘前的 processing 列 → 進每筆 catch
 * → _markFailure 在交易裡拋 22P02 → rollback（錯誤碼永遠空）→ 錯誤從 catch 裡再往上炸
 * → cron 迴圈 break → 當晚其餘 pending 全部沒處理。一筆壞資料把佇列拖了 45 天，
 * log 只有一行 "failed: 22P02"。dev 用同型假資料重現不出來 —— 所以修法是讓它自報家門並隔離。
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { _markFailureOrQuarantine } = require(path.join(__dirname, '..', 'server/services/ragicSyncOutbox.js'));

let failures = 0;
function check(label, fn) {
  return Promise.resolve().then(fn).then(
    () => console.log('  ok  ' + label),
    (e) => { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
  );
}
function fakeDb() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
}
const job = { id: 'job-1', operation: 'CREATE_Z01_PARENT', source_record_id: 'PENDING:' + 'x'.repeat(64) };
const ragicErr = Object.assign(new Error('Ragic INVALID 202: 欄位 (報)Email 為必填'), { code: 'RAGIC_VALIDATION_ERROR' });
const pgErr = Object.assign(new Error('invalid input syntax for type uuid: "PENDING:xxx"'), {
  code: '22P02', where: 'unnamed portal parameter $1', table: 'some_table', column: 'some_col',
});

(async () => {
  await check('守門本身有匯出（掃描有效）', () => {
    assert.strictEqual(typeof _markFailureOrQuarantine, 'function');
  });

  await check('_markFailure 正常時：直接透傳，不多打任何 UPDATE', async () => {
    const db = fakeDb();
    const r = await _markFailureOrQuarantine(job, ragicErr, {
      markFailure: async () => ({ outboxState: 'blocked_schema', claimState: 'SYNC_BLOCKED_SCHEMA', code: 'RAGIC_VALIDATION_ERROR' }),
      db,
    });
    assert.strictEqual(r.outboxState, 'blocked_schema');
    assert.strictEqual(db.calls.length, 0, '正常路徑不該有額外 UPDATE（零改動）');
  });

  await check('_markFailure 拋 22P02 時：隔離成 blocked、記 DB_22P02、不往上炸', async () => {
    const db = fakeDb();
    const origErr = console.error; const logged = [];
    console.error = (...a) => logged.push(a.map(String).join(' '));
    let r;
    try {
      r = await _markFailureOrQuarantine(job, ragicErr, { markFailure: async () => { throw pgErr; }, db });
    } finally { console.error = origErr; }
    assert.ok(r && r.quarantined === true, '沒有回傳 quarantined');
    assert.strictEqual(r.outboxState, 'blocked_data_conflict');
    assert.strictEqual(r.code, 'DB_22P02');
    assert.strictEqual(db.calls.length, 1, '應該恰好一句隔離 UPDATE');
    const { sql, params } = db.calls[0];
    assert.ok(/UPDATE ragic_sync_outbox/.test(sql) && /state='blocked_data_conflict'/.test(sql), '隔離 UPDATE 形狀不對：' + sql.slice(0, 80));
    assert.ok(!/::(uuid|int|interval)/.test(sql), '隔離 UPDATE 不可以做任何轉型 —— 那正是它要繞開的坑');
    assert.deepStrictEqual(params[0], job.id);
    assert.strictEqual(params[1], 'DB_22P02');
    assert.ok(JSON.parse(params[2]).origin.includes('RAGIC_VALIDATION_ERROR'), '要保留原始錯誤碼，方便事後對照');
  });

  await check('隔離時把 pg 的 where/table/column/detail 整段印出來（毒資料要自報家門）', async () => {
    const db = fakeDb();
    const origErr = console.error; const logged = [];
    console.error = (...a) => logged.push(a.map(String).join(' '));
    try { await _markFailureOrQuarantine(job, ragicErr, { markFailure: async () => { throw pgErr; }, db }); }
    finally { console.error = origErr; }
    const text = logged.join('\n');
    for (const needle of ['22P02', 'unnamed portal parameter', 'some_table', 'some_col', 'job-1', 'CREATE_Z01_PARENT']) {
      assert.ok(text.includes(needle), 'log 缺少 ' + needle + '：\n' + text.slice(0, 300));
    }
  });

  await check('隔離 UPDATE 也失敗時才往上丟（資料庫真掛了不是這條要吞的）', async () => {
    const db = { query: async () => { throw Object.assign(new Error('connection lost'), { code: '57P01' }); } };
    const origErr = console.error; console.error = () => {};
    let thrown = null;
    try { await _markFailureOrQuarantine(job, ragicErr, { markFailure: async () => { throw pgErr; }, db }); }
    catch (e) { thrown = e; } finally { console.error = origErr; }
    assert.ok(thrown && thrown.code === '57P01', '應該把隔離失敗的錯誤往上丟');
  });

  await check('每筆 catch 已改走守門，cron 批次層會印 where/table', () => {
    const fs = require('fs');
    const ob = fs.readFileSync(path.join(__dirname, '..', 'server/services/ragicSyncOutbox.js'), 'utf8');
    assert.ok(/const failure = await _markFailureOrQuarantine\(job, err\);/.test(ob), '每筆 catch 沒有改走 _markFailureOrQuarantine');
    assert.ok(!/const failure = await _markFailure\(job, err\);/.test(ob), '還有直接呼叫 _markFailure 的 catch —— 那條會再次拖垮整批');
    const cron = fs.readFileSync(path.join(__dirname, '..', 'server/cron/index.js'), 'utf8');
    assert.ok(/\[Cron\/RagicOutbox\] failed:[\s\S]{0,200}err\.where/.test(cron), 'cron 批次層沒有印 err.where');
  });

  console.log(failures ? '\n' + failures + ' FAILED' : '\noutbox_poison_guard: ALL PASS');
  process.exitCode = failures ? 1 : 0;
})();
