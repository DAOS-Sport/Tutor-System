'use strict';

const assert = require('assert');
const express = require('../server/node_modules/express');
const jwt = require('../server/node_modules/jsonwebtoken');
const axios = require('../server/node_modules/axios');
const { pool } = require('../server/models/db');
const ragic = require('../server/services/ragic');
const {
  RAGIC_Z01_FIELDS,
  getTrueRagicLineUid,
  assertParentUidSchemaDefinition,
} = require('../server/config/ragicSchema');
const { normalizePhone, normalizeStudentName } = require('../server/services/identityNormalizer');
const { signParentToken, getSecret } = require('../server/middlewares/parentAuth');
const { classifySyncFailure } = require('../server/services/ragicSyncOutbox');
const { hardDeleteParentIfSafe } = require('../server/services/parentSync');

const suffix = String(Date.now()).slice(-6);
const phone = `0911${suffix}`;
const lineUid = `Uclosure${suffix}`;
let parentId = null;

async function cleanup() {
  if (parentId) {
    await pool.query(`DELETE FROM students WHERE parent_id=$1`, [parentId]);
    await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]);
  }
}

async function postJson(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function testFrozenUidField() {
  assert.strictEqual(RAGIC_Z01_FIELDS.PARENT_SYSTEM_LINE_UID, '1006846');
  const uid = `U${'a'.repeat(32)}`;
  assert.strictEqual(getTrueRagicLineUid({ 1006846: uid }), uid);
  assert.strictEqual(getTrueRagicLineUid({
    家教系統uid: uid,
    'LINE 對話網址': `https://line.me/${uid}`,
    'LINE 綁址狀態': '已建立',
    家長帳號: uid,
  }), '');
  assert.strictEqual(assertParentUidSchemaDefinition([{ id: '1006846', name: '家教系統uid' }]), true);
  assert.throws(
    () => assertParentUidSchemaDefinition([{ id: '1006846', name: 'LINE 對話網址' }]),
    (err) => err.code === 'RAGIC_UID_FIELD_SCHEMA_MISMATCH'
  );
  assert.throws(
    () => assertParentUidSchemaDefinition([
      { id: '1006846', name: '家教系統uid' },
      { id: '1006846', name: '家教系統uid' },
    ]),
    (err) => err.code === 'RAGIC_UID_FIELD_SCHEMA_MISMATCH'
  );
}

async function testNormalization() {
  assert.strictEqual(normalizePhone('＋８８６ ９１１-１２３-４５６'), '0911123456');
  assert.strictEqual(normalizePhone('886911123456'), '0911123456');
  assert.strictEqual(normalizeStudentName(' 王　小 明 '), normalizeStudentName('王小明'));
}

async function testExistingUserZeroRagicCallsAndTokenCompatibility() {
  const inserted = await pool.query(
    `INSERT INTO parents(phone,name,line_uid,is_active) VALUES ($1,'既有會員',$2,TRUE) RETURNING id`,
    [phone, lineUid]
  );
  parentId = inserted.rows[0].id;
  await pool.query(`INSERT INTO students(parent_id,name,is_active) VALUES ($1,'既有學員',TRUE)`, [parentId]);

  const tokenBefore = signParentToken({ parentId, phone, lineUid });
  const beforePayload = jwt.verify(tokenBefore, getSecret());

  const originalAxiosPost = axios.post;
  const originals = {};
  let ragicCalls = 0;
  for (const name of ['getParentByPhone', 'getParentByLineUid', 'upsertParentStrict', 'createParentWithStudentsInRagic']) {
    originals[name] = ragic[name];
    ragic[name] = async () => { ragicCalls += 1; throw new Error('Ragic offline'); };
  }
  axios.post = async () => ({ status: 200, data: { sub: lineUid, aud: 'closure-test-channel' } });
  process.env.LINE_LOGIN_CHANNEL_ID = 'closure-test-channel';

  delete require.cache[require.resolve('../server/services/lineAuth')];
  delete require.cache[require.resolve('../server/routes/auth')];
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../server/routes/auth'));
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  try {
    const response = await postJson(server.address().port, '/api/auth/parent-line-login', { id_token: 'offline-safe-token' });
    const body = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.status, 'logged_in');
    assert.strictEqual(body.local_fast_path, true);
    assert.strictEqual(body.parent.id, parentId);
    assert.ok(body.token);
    assert.strictEqual(ragicCalls, 0, 'existing local UID login must make zero Ragic calls');

    // Rollback rehearsal: disabling the newly introduced fast-path flag must not
    // remove the local lookup that this endpoint already guaranteed before V2.
    const rollbackFlags = [
      'EXISTING_USER_LOCAL_FASTPATH',
      'PARENT_IDENTITY_RESOLVER_V2',
      'PARENT_LOCAL_FIRST',
      'RAGIC_PARENT_OUTBOX',
      'LEGACY_CLAIM_AUTO_CREATE',
      'DESTRUCTIVE_RECONCILE_ENABLED',
      'PASSED_NOT_ON_FILE_ENABLED',
    ];
    for (const flag of rollbackFlags) process.env[flag] = 'false';
    const rollbackResponse = await postJson(
      server.address().port,
      '/api/auth/parent-line-login',
      { id_token: 'offline-safe-token' }
    );
    const rollbackBody = await rollbackResponse.json();
    assert.strictEqual(rollbackResponse.status, 200);
    assert.strictEqual(rollbackBody.status, 'logged_in');
    assert.strictEqual(rollbackBody.parent.id, parentId);
    assert.strictEqual(ragicCalls, 0, 'flag-off rollback must keep existing login Ragic-free');

    const deleteAttempted = await hardDeleteParentIfSafe(pool, parentId);
    assert.strictEqual(deleteAttempted, false, 'destructive reconcile must be disabled by default');
    const parentStillExists = await pool.query(`SELECT 1 FROM parents WHERE id=$1`, [parentId]);
    assert.strictEqual(parentStillExists.rowCount, 1);
    const afterPayload = jwt.verify(tokenBefore, getSecret());
    assert.strictEqual(afterPayload.parentId, beforePayload.parentId);
    assert.strictEqual(afterPayload.phone, beforePayload.phone);
    assert.strictEqual(afterPayload.lineUid, beforePayload.lineUid);
    assert.strictEqual(afterPayload.type, 'parent');
    assert.strictEqual(afterPayload.exp, beforePayload.exp);
  } finally {
    for (const flag of [
      'EXISTING_USER_LOCAL_FASTPATH',
      'PARENT_IDENTITY_RESOLVER_V2',
      'PARENT_LOCAL_FIRST',
      'RAGIC_PARENT_OUTBOX',
      'LEGACY_CLAIM_AUTO_CREATE',
      'DESTRUCTIVE_RECONCILE_ENABLED',
      'PASSED_NOT_ON_FILE_ENABLED',
    ]) delete process.env[flag];
    await new Promise((resolve) => server.close(resolve));
    axios.post = originalAxiosPost;
    for (const [name, value] of Object.entries(originals)) ragic[name] = value;
  }
}

async function testRetryClassification() {
  assert.deepStrictEqual(classifySyncFailure({ code: 'RAGIC_NETWORK_ERROR' }, 1, 8), {
    outboxState: 'retryable', claimState: 'SYNC_FAILED_RETRYABLE', code: 'RAGIC_NETWORK_ERROR',
  });
  assert.deepStrictEqual(classifySyncFailure({ code: 'RAGIC_HTTP_SERVER_ERROR', status: 503 }, 1, 8), {
    outboxState: 'retryable', claimState: 'SYNC_FAILED_RETRYABLE', code: 'RAGIC_HTTP_SERVER_ERROR',
  });
  assert.strictEqual(classifySyncFailure({ code: 'RAGIC_UID_FIELD_SCHEMA_MISMATCH' }, 1, 8).claimState, 'SYNC_BLOCKED_SCHEMA');
}

(async () => {
  try {
    await testFrozenUidField();
    await testNormalization();
    await testExistingUserZeroRagicCallsAndTokenCompatibility();
    await testRetryClassification();
    console.log('parent_identity_closure_test: PASS (4 suites)');
  } finally {
    await cleanup();
    await pool.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
