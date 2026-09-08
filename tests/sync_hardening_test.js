const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const freshness = require('../server/services/ragicFreshness');
for (const name of ['姓名', '部門名稱', '家長姓名']) {
  assert.equal(freshness.filterCanaryRecords([{_ragicId:1,[name]:'ZZ-CANARY'},{_ragicId:2,[name]:'正常資料'}], 'H01', {}).length, 1);
}
const src = fs.readFileSync('client/liff/src/pages/RegisterPage.jsx','utf8');
const errorMessage = vm.runInNewContext(src.slice(src.indexOf('function registerErrorMessage'),src.indexOf('function publicErrorCode'))+'; registerErrorMessage');
assert.match(errorMessage({response:{status:400,data:{code:'STUDENT_NAME_REQUIRED'}}}),/姓名/);
assert.match(errorMessage({response:{status:400,data:{code:'RAGIC_VALIDATION_ERROR'}}}),/未通過檢查/);
assert.match(errorMessage({response:{status:503,data:{code:'RAGIC_TIMEOUT'}}}),/回應較慢/);
assert.doesNotMatch(errorMessage({response:{status:409,data:{code:'STUDENT_ID_NUMBER_EXISTS'}}}),/補填|已保留/);
const cronSrc = fs.readFileSync('server/cron/index.js','utf8');
const jobs=[];
const quiet = new Proxy({}, {get:()=>()=>{}});
const fakeRequire = name => name==='node-cron' ? {schedule:(expression,fn,options)=>jobs.push({expression,options})} : quiet;
vm.runInNewContext(cronSrc+'; initCronJobs()', {require:fakeRequire,module:{exports:{}},process:{env:{}},console:{log(){}}});
for(const expression of ['30 0 * * *','30 2 * * *','45 2 * * *','30 3 * * *']) assert.equal(jobs.filter(j=>j.expression===expression).length,1);
assert.ok(!jobs.some(j=>j.expression==='*/10 * * * *'));
assert.ok(jobs.every(j=>j.options.timezone==='Asia/Taipei'));
process.env.RAGIC_FORM_H05 = '/h05';
process.env.RAGIC_CANARY_H05_NONCE_FIELD_ID='1003917';
process.env.RAGIC_CANARY_H05_RECORD_ID='999';
const {createWriter}=require('../server/services/ragicWriter');
let posts=0;
const writer=createWriter({http:{post:async()=>{posts++;return {data:{status:'SUCCESS'}}}},audit:async()=>{},alert:async()=>{}});
(async()=>{
 const admin = fs.readFileSync('server/services/ragicAdmin.js','utf8');
 const begin = admin.indexOf('async function _fetchZ01ByFieldId(');
 const end = admin.indexOf('async function _shadowPullZ01Impl', begin);
 const rows=[{_ragicId:1,'1001101':'Normal'},{_ragicId:999,'1001101':'ZZ-CANARY'}];
 const load=vm.runInNewContext(admin.slice(begin,end)+'; _fetchZ01ByFieldId', {
  process:{env:{}}, FORMS:{Z01:'/z01'},
  ragic:{fetchPage:async()=>({rows,count:2}),filterCanaryRecords:(r,s)=>freshness.filterCanaryRecords(r,s,{RAGIC_CANARY_Z01_RECORD_ID:'999'})}
 });
 assert.deepEqual(Array.from(await load(),r=>r._ragicId),[1]);
 await assert.rejects(writer.writeField('H05','998','1003917','nonce'),e=>e.code==='RAGIC_CANARY_RECORD_MISMATCH');
 assert.equal(posts,0);
 await writer.writeField('H05','999','1003917','nonce');
 assert.equal(posts,1);
 console.log('PASS dedicated canary isolation, validation messages, Taipei schedule and nonce target guard');
 process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
