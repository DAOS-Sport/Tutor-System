'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseArgs,planJob,run}=require('../../scripts/plan-ragic-outbox-recovery');
const id='11111111-1111-4111-8111-111111111111';
const base={id,operation:'CREATE_Z01_PARENT',state:'blocked_schema',attempts:1,max_attempts:8,
  canonical_parent_id:'parent',canonical_line_uid_valid:true,canonical_students:[],payload_reference:{students:[]}};
test('planner requires exact selectors and has no execute mode',()=>{
  assert.deepEqual(parseArgs([]),[]);assert.deepEqual(parseArgs(['--job',id,'--job',id]),[id]);
  assert.throws(()=>parseArgs(['--execute']));assert.throws(()=>parseArgs(['--job','all']));
});
test('missing fields remain explicit and plans contain no raw personal data',()=>{
  const result=planJob({...base,payload_reference:{students:[{name:'PrivateChild',id_number:'A123',email:'private@example.test'}]}});
  assert.equal(result.category,'PAYLOAD_DATA_INCOMPLETE');assert.deepEqual(result.payload_problems[0].missing_fields,['birth_date','gender']);
  assert.equal(result.payload_problems[0].invalid_id_format,true);assert.equal(result.automatic_replay_allowed,false);
  assert.equal(/PrivateChild|A123|private@example/.test(JSON.stringify(result)),false);
});
test('identity conflict is never downgraded to automatic retry',()=>{
  const r=planJob({...base,last_error_code:'STUDENT_ID_NUMBER_EXISTS'});
  assert.equal(r.category,'IDENTITY_CONFLICT');assert.equal(r.upstream_identity_check,'NOT_RUN');assert.equal(r.automatic_replay_allowed,false);
});
test('actual planner transaction is read-only, ends with rollback and releases client',async()=>{
  const calls=[];let released=false;
  const client={query:async(sql)=>{calls.push(sql);return{rows:[]};},release(){released=true;}};
  const result=await run([],{connect:async()=>client});
  assert.equal(calls[0],'BEGIN READ ONLY');assert.equal(calls.at(-1),'ROLLBACK');
  assert.equal(calls.some(sql=>/\b(INSERT|UPDATE|DELETE)\b/.test(sql)),false);assert.equal(released,true);assert.equal(result.writes_performed,0);
});
