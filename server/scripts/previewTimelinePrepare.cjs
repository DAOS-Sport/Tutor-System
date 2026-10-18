'use strict';
// One-time synthetic daily-node fixture. Existing nodes are verified, never regenerated.
const fs=require('node:fs'),crypto=require('node:crypto');
const target='e7eef8e210c8f91f9c9a8c1c9d6d3ec9db0e3568323ce3bb2ddb2c09dabe1a3d',schema='preview_timeline_20260930';
const op='/home/runner/workspace/outputs/preview-ragic-keyring-operator-20260930/operator.cjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
let pool,client;
async function main(){
 if(process.argv.length!==3||process.argv[2]!==target)throw Error('target');
 if(sha(fs.readFileSync(op))!=='c99a8774975279082f72117435d4ddb923abbcab7f53af9fac9adf6cc30fbdfc')throw Error('operator');
 Object.assign(process.env,require(op)._testing.childEnvironmentAt('/home/runner',true));
 require('../services/previewOutboundGuard.cjs').install({connectionString:process.env.DATABASE_URL,expectedTargetHash:target});
 const {Pool}=require('pg');pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});client=await pool.connect();
 const p=client.connectionParameters;if(sha(JSON.stringify([p.host.toLowerCase(),p.database,Number(p.port)]))!==target)throw Error('actual target');
 await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='3000ms'; SET LOCAL statement_timeout='10000ms'");
 await client.query('SELECT pg_advisory_xact_lock(20260930,811)');
 const existing=(await client.query('SELECT oid FROM pg_namespace WHERE nspname=$1',[schema])).rowCount===1;
 if(!existing){
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`CREATE TABLE ${schema}.fixture_identity(marker text PRIMARY KEY CHECK(marker='daos-synthetic-timeline-20260930'));
   INSERT INTO ${schema}.fixture_identity VALUES('daos-synthetic-timeline-20260930');
   CREATE TABLE ${schema}.ragic_shadow_checkpoints(checkpoint_id uuid PRIMARY KEY,business_date date UNIQUE NOT NULL,requested_cutoff timestamptz NOT NULL,actual_cutoff timestamptz NOT NULL,boundary_met boolean NOT NULL,status text NOT NULL,previous_checkpoint_id uuid,key_version text NOT NULL,cipher_nonce bytea NOT NULL,cipher_tag bytea NOT NULL,encrypted_snapshot bytea NOT NULL,snapshot_hash text NOT NULL,event_manifest_hash text NOT NULL)`);
  const key=Buffer.from(process.env.RAGIC_INCREMENTAL_ENCRYPTION_KEY,'hex'),hmac=v=>crypto.createHmac('sha256',key).update(JSON.stringify(stable(v))).digest('hex');
  let previous=null;
  for(const day of [28,29]){
   const id=`da050001-2026-4930-8110-0000000000${day}`,cutoff=`2026-09-${day}T16:00:00.000Z`;
   const snapshot={schema_version:2,projection_schema_version:1,business_date:`2026-09-${day}`,requested_cutoff:cutoff,actual_cutoff:cutoff,previous_checkpoint_id:previous,event_manifest:{event_ids:[],groups:[]},entity_versions:{'parent:demo-parent':0,'student:demo-student':0},tables:{parents:[{id:'demo-parent',name:'DEMO 合成家長'}],students:[{id:'demo-student',parent_id:'demo-parent',name:day===28?'DEMO 學員（節點一）':'DEMO 學員（節點二）',birth_date:'2015-01-01'}]}};
   const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce),bytes=Buffer.concat([cipher.update(JSON.stringify(snapshot)),cipher.final()]);
   await client.query(`INSERT INTO ${schema}.ragic_shadow_checkpoints VALUES($1,$2,$3,$3,true,'complete',$4,$5,$6,$7,$8,$9,$10)`,[id,snapshot.business_date,cutoff,previous,process.env.RAGIC_INCREMENTAL_KEY_VERSION,nonce,cipher.getAuthTag(),bytes,hmac(snapshot),hmac(snapshot.event_manifest)]);previous=id;
  }
 }
 const tables=(await client.query('SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind=$2 ORDER BY c.relname',[schema,'r'])).rows.map(x=>x.relname);
 if(JSON.stringify(tables)!=='["fixture_identity","ragic_shadow_checkpoints"]')throw Error('schema collision');
 const marker=await client.query(`SELECT marker FROM ${schema}.fixture_identity`);if(marker.rowCount!==1||marker.rows[0].marker!=='daos-synthetic-timeline-20260930')throw Error('marker');
 const rows=(await client.query(`SELECT *,business_date::text FROM ${schema}.ragic_shadow_checkpoints ORDER BY ragic_shadow_checkpoints.business_date`)).rows;
 if(rows.length!==2)throw Error('node count');
 const {decodeCheckpoint}=require('../services/ragicShadowReplayBridge');
 for(let i=0;i<rows.length;i++){const {snapshot}=decodeCheckpoint(rows[i]);if(snapshot.business_date!==`2026-09-${28+i}`||snapshot.tables.students[0].id!=='demo-student'||snapshot.tables.parents[0].id!=='demo-parent')throw Error('fixture mismatch');}
 await client.query('COMMIT');
 console.log(JSON.stringify({status:'SYNTHETIC_TIMELINE_READY',schema,nodes:2,reused:existing,keyVersion:'test-v1',businessRowsChanged:0,syntheticOnly:true,normalAppStarted:false,workerStarted:false,noticesDispatched:false}));
}
main().catch(async()=>{if(client)await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({status:'FAIL',code:'PREVIEW_TIMELINE_PREPARE_FAILED'}));process.exitCode=20;}).finally(async()=>{if(client)client.release();if(pool)await pool.end();});
