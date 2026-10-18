'use strict';
// Requires a disposable loopback PostgreSQL database. Never falls back to DATABASE_URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('../server/node_modules/pg');
const inbox = require('../server/services/ragicWebhookInbox');
const connectionString = process.env.RAGIC_INBOX_TEST_DATABASE_URL;
if (!connectionString) throw Error('Set RAGIC_INBOX_TEST_DATABASE_URL to a disposable loopback test database');
const url = new URL(connectionString);
if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !/test|audit|regression/i.test(url.pathname)) {
  throw Error('Inbox tests require a loopback database with test/audit/regression in its name');
}
const schema=`ragic_inbox_test_${process.pid}`;
const admin=new Pool({connectionString});
let db;
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  db=new Pool({connectionString,options:`-c search_path=${schema}`});
  const migration=fs.readFileSync(path.join(__dirname,'../db/migrations/056_ragic_webhook_inbox.sql'),'utf8');
  await db.query(migration);await db.query(migration);
  await db.query('CREATE TABLE projection (id text PRIMARY KEY, value text NOT NULL)');
});
after(async()=>{if(db)await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
const project=async(client,job)=>{
  await client.query(`INSERT INTO projection VALUES ($1,'fresh') ON CONFLICT(id) DO UPDATE SET value='fresh'`,[job.ragic_record_id]);
  return {refetched:true};
};
test('partial failure rolls back projection; restart processes durable retry without losing successful record',async()=>{
  await inbox.enqueue(db,'Z01',['1','2'],'update');
  const first=await inbox.processInbox({db,project:async(c,j)=>{
    await project(c,j);if(j.ragic_record_id==='2')throw Object.assign(Error('secret@example.test'),{code:'RAGIC_TIMEOUT'});
  }});
  assert.equal(first.failed,1);assert.deepEqual((await db.query('SELECT id FROM projection ORDER BY id')).rows,[{id:'1'}]);
  const states=await inbox.getStates(db,'Z01',['1','2']);assert.equal(states[1].state,'retryable');assert.equal(states[1].attempts,1);assert.equal(states[1].error,'RAGIC_TIMEOUT');
  await db.end();db=new Pool({connectionString,options:`-c search_path=${schema}`});
  await db.query("UPDATE ragic_webhook_inbox SET next_retry_at=NOW() WHERE ragic_record_id='2'");
  assert.equal((await inbox.processInbox({db,project})).failed,0);
  assert.equal((await inbox.getStates(db,'Z01',['2']))[0].state,'completed');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM projection')).rows[0].n,2);
});
test('redelivery coalesces same record; bounded failures stay blocked on repeated delivery',async()=>{
  await inbox.enqueue(db,'Z01',['3'],'update');
  await db.query("UPDATE ragic_webhook_inbox SET max_attempts=2 WHERE ragic_record_id='3'");
  const fail=()=>inbox.processInbox({db,ids:['3'],project:async()=>{throw Object.assign(Error('timeout'),{code:'RAGIC_TIMEOUT'});}});
  await fail();await inbox.enqueue(db,'Z01',['3'],'update');
  assert.equal((await inbox.getStates(db,'Z01',['3']))[0].attempts,1);
  await db.query("UPDATE ragic_webhook_inbox SET next_retry_at=NOW() WHERE ragic_record_id='3'");await fail();
  await inbox.enqueue(db,'Z01',['3'],'update');
  assert.equal((await inbox.getStates(db,'Z01',['3']))[0].state,'blocked');assert.equal((await fail()).processed,0);
  await inbox.enqueue(db,'Z01',['1'],'update');await inbox.processInbox({db,ids:['1'],project});
  assert.equal((await db.query("SELECT count(*)::int n FROM projection WHERE id='1'")).rows[0].n,1);
});
test('competing worker skips transaction-locked notification; rollback makes it available after crash',async()=>{
  await inbox.enqueue(db,'Z01',['4'],'update');
  const client=await db.connect();
  try{
    await client.query('BEGIN');await client.query("SELECT * FROM ragic_webhook_inbox WHERE ragic_record_id='4' FOR UPDATE");
    assert.equal((await inbox.processInbox({db,ids:['4'],project})).processed,0);
    await client.query('ROLLBACK');
  } finally {client.release();}
  assert.equal((await inbox.processInbox({db,ids:['4'],project})).processed,1);
  assert.equal((await inbox.getStates(db,'Z01',['4']))[0].state,'completed');
});
test('actual Z01/Z02 projector retains failures and restores a returning source record idempotently',async()=>{
  await db.query(`CREATE TABLE ragic_z01_shadow (ragic_record_id text PRIMARY KEY,raw_data jsonb,fetched_at timestamptz,last_seen_at timestamptz,present_in_latest_pull boolean,missing_since timestamptz);
    CREATE TABLE ragic_z02_shadow (LIKE ragic_z01_shadow INCLUDING ALL);
    CREATE TABLE ragic_webhook_log (sheet_code text,ragic_record_id text,event_type text,refetched boolean,latency_ms int,error_message text)`);
  const source=fs.readFileSync(path.join(__dirname,'../server/services/ragicAdmin.js'),'utf8');
  let present=true;
  const context={process:{env:{}},_webhookFormPath:()=>'/fixture',ragic:{
    isCanaryRecord:()=>false,getRecordByRagicId:async(_path,id)=>{
      if(id==='6')throw Object.assign(Error('upstream timeout'),{code:'RAGIC_TIMEOUT'});
      return present?{_ragicId:id,name:'fixture'}:null;
    },
  }};
  vm.createContext(context);
  for(const name of ['_deleteWebhookShadow','_upsertWebhookShadow','_projectWebhookRecord']) {
    vm.runInContext(source.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`))[0],context);
  }
  await inbox.enqueue(db,'Z01',['5','6'],'update');
  const run=()=>inbox.processInbox({db,ids:['5','6'],project:context._projectWebhookRecord});
  assert.equal((await run()).failed,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM ragic_z01_shadow')).rows[0].n,1);
  present=false;await inbox.enqueue(db,'Z01',['5'],'delete');await run();
  assert.equal((await db.query("SELECT present_in_latest_pull present FROM ragic_z01_shadow WHERE ragic_record_id='5'")).rows[0].present,false);
  present=true;await inbox.enqueue(db,'Z01',['5'],'update');await run();
  const restored=(await db.query("SELECT present_in_latest_pull present,missing_since FROM ragic_z01_shadow WHERE ragic_record_id='5'")).rows[0];
  assert.equal(restored.present,true);assert.equal(restored.missing_since,null);
  await inbox.enqueue(db,'Z02',['7'],'update');await inbox.processInbox({db,ids:['7'],project:context._projectWebhookRecord});
  assert.equal((await db.query('SELECT count(*)::int n FROM ragic_z02_shadow')).rows[0].n,1);
});
test('redelivery during a failed projection preserves its failed attempt and latest revision',async()=>{
  await inbox.enqueue(db,'Z01',['8'],'update');
  let entered,finish;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{finish=resolve;});
  const worker=inbox.processInbox({db,ids:['8'],project:async()=>{
    entered();await gate;throw Object.assign(Error('timeout'),{code:'RAGIC_TIMEOUT'});
  }});
  await started;
  const redelivery=inbox.enqueue(db,'Z01',['8'],'update');
  finish();await Promise.all([worker,redelivery]);
  const row=(await db.query("SELECT state,attempts,revision FROM ragic_webhook_inbox WHERE ragic_record_id='8'")).rows[0];
  assert.equal(row.state,'retryable');assert.equal(row.attempts,1);assert.equal(Number(row.revision),2);
});
