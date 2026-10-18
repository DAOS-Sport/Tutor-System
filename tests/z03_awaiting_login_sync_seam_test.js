'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const archive=require('../server/services/z03ReviewArchive');
const source=fs.readFileSync(require.resolve('../server/services/ragicAdmin'),'utf8');
const start=source.indexOf('async function _upsertZ03Record('),end=source.indexOf('\n// 姓名在 Ragic',start);
const initial=()=>({id:'1',z01_ragic_record_id:'1',status:'resolved',reason_code:archive.REASON,raw_name:'合成家長',venue_raw:'合成馆',phone:'0999999999',identity_raw:'一般',gender_raw:'女',email_raw:'fixture@example.invalid',line_uid_raw:'',students:[{id:'1',source_row_key:'1:0',name_raw:'合成學員',birth_date_raw:'2015/01/01',gender_raw:'女',id_number_raw:'',student_code_raw:'S1',registered_phone_raw:'',classification:'VALID',present_in_latest_payload:true}]});
async function run(changed, conflict=false, reason=archive.REASON){let row={...initial(),reason_code:reason,claim_state:'UNRESOLVED',has_claim:conflict}, updates=[];const client={async query(sql,args=[]){
 if(sql.startsWith('SELECT z.*')){assert.deepEqual(Array.from(args[1]),[archive.REASON,archive.AWAITING_LOGIN_REASON]);return {rows:[{...row,students:undefined}]};}
 if(sql.startsWith('SELECT * FROM ragic_z03_students'))return {rows:row.students.map(s=>({...s}))};
 if(sql.includes('FROM ragic_z03_deleted'))return {rows:[],rowCount:0};
 if(sql.includes('INSERT INTO ragic_z03_records'))return {rows:[{id:'1'}]};
 if(sql.includes('SET present_in_latest_payload = FALSE')){row.students[0].present_in_latest_payload=false;return {rows:[]};}
 if(sql.includes('INSERT INTO ragic_z03_students')){row.students[0]={...row.students[0],birth_date_raw:args[4],present_in_latest_payload:true};return {rows:[]};}
 if(sql.includes("SET status='pending'")){row.status='pending';row.reason_code='SOURCE_CHANGED_AFTER_REVIEW';updates.push('reopened');return {rows:[]};}
 throw new Error(sql);
}};
const rawStudent={...row.students[0],seq_raw:'1',birth_date_raw:changed?'2016/01/01':'2015/01/01'};
const context={require:()=>archive,normalizePhone:x=>x,isCanonicalMobilePhone:x=>/^09\d{8}$/.test(x),normalizeStudentName:x=>x||'',_trueZ01LineUid:()=>'',_pickZ01Raw:()=>'',_sourceUpdatedTime:()=>({iso:'2026-09-29T00:00:00Z',raw:''}),ragic:{parseZ01StudentsRaw:()=>[rawStudent]},_loadZ03RecordById:async()=>row,createParentIdentityBackofficeTask:async()=>{throw Error('unexpected identity write');}};
vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.upsert=_upsertZ03Record;',context);
await context.upsert(client,'1',{phone:row.phone},{});return {row,updates};}
(async()=>{for(const reason of [archive.REASON,archive.AWAITING_LOGIN_REASON]){let same=await run(false,false,reason);assert.equal(same.row.status,'resolved');assert.equal(same.row.reason_code,reason);let changed=await run(true,false,reason);assert.equal(changed.row.status,'pending');assert.equal(changed.row.reason_code,'SOURCE_CHANGED_AFTER_REVIEW');assert.equal((await run(false,true,reason)).row.status,'pending');}
const fstart=source.indexOf('async function findZ03RecordByPhone('),fend=source.indexOf('\n/**',fstart);const fn=source.slice(fstart,fend);assert(fn.includes("status = 'resolved' AND reason_code = 'REVIEWED_OPTIONAL_CONTACT_GAPS'"));assert(fn.includes("status = 'resolved' AND reason_code = 'REVIEWED_AWAITING_PARENT_LOGIN'"));assert(fn.includes('if (r.rowCount > 1)'));assert(fn.includes("err.code = 'MANUAL_REVIEW_REQUIRED'"));
let number=1; const lookup={ normalizePhone: value=>String(value).replace(/\D/g,''), _z03ParentFromRow: row=>({phone:row.phone}),_z03StudentFromRow:row=>({name:row.name_raw}),pool:{async query(sql,args){if(sql.includes('FROM ragic_z03_records')){assert.equal(args[0],'0999999999');return {rows:number?Array.from({length:number},()=>initial()):[],rowCount:number};}return {rows:initial().students};}}};vm.createContext(lookup);vm.runInContext(fn+'\nthis.find=findZ03RecordByPhone;',lookup);
assert.equal((await lookup.find('0999-999-999')).parent.phone,'0999999999');number=2;await assert.rejects(lookup.find('0999999999'),e=>e.code==='MANUAL_REVIEW_REQUIRED');number=0;assert.equal(await lookup.find('0999999999'),null);
console.log(JSON.stringify({environment:'actual source upsert/legacy lookup functions in VM with synthetic SQL/Ragic seams, not PostgreSQL',results:['both policies: same source keeps archive status/reason','both policies: child source change and new claim reopen pending','legacy query admits both review archive reasons','actual legacy lookup canonical phone, absent source and multi-family refusal'],identityAuth:'full claim/login not executed; existing claim service already reads all resolved but applies its identity checks'},null,2));})().catch(e=>{console.error(e);process.exitCode=1;});
