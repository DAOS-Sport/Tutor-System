'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { pool } = require('../../server/models/db');
const ragic = require('../../server/services/ragic');
const { getSecret } = require('../../server/middlewares/adminAuth');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const { registerNewParentLocalFirst } = require('../../server/services/z03IdentityClaim');
const { processRagicSyncOutbox } = require('../../server/services/ragicSyncOutbox');

const suffix = `${Date.now()}`.slice(-6);
const existingPhone = `0951${suffix}`;
const newPhone = `0952${suffix}`;
const existingUid = `UrollbackExisting${crypto.randomBytes(8).toString('hex')}`;
const newUid = `UrollbackNew${crypto.randomBytes(8).toString('hex')}`;
const requestKey = `rollback-${suffix}`;
const outboxKey = `create-z01-parent:${requestKey}`;
const remoteRecordId = `ZZROLLBACK${suffix}`;
const parentIds = [];
let tempWorktree = null;
let previousPool = null;

function git(...args) {
  return execFileSync('git', args, { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }).trim();
}

async function counts() {
  return (await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM parents WHERE id=ANY($1::uuid[])) parents,
       (SELECT COUNT(*)::int FROM students WHERE parent_id=ANY($1::uuid[])) students,
       (SELECT COUNT(*)::int FROM ragic_sync_outbox WHERE idempotency_key=$2) outbox,
       (SELECT COUNT(*)::int FROM source_record_links WHERE canonical_parent_id=ANY($1::uuid[])) links`,
    [parentIds.length ? parentIds : [crypto.randomUUID()], outboxKey]
  )).rows[0];
}

async function startAuthServer(root) {
  const routePath = path.join(root, 'server', 'routes', 'auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require(routePath));
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  return server;
}

async function login(server, lineUid) {
  axios.post = async () => ({ status: 200, data: { sub: lineUid, aud: 'rollback-channel' } });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/parent-line-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: 'rollback-test-token' }),
  });
  const body = await response.json();
  assert.strictEqual(response.status, 200);
  assert.strictEqual(body.status, 'logged_in');
  return body;
}

async function cleanup() {
  const claims = await pool.query(
    `SELECT id FROM identity_claims WHERE canonical_parent_id=ANY($1::uuid[]) OR source_record_id IN ($2,$3)`,
    [parentIds.length ? parentIds : [crypto.randomUUID()], `PENDING:${requestKey}`, remoteRecordId]
  );
  const claimIds = claims.rows.map((row) => row.id);
  if (claimIds.length) {
    await pool.query(`DELETE FROM identity_claim_events WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM parent_identity_requests WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM source_record_links WHERE claim_id=ANY($1::uuid[])`, [claimIds]);
    await pool.query(`DELETE FROM identity_claims WHERE id=ANY($1::uuid[])`, [claimIds]);
  }
  for (const parentId of parentIds) {
    await pool.query(`DELETE FROM parent_line_uid_bindings WHERE canonical_parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
  }
  if (previousPool) await previousPool.end().catch(() => {});
  if (tempWorktree) {
    try { git('worktree', 'remove', '--force', tempWorktree); } catch (_) { /* best effort temp cleanup */ }
    tempWorktree = null;
  }
}

