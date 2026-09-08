const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const freshness = require('../server/services/ragicFreshness');
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
 const service = fs.readFileSync('server/services/ragic.js','utf8');
 assert.ok(!service.includes('runCanaryWriteReadProof'));
 assert.ok(!service.includes('_writeCanaryNonce'));
 const begin = service.indexOf('async function queryAllPagedWithIntegrity(');
 const end = service.indexOf('async function getRecordByRagicId', begin);
 const source = service.slice(begin,end)+'; queryAllPagedWithIntegrity';
 const makePage = ids => Object.fromEntries(ids.map(id=>[String(id),{_ragicId:id}]));
 const scan = (first, second, max=3) => vm.runInNewContext(source, {
  RAGIC_PAGE_SIZE:2, RAGIC_MAX_PAGES:max,
  query:async (_form, params) => {
   const page=(params.fetchDomainIds ? second : first)[params.offset / 2];
   if(page instanceof Error) throw page;
   return page;
  }
 })('/test');
 const complete=[makePage([1,2]),makePage([3])];
 assert.equal((await scan(complete,complete)).boundaryMismatch,false);
 assert.equal((await scan(complete,[makePage([1,2]),makePage([4])])).boundaryMismatch,true);
 assert.equal((await scan([makePage([1,2]),makePage([2])],[])).boundaryMismatch,true);
 assert.equal((await scan([makePage([1,2])],[],1)).truncated,true);
 await assert.rejects(scan([null],[]),e=>e.code==='RAGIC_INVALID_PAGE');
 await assert.rejects(scan([{'1':{_ragicId:2}}],[]),e=>e.code==='RAGIC_INVALID_RECORD_ID');
 await assert.rejects(scan(complete,[new Error('verification offline')]),/verification offline/);
 await assert.rejects(writer.writeField('H05','999','1003917','nonce'),e=>e.code==='RAGIC_FIELD_NOT_WRITABLE');
 assert.equal(posts,0);
 const admin = fs.readFileSync('server/services/ragicAdmin.js','utf8');
 const shadowSource=admin.slice(admin.indexOf('async function _shadowPullZ01Impl'),admin.indexOf('async function _readShadowZ01'))+'; _shadowPullZ01Impl';
 for (const failStudent of [false,true]) {
  const commands=[];
  const parentRows=[{_ragicId:'1'}],studentRows=[{_ragicId:'2'}];
  const client={release(){},query:async(sql)=>{
   commands.push(sql);
   if(failStudent && sql.includes('INSERT INTO ragic_z02_shadow')) throw new Error('student storage unavailable');
   return {rows:[{n:1}]};
  }};
  const pull=vm.runInNewContext(shadowSource,{
   process:{env:{RAGIC_FORM_Z02:'/z02'}},pool:{connect:async()=>client},ragicEnabled:()=>true,
   ragic:{getAllParentsWithIntegrityAndFreshness:async()=>({records:parentRows,freshness:{}}),
    queryAllPagedWithIntegrityAndFreshness:async()=>({records:studentRows}),isCanaryRecord:()=>false},
   _fetchZ01ByFieldId:async()=>parentRows,_checkZ01IntegrityGate:async()=>null,
   _alertFreshnessIfNeeded:async()=>{},_withFreshness:r=>r
  });
  const result=await pull();
  assert.equal(commands.includes('COMMIT'),!failStudent);
  assert.equal(commands.includes('ROLLBACK'),failStudent);
  assert.equal(result.synced,failStudent?0:1);
  if(!failStudent) assert.equal(result.z02_shadow_count,1);
 }
 console.log('PASS full source ID checks, failed-page rejection, validation messages, Taipei schedule, no Canary writes');
 process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
