'use strict';
// Operator-only, before the safe app starts. Never imported by normal entry.
const crypto=require('node:crypto');
const ACTOR='codex-preview-controls057-20260930';
const FAMILY_NAME='DEMO057 合成家庭（保留展示）';
const ROWS=[
 {id:'7e570001-2026-4930-8057-000000000001',name:'DEMO057 合成擁有者',phone:'0999005701',email:'demo057-owner-20260930@example.invalid'},
 {id:'7e570001-2026-4930-8057-000000000002',name:'DEMO057 合成成員',phone:'0999005702',email:'demo057-member-20260930@example.invalid'},
].map(r=>({...r,uid:'U'+crypto.createHash('sha256').update('SYNTHETIC_ONLY_'+r.id).digest('hex').slice(0,32)}));
const fail=code=>{throw Object.assign(new Error(),{code});};
function validateExisting(parents,families,members){
 if(parents.length!==2 || families.length!==1 || members.length!==2)fail('EXISTING_FIXTURE_INCOMPLETE');
 for(const want of ROWS){const p=parents.find(p=>p.id===want.id);if(!p || p.name!==want.name || p.phone!==want.phone || p.email!==want.email || p.line_uid!==want.uid || p.primary_venue_id!=='AC' || p.is_active!==true)fail('EXISTING_FIXTURE_IDENTITY_MISMATCH');}
 const f=families[0];if(f.owner_parent_id!==ROWS[0].id || f.name!==FAMILY_NAME || f.created_by!==ACTOR || f.status!=='active')fail('EXISTING_FIXTURE_FAMILY_MISMATCH');
 for(let i=0;i<ROWS.length;i++){const m=members.find(m=>m.parent_id===ROWS[i].id);if(!m || m.family_id!==f.id || m.status!=='active' || m.role!==(i===0?'owner':'member') || m.line_uid!==ROWS[i].uid)fail('EXISTING_FIXTURE_MEMBER_MISMATCH');}
 return f.id; // Existing booleans intentionally preserved; no reset or UPDATE.
}
async function main(expected){
 const emit=x=>console.log(JSON.stringify(x));const safe=e=>/^[A-Z0-9_]{2,40}$/.test(e?.code||'')?e.code:'UNCLASSIFIED';
 console.error=(...a)=>emit({status:'ERROR',code:safe(a.find(x=>x&&typeof x==='object'))});
 let guard,pool,c;const timer=setTimeout(()=>{emit({status:'FAIL',code:'TIMEOUT'});process.exit(2)},20000);
 try{
  guard=require('../services/previewOutboundGuard.cjs').install({connectionString:process.env.DATABASE_URL,expectedTargetHash:expected});
  const dotenv=require('dotenv');dotenv.config=dotenv.configDotenv=()=>({parsed:{}});
  ({pool}=require('../models/db'));const familyAdmin=require('../services/familyAdmin');c=await pool.connect();
  const cp=c.connectionParameters;if(crypto.createHash('sha256').update(JSON.stringify([String(cp.host).toLowerCase(),cp.database,Number(cp.port)])).digest('hex')!==expected)fail('TARGET_MISMATCH');
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='8s'");
  if((await c.query('SELECT current_schema() AS s')).rows[0].s!=='public')fail('SCHEMA_MISMATCH');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[ACTOR]);
  const existing=await c.query('SELECT id,name,phone,email,line_uid,primary_venue_id,is_active FROM parents WHERE id=ANY($1::uuid[]) OR phone=ANY($2::text[]) OR email=ANY($3::text[]) OR line_uid=ANY($4::text[]) FOR UPDATE',[ROWS.map(r=>r.id),ROWS.map(r=>r.phone),ROWS.map(r=>r.email),ROWS.map(r=>r.uid)]);
  let familyId,reused=false;
  if(existing.rowCount){
   const families=await c.query('SELECT id,owner_parent_id,name,created_by,status FROM families WHERE owner_parent_id=$1',[ROWS[0].id]);
   const members=await c.query('SELECT family_id,parent_id,role,status,line_uid,member_enabled,line_access_enabled,push_enabled FROM family_members WHERE parent_id=ANY($1::uuid[])',[ROWS.map(r=>r.id)]);
   familyId=validateExisting(existing.rows,families.rows,members.rows);reused=true;
  }else{
   if((await c.query('SELECT id FROM venues WHERE id=$1 AND is_active=true',['AC'])).rowCount!==1)fail('ACTIVE_VENUE_REQUIRED');
   for(const r of ROWS)await c.query('INSERT INTO parents(id,name,phone,email,line_uid,primary_venue_id,is_active) VALUES($1,$2,$3,$4,$5,$6,true)',[r.id,r.name,r.phone,r.email,r.uid,'AC']);
   const created=await familyAdmin.createFamily(c,{ownerParentId:ROWS[0].id,ownerRelationship:'mother',name:FAMILY_NAME,actor:ACTOR});familyId=created.result.id;
   await familyAdmin.addMember(c,{familyId,parentId:ROWS[1].id,relationship:'guardian',actor:ACTOR});
  }
  const check=await c.query('SELECT parent_id,role,member_enabled,line_access_enabled,push_enabled FROM family_members WHERE family_id=$1 ORDER BY parent_id',[familyId]);
  if(check.rowCount!==2 || (!reused && check.rows.some(r=>!r.member_enabled||!r.line_access_enabled||!r.push_enabled)))fail('FIXTURE_POSTCONDITION');
  await c.query('COMMIT');c.release();c=null;
  if((await pool.query('SELECT count(*)::int AS n FROM family_members WHERE family_id=$1 AND parent_id=ANY($2::uuid[])',[familyId,ROWS.map(r=>r.id)])).rows[0].n!==2)fail('PERSISTENCE_POSTCONDITION');
  emit({status:'PASS',task_owned:true,reused,family_id:familyId,parents:ROWS.map(r=>({id:r.id,name:r.name})),members:check.rows,notices_dispatched:false,app_started:false,retain_for_demo:true});
 }catch(e){if(c)try{await c.query('ROLLBACK')}catch{}process.exitCode=1;emit({status:'FAIL',code:safe(e)});}
 finally{if(c)c.release();if(pool)await pool.end();if(guard)guard.restore();clearTimeout(timer);}
}
module.exports={validateExisting,ROWS,FAMILY_NAME,ACTOR};
if(require.main===module)main(process.argv[2]);
