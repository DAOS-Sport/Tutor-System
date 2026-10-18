'use strict';
// Official development Workflow only. Fixed test-target digest is required.
// preflight is read-only; apply locks the table briefly and refuses conflicts.
const fs=require('node:fs'),path=require('node:path');
const {install}=require('../services/previewOutboundGuard.cjs'); // staged server/scripts
let pool;
async function main(){
 const mode=process.argv[3];if(!['preflight','apply'].includes(mode))throw Object.assign(Error(),{code:'MODE_REQUIRED'});
 install({connectionString:process.env.DATABASE_URL,expectedTargetHash:process.argv[2]});
 // Direct pg construction: no application model import, dotenv or bootstrap.
 const {Pool}=require('pg');
 pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c timezone=Asia/Taipei'});
 const preflight=fs.readFileSync(path.join(__dirname,'phone-canonical-preflight.sql'),'utf8');
 const migration=fs.readFileSync(path.join(__dirname,'phone-canonical-create.sql'),'utf8');
 const client=await pool.connect();
 try{
  await client.query(mode==='preflight'?'BEGIN READ ONLY':'BEGIN');
  const readOnly=(await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only==='on';
  if(mode==='preflight'&&!readOnly)throw Object.assign(Error(),{code:'READ_ONLY_REQUIRED'});
  await client.query("SET LOCAL search_path=public; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'");
  if(mode==='apply')await client.query('LOCK TABLE parents IN SHARE ROW EXCLUSIVE MODE');
  const counts=(await client.query(preflight)).rows[0];
  console.log(JSON.stringify({event:'phone_canonical_preflight',...counts,readOnly}));
  if(counts.duplicate_group_count!==0 || counts.excess_rows!==0)throw Object.assign(Error(),{code:'CANONICAL_PHONE_CONFLICTS'});
  if(mode==='apply'){
   const existing=await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='uq_parents_phone_canonical_active'");
   if(existing.rowCount)throw Object.assign(Error(),{code:'INDEX_EXISTS_REVIEW_REQUIRED'});
   // SQL is the reviewed fixed artifact; remove only its outer transaction lines.
   const sql=migration.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
   await client.query(sql);
   const check=await client.query("SELECT i.indisvalid,i.indisunique FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='uq_parents_phone_canonical_active'");
   if(check.rowCount!==1||!check.rows[0].indisvalid||!check.rows[0].indisunique)throw Object.assign(Error(),{code:'INDEX_VALIDATION_FAILED'});
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({status:'PASS',mode,indexCreated:mode==='apply',rowsChanged:0,appStarted:false,noticesDispatched:false}));
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
main().catch(error=>{console.error(JSON.stringify({status:'FAIL',code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'PHONE_CANONICAL_PREP_FAILED'}));process.exitCode=1;}).finally(async()=>{if(pool)await pool.end();});
