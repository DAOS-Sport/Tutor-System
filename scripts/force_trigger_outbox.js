'use strict';

// Preview: NODE_PATH=./server/node_modules node scripts/force_trigger_outbox.js --node 739 --node 433
// Write: add both --execute and --confirm-write. Production credentials/DB must come from deployment secrets.

const { pool } = require('../server/models/db');
const { normalizeLineUid } = require('../server/config/ragicSchema');
const {
  verifyRagicZ01UidSchemaFreshness,
  schemaGuardFailureDetails,
} = require('../server/services/ragicSchemaFreshness');
const {
  processRagicSyncOutboxJob,
  readbackRagicSyncOutboxJob,
} = require('../server/services/ragicSyncOutbox');

const OPERATION = 'BIND_Z01_LINE_UID';

function normalizeNodeId(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`invalid Node ID: ${raw || '(empty)'}`);
  return String(BigInt(raw));
}

function parseArgs(argv) {
  const nodes = [];
  let execute = false;
  let confirmWrite = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--node') {
      if (i + 1 >= argv.length) throw new Error('--node requires a value');
      nodes.push(normalizeNodeId(argv[++i]));
    } else if (arg === '--execute') execute = true;
    else if (arg === '--confirm-write') confirmWrite = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  const uniqueNodes = [...new Set(nodes)];
  if (!uniqueNodes.length) throw new Error('at least one --node is required');
  if (execute !== confirmWrite) {
    throw new Error('writes require both --execute and --confirm-write');
  }
  return { nodes: uniqueNodes, execute: execute && confirmWrite };
}

async function findExactNodeJobs(node) {
  const result = await pool.query(
    `SELECT o.*,p.line_uid AS canonical_line_uid
       FROM ragic_sync_outbox o
       LEFT JOIN identity_claims c ON c.id=o.claim_id
       LEFT JOIN parents p ON p.id=c.canonical_parent_id
      WHERE o.operation=$1 AND o.source_record_id=$2 AND o.target_record_id=$2
      ORDER BY o.created_at,o.id`,
    [OPERATION, String(node)]
  );
  return result.rows;
}

function preflightNode(node, jobs) {
  if (jobs.length === 0) return { ok: false, node, status: 'MISSING' };
  if (jobs.length !== 1) return { ok: false, node, status: 'MULTIPLE', matches: jobs.length };
  const job = jobs[0];
  if (!normalizeLineUid(job.canonical_line_uid)) {
    return { ok: false, node, status: 'CANONICAL_LINE_UID_MISSING' };
  }
  if (job.state === 'synced') return { ok: true, node, status: 'ALREADY_SYNCED', job };
  if (job.state !== 'pending') {
    return { ok: false, node, status: `STATE_${String(job.state || 'UNKNOWN').toUpperCase()}` };
  }
  if (Number(job.attempts) !== 0) {
    return { ok: false, node, status: 'ATTEMPTS_NOT_ZERO', attempts: Number(job.attempts) };
  }
  return { ok: true, node, status: 'READY', job };
}

function safeJobResult(preflight, extra = {}) {
  const job = preflight.job;
  return {
    node: preflight.node,
    status: preflight.status,
    job_id: job?.id || null,
    correlation_id: job?.correlation_id || null,
    before_state: job?.state || null,
    after_state: extra.after_state ?? job?.state ?? null,
    attempts_before: job == null ? null : Number(job.attempts),
    attempts_after: extra.attempts_after ?? (job == null ? null : Number(job.attempts)),
    write_performed: extra.write_performed ?? false,
    http_status: extra.http_status ?? null,
    readback_verified: extra.readback_verified ?? false,
    error_code: extra.error_code || null,
    ...(preflight.matches == null ? {} : { matches: preflight.matches }),
  };
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let exitCode = 0;
  const evidence = await verifyRagicZ01UidSchemaFreshness();
  console.log(JSON.stringify({
    event: 'force_trigger_outbox_schema',
    verified: evidence.verified,
    field_id: evidence.field_id,
    field_name: evidence.field_name,
    attr_no_dup: evidence.attr_noDup,
    attr_ro: evidence.attr_ro,
    fresh: new Date(evidence.expires_at).getTime() > Date.now(),
    http_status: evidence.http_status,
    response_hash: evidence.response_hash,
    correlation_id: evidence.correlation_id,
    fetched_at: evidence.fetched_at,
    expires_at: evidence.expires_at,
    failure_code: evidence.failure_code,
  }));
  if (!evidence.verified || new Date(evidence.expires_at).getTime() <= Date.now()) {
    const details = schemaGuardFailureDetails({
      ...evidence,
      attr_no_dup: evidence.attr_noDup,
    });
    console.error(JSON.stringify({
      event: 'force_trigger_outbox_stopped',
      status: 'SCHEMA_BLOCKED',
      ...details,
    }));
    return 2;
  }

  const preflights = [];
  for (const node of options.nodes) {
    preflights.push(preflightNode(node, await findExactNodeJobs(node)));
  }

  for (const preflight of preflights) {
    if (!preflight.ok) {
      console.error(JSON.stringify(safeJobResult(preflight)));
      exitCode = 2;
      continue;
    }
    if (preflight.status === 'ALREADY_SYNCED') {
      try {
        const readback = await readbackRagicSyncOutboxJob({ job: preflight.job });
        console.log(JSON.stringify(safeJobResult(preflight, {
          readback_verified: readback.readback_verified,
        })));
      } catch (err) {
        console.error(JSON.stringify(safeJobResult(preflight, {
          readback_verified: false,
          error_code: err.code || 'RAGIC_READBACK_FAILED',
        })));
        exitCode = 2;
      }
      continue;
    }
    if (!options.execute) {
      console.log(JSON.stringify(safeJobResult(preflight)));
      continue;
    }
    const job = preflight.job;
    const processed = await processRagicSyncOutboxJob({
      jobId: job.id,
      idempotencyKey: job.idempotency_key,
      sourceRecordId: preflight.node,
      targetRecordId: preflight.node,
      operation: OPERATION,
      requiredState: 'pending',
      requiredAttempts: 0,
      forceReadback: true,
    });
    let currentJob = null;
    if (processed.status === 'NOT_CLAIMED') {
      currentJob = (await findExactNodeJobs(preflight.node)).find((candidate) => candidate.id === job.id) || null;
    }
    const final = safeJobResult(preflight, {
      after_state: processed.final_job_state || currentJob?.state || null,
      attempts_after: processed.attempts_after ?? (currentJob ? Number(currentJob.attempts) : null),
      write_performed: processed.write_performed,
      http_status: processed.http_status,
      readback_verified: processed.readback_verified,
      error_code: processed.error_code || (processed.status === 'NOT_CLAIMED' ? 'RAGIC_OUTBOX_NOT_CLAIMED' : null),
    });
    final.status = processed.status;
    if (processed.status === 'SYNCED') console.log(JSON.stringify(final));
    else {
      console.error(JSON.stringify(final));
      exitCode = 2;
    }
  }
  return exitCode;
}

if (require.main === module) {
  run()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(JSON.stringify({
        event: 'force_trigger_outbox_failed',
        code: err.code || 'FORCE_TRIGGER_OUTBOX_FAILED',
      }));
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = {
  OPERATION,
  normalizeNodeId,
  parseArgs,
  preflightNode,
  safeJobResult,
  run,
};