async function run() {
  const repoRoot = path.join(__dirname, '..', '..');
  const previousBuildId = git('rev-parse', 'HEAD');
  const runtimePaths = fs.readFileSync(path.join(repoRoot, 'parent-identity-release-files.txt'), 'utf8')
    .split(/\r?\n/)
    .filter((name) => /^(client\/liff\/|config\/|db\/migrations\/|server\/)/.test(name));
  const runtimeHash = crypto.createHash('sha256');
  for (const relative of runtimePaths.sort()) {
    const absolute = path.join(repoRoot, relative);
    runtimeHash.update(`${relative}\0`);
    runtimeHash.update(fs.existsSync(absolute) ? fs.readFileSync(absolute) : Buffer.from('<deleted>'));
    runtimeHash.update('\0');
  }
  const rcBuildId = `${previousBuildId}+${runtimeHash.digest('hex').slice(0, 16)}`;
  const rollbackAt = new Date().toISOString();
  const originalAxiosPost = axios.post;
  process.env.LINE_LOGIN_CHANNEL_ID = 'rollback-channel';
  try {
    const existing = (await pool.query(
      `INSERT INTO parents(phone,name,line_uid,is_active) VALUES ($1,'rollback existing',$2,TRUE) RETURNING *`,
      [existingPhone, existingUid]
    )).rows[0];
    parentIds.push(existing.id);
    await pool.query(`INSERT INTO students(parent_id,name,is_active) VALUES ($1,'rollback existing student',TRUE)`, [existing.id]);
    const beforeToken = signParentToken({ parentId: existing.id, phone: existingPhone, lineUid: existingUid });

    const newClaim = await registerNewParentLocalFirst({
      parent: { name: 'rollback canary parent', phone: newPhone },
      students: [{ name: 'rollback canary student' }],
      lineUid: newUid,
      idempotencyKey: requestKey,
    });
    parentIds.push(newClaim.parent.id);
    const countsBeforeRollback = await counts();
    assert.deepStrictEqual(countsBeforeRollback, { parents: 2, students: 2, outbox: 1, links: 0 });

    delete require.cache[require.resolve('../../server/services/lineAuth')];
    delete require.cache[require.resolve('../../server/routes/auth')];
    const rcServer = await startAuthServer(repoRoot);
    await login(rcServer, existingUid);
    await login(rcServer, newUid);
    await new Promise((resolve) => rcServer.close(resolve));

    tempWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-identity-previous-'));
    fs.rmdirSync(tempWorktree);
    git('worktree', 'add', '--detach', tempWorktree, previousBuildId);
    fs.symlinkSync(path.join(repoRoot, 'server', 'node_modules'), path.join(tempWorktree, 'server', 'node_modules'), 'dir');
    previousPool = require(path.join(tempWorktree, 'server', 'models', 'db')).pool;
    const previousServer = await startAuthServer(tempWorktree);
    const oldExistingLogin = await login(previousServer, existingUid);
    const oldNewLogin = await login(previousServer, newUid);
    assert.strictEqual(oldExistingLogin.parent.id, existing.id);
    assert.strictEqual(oldNewLogin.parent.id, newClaim.parent.id);
    await new Promise((resolve) => previousServer.close(resolve));

    assert.strictEqual(jwt.verify(beforeToken, getSecret()).parentId, existing.id);
    const countsAfterRollback = await counts();
    assert.deepStrictEqual(countsAfterRollback, countsBeforeRollback,
      'previous app must leave additive claim/outbox rows untouched');

    delete require.cache[require.resolve('../../server/routes/auth')];
    const redeployedServer = await startAuthServer(repoRoot);
    await login(redeployedServer, existingUid);
    await login(redeployedServer, newUid);
    await new Promise((resolve) => redeployedServer.close(resolve));

    const originalFetchPage = ragic.fetchPage;
    const originalCreate = ragic.createParentWithStudentsInRagic;
    let writeCount = 0;
    try {
      ragic.fetchPage = async () => ({ rows: [], count: 0 });
      ragic.createParentWithStudentsInRagic = async ({ lineUid }) => {
        writeCount += 1;
        assert.strictEqual(lineUid, newUid);
        return { ragicRecordId: remoteRecordId };
      };
      const processed = await processRagicSyncOutbox({
        limit: 1, idempotencyKey: outboxKey, schemaGuard: async () => ({ verified: true }),
      });
      assert.deepStrictEqual(processed, { processed: 1, synced: 1, retryable: 0, blocked: 0 });
      const duplicate = await processRagicSyncOutbox({
        limit: 1, idempotencyKey: outboxKey, schemaGuard: async () => ({ verified: true }),
      });
      assert.deepStrictEqual(duplicate, { processed: 0, synced: 0, retryable: 0, blocked: 0 });
    } finally {
      ragic.fetchPage = originalFetchPage;
      ragic.createParentWithStudentsInRagic = originalCreate;
    }
    const countsAfterRedeploy = await counts();
    assert.deepStrictEqual(countsAfterRedeploy, { parents: 2, students: 2, outbox: 1, links: 1 });
    assert.strictEqual(writeCount, 1);

    console.log(JSON.stringify({
      test: 'T25 application rollback rehearsal',
      result: 'PASS',
      previous_build_id: previousBuildId,
      release_candidate_build_id: rcBuildId,
      rollback_timestamp: rollbackAt,
      commands: [
        `git worktree add --detach <temp> ${previousBuildId}`,
        'start RC auth harness',
        'start previous-build auth harness against additive DB',
        'start RC auth harness and drain pending outbox once',
      ],
      health_checks: { rc_before: 'PASS', previous_build: 'PASS', rc_after: 'PASS' },
      login_checks: { existing_fast_path: 'PASS', new_claim_local_login: 'PASS', pre_release_token: 'PASS' },
      db_counts_before: countsBeforeRollback,
      db_counts_after_rollback: countsAfterRollback,
      db_counts_after_redeploy: countsAfterRedeploy,
      ragic_write_count: writeCount,
      destructive_down_migration: false,
    }, null, 2));
  } finally {
    axios.post = originalAxiosPost;
  }
}

(async () => {
  await cleanup();
  try { await run(); } finally { await cleanup(); await pool.end(); }
})().catch((err) => { console.error(err); process.exit(1); });
