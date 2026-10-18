'use strict';
// Official Workflow only, stopped app. Synthetic row retained for the phone demo.
const crypto=require('node:crypto');
const ROW={id:'7e570001-2026-4930-8057-000000000003',name:'DEMO057 手機加入測試',phone:'0999005703',email:'demo057-phone-20260930@example.invalid',primary_venue_id:'AC',is_active:true};
ROW.line_uid='U'+crypto.createHash('sha256').update('SYNTHETIC_ONLY_'+ROW.id).digest('hex').slice(0,32);
const fail=code=>{throw Object.assign(new Error(),{code});};
function validate(rows){if(rows.length!==1)fail('FIXTURE_COLLISION');for(const [k,v]of Object.entries(ROW))if(rows[0][k]!==v)fail('FIXTURE_IDENTITY_MISMATCH');}
async function main(expected){let guard,pool,c;const timer=setTimeout(()=>{console.log(JSON.stringify({status:'FAIL',code:'TIMEOUT'}));process.exit(2)},20000);
 try{
  guard=require('../services/previewOutboundGuard.cjs').install({connectionString:process.env.DATABASE_URL,expectedTargetHash:expected});
  const {Pool}=require('pg');pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});c=await pool.connect();
  const p=c.connectionParameters;if(crypto.createHash('sha256').update(JSON.stringify([String(p.host).toLowerCase(),p.database,Number(p.port)])).digest('hex')!==expected)fail('TARGET_MISMATCH');
  await c.query('BEGIN');await c.query("SET LOCAL search_path=public; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='8s'");
  if((await c.query('SELECT current_schema() s')).rows[0].s!=='public')fail('SCHEMA_MISMATCH');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['codex-preview-phone-demo-20260930']);
  const fields='id,name,phone,email,line_uid,primary_venue_id,is_active';
  const existing=await c.query(`SELECT ${fields} FROM parents WHERE id=$1 OR phone=$2 OR email=$3 OR line_uid=$4 FOR UPDATE`,[ROW.id,ROW.phone,ROW.email,ROW.line_uid]);
  const reused=existing.rowCount>0;
  if(reused)validate(existing.rows);else{
   if((await c.query('SELECT id FROM venues WHERE id=$1 AND is_active=true',[ROW.primary_venue_id])).rowCount!==1)fail('ACTIVE_VENUE_REQUIRED');
   await c.query('INSERT INTO parents(id,name,phone,email,line_uid,primary_venue_id,is_active) VALUES($1,$2,$3,$4,$5,$6,true)',[ROW.id,ROW.name,ROW.phone,ROW.email,ROW.line_uid,ROW.primary_venue_id]);
  }
  const memberCount=(await c.query("SELECT count(*)::int n FROM family_members WHERE parent_id=$1 AND status='active'",[ROW.id])).rows[0].n;
  if(!reused && memberCount!==0)fail('UNEXPECTED_MEMBERSHIP');
  await c.query('COMMIT');validate((await c.query(`SELECT ${fields} FROM parents WHERE id=$1`,[ROW.id])).rows);
  console.log(JSON.stringify({status:'PASS',task_owned:true,reused,parent_id:ROW.id,name:ROW.name,phone:ROW.phone,active_family_memberships:memberCount,notices_dispatched:false,app_started:false,retain_for_demo:true}));
 }catch(e){if(c)try{await c.query('ROLLBACK')}catch{}console.log(JSON.stringify({status:'FAIL',code:/^[A-Z0-9_]{2,40}$/.test(e?.code||'')?e.code:'UNCLASSIFIED'}));process.exitCode=1;}
 finally{if(c)c.release();if(pool)await pool.end();if(guard)guard.restore();clearTimeout(timer);}
}
module.exports={ROW,validate};if(require.main===module)main(process.argv[2]);
