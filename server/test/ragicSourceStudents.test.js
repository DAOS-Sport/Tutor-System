const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const schema = require('../config/ragicSchema');
const source = fs.readFileSync(path.join(__dirname, '../services/ragic.js'), 'utf8');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function fixture({ timeout=false, missingCode=false, conflict=false, readError=false }={}) {
  const F=schema.FIELD; const rows=[];let writes=0; let remote=null;
  const parent={phone:'test-phone',line_uid:'Utest'};
  const student={name:'test-child',id_number:'A123456789',birth_date:'2020-01-01',gender:'female'};
  const ctx={ FIELD:F, process:{env:{RAGIC_FORM_Z01:'/source'}},
    _recordPath:(p,id)=>`${p}/${id}`, _cacheInvalidate:()=>{},
    _toPhysGender:()=> '生理女',formatRagicDate:s=>s.replaceAll('-','/'),
    getParentRecordByRagicId:async()=>({[F.Z01.PHONE]:parent.phone,[F.Z01.LINE_UID]:parent.line_uid}),
    parseZ01Students:()=> rows,
    getStudentByIdNumber:async()=>{if(readError)throw Object.assign(Error('timeout'),{code:'RAGIC_TIMEOUT'});return conflict?{[F.Z02.NAME]:'other',[F.Z02.PARENT_PHONE]:'other'}:remote;},
    ragicWriter:{postFormPath:async(p,payload,meta)=>{
      writes++; assert.equal(p,'/source/42'); assert.equal(meta.params.doFormula,true);
      assert.equal(meta.params.checkLock,true); assert.equal(meta.params.doValidation,true);
      assert.equal(payload[`${F.Z01_STUDENT.NAME}_-1`],student.name);
      assert.equal(Object.keys(payload).some(k=>k.startsWith(F.Z01_STUDENT.STUDENT_CODE+'_')),false);
      rows.push({name:student.name,id_number:student.id_number,student_code:missingCode?'':'server-generated',row_key:'99'});
      remote={_ragicId:'99',[F.Z02.NAME]:student.name,[F.Z02.PARENT_PHONE]:parent.phone,[F.Z02.STUDENT_CODE]:missingCode?'':'server-generated'};
      if(timeout){timeout=false;throw Object.assign(Error('timeout'),{code:'RAGIC_TIMEOUT'});}
    }},
  };
  vm.createContext(ctx);
  vm.runInContext(extract('function buildZ01StudentPayload(', 'async function getParentRecordByRagicId')+extract('async function syncParentStudentsStrict(', '// Append new source rows'),ctx);
  return {run:()=>ctx.syncParentStudentsStrict({parent,students:[student],ragicRecordId:'42'}),writes:()=>writes,student};
}
test('source append calculates upstream code and retry does not append twice',async()=>{
 const f=fixture();assert.equal((await f.run()).studentRecordIds[0],'99');await f.run();assert.equal(f.writes(),1);
});
test('timeout after commit reconciles without duplicating source rows',async()=>{
 const f=fixture({timeout:true});await assert.rejects(f.run(),{code:'RAGIC_TIMEOUT'});assert.equal((await f.run()).studentCodes[0],'server-generated');assert.equal(f.writes(),1);
});
test('missing computed code never reports sync success',async()=>{const f=fixture({missingCode:true});await assert.rejects(f.run(),{code:'RAGIC_UNCONFIRMED_WRITE'});});
test('foreign identity and failed duplicate checks never create',async()=>{
 for(const option of [{conflict:true},{readError:true}]){const f=fixture(option);await assert.rejects(f.run());assert.equal(f.writes(),0);}
});
test('missing identity never appends an undeduplicatable row',async()=>{const f=fixture();f.student.id_number='';await assert.rejects(f.run(),{code:'RAGIC_VALIDATION_ERROR'});assert.equal(f.writes(),0);});

test('writer sends row fields as form data and retains field allowlist',async()=>{
 const {createWriter}=require('../services/ragicWriter');let calls=0;
 const writer=createWriter({http:{post:async(url,body,options)=>{calls++;assert.equal(options.headers['Content-Type'],'application/x-www-form-urlencoded');assert.equal(new URLSearchParams(body).get('1001115_-1'),'test-child');return {data:{status:'SUCCESS'}};}},audit:async()=>{},alert:async()=>{}});
 await writer.postFormPath(process.env.RAGIC_FORM_Z01,{'1001115_-1':'test-child'},{skipOldRead:true});
 await assert.rejects(writer.postFormPath(process.env.RAGIC_FORM_Z01,{'99999999_-1':'bad'},{skipOldRead:true}));assert.equal(calls,1);
});
