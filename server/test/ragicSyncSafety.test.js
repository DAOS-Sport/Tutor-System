'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../services/ragic.js'),'utf8');
function extract(name) { return source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))[0]; }
function load(names, extra = {}) {
  const context = { process:{env:{RAGIC_FORM_Z02:'/fixture/z02'}}, console:{log(){},warn(){}}, ...extra };
  vm.createContext(context);vm.runInContext(names.map(extract).join('\n'),context);return context;
}
test('whole family is validated before parent creation, including malformed ID and duplicate identity', async () => {
  let writes=0;
  const ctx=load(['validateNewSourceStudent','createParentWithStudentsInRagic'],{
    _assertRealLineUidForZ01:uid=>uid, getStudentByIdNumber:async()=>null,
    ragicWriter:{createRecord:async()=>{writes++;}},
  });
  const child={name:'child',birth_date:'2020-01-01',gender:'男',id_number:'A123456789'};
  for(const children of [[child,{...child,birth_date:''}],[{...child,id_number:'A123'}],[child,child]]) {
    await assert.rejects(ctx.createParentWithStudentsInRagic({parent:{phone:'fixture'},lineUid:'fixture',students:children}));
  }
  assert.equal(writes,0);
});
test('existing source student never leads to a second parent or failed lookup treated as absence', async () => {
  for(const lookup of [async()=>({_ragicId:'1'}),async()=>{throw Object.assign(Error('timeout'),{code:'RAGIC_TIMEOUT'});}]){
    let writes=0;
    const ctx=load(['validateNewSourceStudent','createParentWithStudentsInRagic'],{_assertRealLineUidForZ01:uid=>uid,getStudentByIdNumber:lookup,ragicWriter:{createRecord:async()=>{writes++;}}});
    await assert.rejects(ctx.createParentWithStudentsInRagic({parent:{phone:'fixture'},lineUid:'fixture',students:[{name:'child',birth_date:'2020-01-01',gender:'男',id_number:'A123456789'}]}));
    assert.equal(writes,0);
  }
});
test('ambiguous remote ID/code lookups stop before choosing the first record', async () => {
  const ctx=load(['getStudentByIdNumber','getStudentByCode'],{
    FIELD:{Z02:{ID_NUMBER:'id',STUDENT_CODE:'code'}},query:async()=>({1:{_ragicId:'1'},2:{_ragicId:'2'}}),
  });
  await assert.rejects(ctx.getStudentByIdNumber('fixture'),{code:'STUDENT_ID_NUMBER_EXISTS'});
  await assert.rejects(ctx.getStudentByCode('fixture'),{code:'STUDENT_ID_NUMBER_EXISTS'});
});
test('existing student ragicId alias is used for update, never null/create', async () => {
  const writes=[];
  const ctx=load(['upsertZ02ForParentStudent'],{
    FIELD:{Z02:{NAME:'name',PARENT_PHONE:'phone'}},getStudentRecordByRagicId:async()=>({ragicId:'42',name:'child',phone:'fixture'}),
    buildZ02StudentPayload:async()=>({}),upsertStudentStrict:async(payload,id)=>{writes.push(id);return{};},
  });
  const result=await ctx.upsertZ02ForParentStudent({parent:{phone:'fixture'},student:{name:'child',ragic_record_id:'42'}});
  assert.equal(result.ragicRecordId,'42');assert.deepEqual(writes,['42']);
});
test('parent lookup timeout propagates before fallback create or write', async () => {
  let fallback=0;
  const ctx=load(['syncParentProfileStrict'],{
    FIELD:{Z01:{LINE_UID:'uid'}},_assertRealLineUidForZ01:uid=>uid,
    getParentRecordByRagicId:async()=>{throw Object.assign(Error('timeout'),{code:'RAGIC_TIMEOUT'});},
    resolveParentRagicRecord:async()=>{fallback++;},upsertParentStrict:async()=>{fallback++;},
  });
  await assert.rejects(ctx.syncParentProfileStrict({line_uid:'fixture',ragic_record_id:'42'},{}),{code:'RAGIC_TIMEOUT'});assert.equal(fallback,0);
});
