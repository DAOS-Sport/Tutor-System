'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function route(handler) {
  let post;
  const router = { post: (_path, fn) => { post = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/ragicWebhook.js'), 'utf8'), {
    require: name => name === 'express' ? { Router: () => router } : { handleRagicWebhook: handler },
    module: { exports: {} }, console: { error() {} }, process: { env: { NODE_ENV: 'production', RAGIC_WEBHOOK_SECRET: 'fixture-secret' } },
  });
  return async (authorized = true) => {
    const res = { code: 200, headers: {}, status(n) { this.code = n; return this; }, set(k,v) { this.headers[k]=v;return this; }, json(body) { this.body=body;return this; } };
    await post({ params: { sheetCode: 'Z01' }, body: { id: '42' }, query: {}, get: () => authorized ? 'fixture-secret' : '' }, res);
    return res;
  };
}
test('partial failure returns HTTP 503 and retry hint, never ok true', async () => {
  const r = await route(async () => ({ ok: false, failed: 1, completed: 1, durable: true }))();
  assert.equal(r.code,503);assert.equal(r.body.ok,false);assert.equal(r.headers['Retry-After'],'30');
});
test('completed batch returns HTTP 200', async () => {
  const r=await route(async()=>({ok:true,failed:0}))();assert.equal(r.code,200);assert.equal(r.body.ok,true);
});
test('DB/storage failure is retryable and does not expose raw error', async () => {
  const r=await route(async()=>{throw Error('secret@example.test');})();assert.equal(r.code,503);
  assert.equal(r.body.error,'RAGIC_WEBHOOK_UNAVAILABLE');assert.equal(r.body.ok,false);
});
test('invalid payload is HTTP 400 and unauthenticated requests never process', async () => {
  let calls=0;const invoke=route(async()=>{calls++;throw Object.assign(Error('bad payload'),{code:'RAGIC_WEBHOOK_INVALID'});});
  assert.equal((await invoke()).code,400);assert.equal((await invoke(false)).code,401);assert.equal(calls,1);
});
test('actual handler persists entire batch before processing; rejects invalid source ids', async () => {
  const source=fs.readFileSync(path.join(__dirname,'../services/ragicAdmin.js'),'utf8');
  const start=source.indexOf('async function handleRagicWebhook(');
  const end=source.indexOf('// ───────────────────',start);
  const calls=[];
  const inbox={enqueue:async()=>calls.push('enqueue'),getStates:async()=>[{id:'1',state:'completed'},{id:'2',state:'retryable'}]};
  const context={pool:{},require:()=>inbox,_webhookFormPath:()=>'/fixture',_extractWebhookRecordIds:b=>b.ids,
    retryRagicWebhooks:async()=>calls.push('process')};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const result=await context.handleRagicWebhook('Z01',{ids:['1','2']});
  assert.deepEqual(calls,['enqueue','process']);assert.equal(result.ok,false);assert.equal(result.failed,1);assert.equal(result.durable,true);
  await assert.rejects(context.handleRagicWebhook('Z01',{ids:['[object Object]']}),{code:'RAGIC_WEBHOOK_INVALID'});
  assert.equal(calls.length,2);
});
