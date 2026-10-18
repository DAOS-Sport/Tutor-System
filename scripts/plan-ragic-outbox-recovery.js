'use strict';

// Read-only plan: no flags or code paths execute Ragic writes or reset jobs.
// node scripts/plan-ragic-outbox-recovery.js --summary
// node scripts/plan-ragic-outbox-recovery.js --job <uuid> [--job <uuid>]
const crypto = require('node:crypto');

function parseArgs(args) {
  const jobIds=[];
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--summary') continue;
    if(args[i]!=='--job') throw Error('Only --summary and --job <uuid> are supported; this planner never writes');
    const id=String(args[++i] || '');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Error('--job requires an exact UUID');
    jobIds.push(id.toLowerCase());
  }
  if(jobIds.length>50)throw Error('At most 50 exact jobs per plan');
  return [...new Set(jobIds)];
}

function studentProblems(students) {
  const seen=new Set();const problems=[];
  for(const [index,student] of students.entries()) {
    const missing=['name','birth_date','gender','id_number'].filter(field=>!String(student?.[field] || '').trim());
    const id=String(student?.id_number || '').trim().toUpperCase();
    const invalidId=Boolean(id && !/^[A-Z]\d{9}$/.test(id));
    const duplicateIdentity=Boolean(id && seen.has(id));
    if(id)seen.add(id);
    if(missing.length || invalidId || duplicateIdentity) problems.push({ index,missing_fields:missing,invalid_id_format:invalidId,duplicate_identity:duplicateIdentity });
  }
  return problems;
}

function planJob(job) {
  const payload=job.payload_reference || {};
  const requested=job.operation==='CREATE_Z01_PARENT' ? payload.students : payload.students_to_append;
  const requestedStudents=Array.isArray(requested)?requested:[];
  const payloadProblems=studentProblems(requestedStudents);
  const localProblems=studentProblems(Array.isArray(job.canonical_students)?job.canonical_students:[]);
  const identityConflict=['STUDENT_ID_NUMBER_EXISTS','PARENT_LINE_UID_MISMATCH','RAGIC_UID_DUPLICATE'].includes(job.last_error_code);
  const currentDataMissing=!job.canonical_parent_id || !job.canonical_line_uid_valid || localProblems.length>0;
  const category=job.state==='synced'?'ALREADY_SYNCED':identityConflict?'IDENTITY_CONFLICT':
    payloadProblems.length?'PAYLOAD_DATA_INCOMPLETE':currentDataMissing?'CANONICAL_DATA_INCOMPLETE':
    job.state==='blocked_retry_exhausted'?'RETRY_BUDGET_EXHAUSTED':job.state==='pending'?'PENDING_NORMAL_WORKER':'REVIEW_REQUIRED';
  return {
    job_id:job.id,operation:job.operation,state:job.state,attempts:Number(job.attempts),max_attempts:Number(job.max_attempts),
    last_error_code:job.last_error_code || null,category,
    selector:{job_id:job.id,expected_state:job.state,expected_attempts:Number(job.attempts),expected_updated_at:job.updated_at},
    payload_sha256:crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    canonical_parent_present:Boolean(job.canonical_parent_id),canonical_line_uid_valid:Boolean(job.canonical_line_uid_valid),
    requested_student_count:requestedStudents.length,canonical_student_count:job.canonical_students?.length || 0,
    payload_problems:payloadProblems,canonical_problems:localProblems,
    automatic_replay_allowed:false,upstream_identity_check:'NOT_RUN',
    recommendation:category==='ALREADY_SYNCED'?'No mutation; verify readback if reconciliation is still requested.':
      category==='IDENTITY_CONFLICT'?'Compare the exact Z01/Z02 source identities and canonical family; resolve ambiguity through authorized human review before any replay. Never merge on name alone.':
      category==='PAYLOAD_DATA_INCOMPLETE' || category==='CANONICAL_DATA_INCOMPLETE'?
        'Correct verified business fields through the audited admin path. Recheck this exact job and its immutable request snapshot; do not invent missing values or automatically replace identity.':
      category==='PENDING_NORMAL_WORKER'?'Leave this pending job to the normal worker; this planner does not execute it.':
        'Confirm source schema, ownership and previous write outcome. Prepare a backed-up, version-checked per-job recovery for approval; do not reset blocked jobs in bulk.',
  };
}

async function run(args=process.argv.slice(2), db) {
  const jobIds=parseArgs(args);
  const client=await db.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='10s'");
    const summary=(await client.query(`SELECT operation,state,last_error_code,COUNT(*)::int AS count
      FROM ragic_sync_outbox GROUP BY operation,state,last_error_code ORDER BY operation,state,last_error_code`)).rows;
    let plans=[];
    if(jobIds.length) {
      const rows=(await client.query(`SELECT o.*,c.canonical_parent_id,
          COALESCE(p.line_uid ~ '^U[0-9A-Fa-f]{32}$',FALSE) AS canonical_line_uid_valid,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('name',s.name,'birth_date',s.birth_date,'gender',s.gender,'id_number',s.id_number))
            FROM students s WHERE s.parent_id=c.canonical_parent_id AND s.is_active=TRUE),'[]'::jsonb) AS canonical_students
        FROM ragic_sync_outbox o LEFT JOIN identity_claims c ON c.id=o.claim_id
        LEFT JOIN parents p ON p.id=c.canonical_parent_id WHERE o.id=ANY($1::uuid[]) ORDER BY o.id`,[jobIds])).rows;
      plans=rows.map(planJob);
      for(const id of jobIds) if(!rows.some(row=>row.id===id))plans.push({job_id:id,category:'NOT_FOUND',automatic_replay_allowed:false});
    }
    await client.query('ROLLBACK');
    return {mode:'READ_ONLY',generated_at:new Date().toISOString(),writes_performed:0,remote_requests:0,summary,plans};
  } catch(err) {await client.query('ROLLBACK').catch(()=>{});throw err;}
  finally {client.release();}
}
if(require.main===module) {
  const {pool}=require('../server/models/db');
  run(process.argv.slice(2),pool).then(result=>console.log(JSON.stringify(result,null,2)))
    .catch(err=>{console.error(err.code || 'OUTBOX_PLAN_FAILED');process.exitCode=1;}).finally(()=>pool.end());
}
module.exports={parseArgs,studentProblems,planJob,run};
