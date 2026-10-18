'use strict';
const assert = require('assert/strict');
const archive = require('../server/services/z03ReviewArchive');
const clone = x => JSON.parse(JSON.stringify(x));
const fixture = id => ({id:String(id),z01_ragic_record_id:String(id),status:'pending',reason_code:'TRUE_LINE_UID_EMPTY',claim_state:'UNRESOLVED',phone:`09${String(id).padStart(8,'0')}`,raw_name:'',venue_raw:'待補登',identity_raw:'',gender_raw:'',email_raw:'',line_uid_raw:'',students:[]});
let rows = [fixture(1),fixture(2)], snapshot, writes=0;
const pool = {connect:async()=>pool,release(){},async query(sql,args=[]){
  if(sql.startsWith('BEGIN')){snapshot=clone(rows);return {rows:[]};}
  if(sql==='COMMIT')return {rows:[]};
  if(sql==='ROLLBACK'){rows=snapshot;return {rows:[]};}
  if(sql.startsWith('SELECT z.*'))return {rows:clone(rows.filter(r=>args[0]?args[0].includes(r.id):r.status==='pending')).map(({students,...row})=>row)};
  if(sql.startsWith('SELECT * FROM ragic_z03_students'))return {rows:clone(rows.filter(r=>args[0].includes(r.id)).flatMap(r=>r.students))};
  if(sql==='SELECT id, phone FROM ragic_z03_records')return {rows:rows.map(r=>({id:r.id,phone:r.phone}))};
  if(sql.startsWith('UPDATE ragic_z03_records')){writes++;for(const row of rows.filter(r=>args[0].includes(r.id))){row.status='resolved';row.reason_code=args[1];row.resolved_by=args[2];}return {rows:[]};}
  throw Error('Unexpected query in synthetic fixture');
}};
(async()=>{
  assert.equal(typeof archive.classifyAwaitingLogin,'function','RED: missing waiting-login policy for incomplete unlogged-in data');
  assert.equal(archive.classify(fixture(1)).eligible,false,'original complete-review contract remains strict');
  assert.equal(archive.classifyAwaitingLogin(fixture(1)).eligible,true);
  const boundaries=[{line_uid_raw:'U'},{status:'manual_review'},{reason_code:'AMBIGUOUS_STUDENT_MATCH'},{has_claim:true},{has_link:true},{has_tombstone:true},{last_error_code:'DUPLICATE_PARENT_IDENTITY'},{canonical_parent_id:'1'},{claim_state:'SYNCED'},{phone:'bad'},{duplicate_phone:true}];
  for(const patch of boundaries)assert.equal(archive.classifyAwaitingLogin({...fixture(1),...patch}).eligible,false,JSON.stringify(patch));
  const service=archive.createArchiveService(pool), pre=await service.preview(archive.AWAITING_LOGIN_REASON);
  assert.equal(pre.reviewed,2);assert.equal(pre.candidates.length,2);assert.equal(pre.policy,'REVIEWED_AWAITING_PARENT_LOGIN');assert(!JSON.stringify(pre).includes(rows[0].phone));
  const before=clone(rows), applied=await service.apply(pre.candidates,'synthetic-admin',pre.policy);
  assert.equal(applied.identity_activated,false);assert.equal(applied.archived.length,2);
  rows.forEach((r,i)=>{const {status,reason_code,resolved_by,...now}=r;const {status:a,reason_code:b,...old}=before[i];assert.deepEqual(now,old);});
  assert.equal((await service.apply(pre.candidates,'synthetic-admin',pre.policy)).already_archived.length,2);assert.equal(writes,1);
  rows=[fixture(1),fixture(2)];const stale=await service.preview(archive.AWAITING_LOGIN_REASON);rows[1].phone='bad';
  await assert.rejects(service.apply(stale.candidates,'synthetic-admin',stale.policy),e=>e.status===409);assert(rows.every(r=>r.status==='pending'));
  rows=[fixture(1),{...fixture(2),phone:fixture(1).phone}];assert.equal((await service.preview(archive.AWAITING_LOGIN_REASON)).candidates.length,0,'all rows used for duplicate check');
  await assert.rejects(service.preview('arbitrary-policy'),e=>e.status===400);
  console.log(JSON.stringify({environment:'synthetic service fixture; no live writes',results:['incomplete blank-UID records wait for parent login','strict old policy preserved','11 identity/phone/manual-review boundaries refused','source fields unchanged','idempotence and stale whole-batch rollback','duplicate phone across rows excluded','unknown policy rejected'],policy:pre.policy},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
