const assert = require('assert');

process.env.RAGIC_BASE_URL = process.env.RAGIC_BASE_URL || 'https://example.ragic.com';
process.env.RAGIC_API_KEY = process.env.RAGIC_API_KEY || 'test-key';
process.env.RAGIC_FORM_H01 = process.env.RAGIC_FORM_H01 || '/h01';
process.env.RAGIC_FORM_Z01 = process.env.RAGIC_FORM_Z01 || '/z01';
process.env.RAGIC_FORM_Z02 = process.env.RAGIC_FORM_Z02 || '/z02';

const { createWriter } = require('../server/services/ragicWriter');

function makeWriter() {
  const calls = [];
  const audits = [];
  const alerts = [];
  const http = {
    get: async (url, options) => {
      calls.push({ method: 'get', url, options });
      return { data: { 1003633: `U${'e'.repeat(32)}` } };
    },
    post: async (url, payload, options) => {
      calls.push({ method: 'post', url, payload, options });
      return { data: { status: 'SUCCESS', ragicId: '123' } };
    },
    delete: async (url, options) => {
      calls.push({ method: 'delete', url, options });
      return { data: { status: 'SUCCESS' } };
    },
  };
  const writer = createWriter({
    http,
    audit: async (entry) => { audits.push(entry); },
    alert: async (text) => { alerts.push(text); },
  });
  return { writer, calls, audits, alerts };
}

async function testRejectsUrlIntoH01UidWithoutHttp() {
  const { writer, calls, audits, alerts } = makeWriter();
  await assert.rejects(
    () => writer.writeField(
      'H01',
      '9001',
      '1003633',
      'https://chat.line.biz/foo/chat/U5713b8dca03d3a78777891da2e9f12b6',
      'test',
      'unit'
    ),
    /URL\/LINE chat link/
  );
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(audits[0].status, 'rejected');
  assert.strictEqual(alerts.length, 1);
}

async function testRejectsUidResidueWithoutHttp() {
  const { writer, calls, audits } = makeWriter();
  await assert.rejects(
    () => writer.writeField('H01', '9001', '1003633', `U${'a'.repeat(33)}`, 'test', 'unit'),
    /值格式不合法/
  );
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(audits[0].status, 'rejected');
}

async function testRejectsFieldNameWrites() {
  const { writer, calls, audits } = makeWriter();
  await assert.rejects(
    () => writer.postFormPath(
      process.env.RAGIC_FORM_Z01,
      { 家教系統uid: `U${'b'.repeat(32)}` },
      { actor: 'test', source: 'unit' }
    ),
    /不是 Field ID/
  );
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(audits[0].status, 'rejected');
}

async function testH01BlocklistWinsOverWhitelist() {
  const { writer, calls, audits } = makeWriter();
  process.env.RAGIC_FIELD_H01_400LINE_MESSAGE = '1003633';
  try {
    await assert.rejects(
      () => writer.writeField('H01', '9001', '1003633', `U${'d'.repeat(32)}`, 'test', 'unit'),
      /BLOCKLIST/
    );
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(audits[0].status, 'rejected');
  } finally {
    delete process.env.RAGIC_FIELD_H01_400LINE_MESSAGE;
  }
}

async function testValidH01UidWritesByFieldId() {
  const { writer, calls, audits } = makeWriter();
  const uid = `U${'c'.repeat(32)}`;
  const data = await writer.writeField('H01', '9001', '1003633', uid, 'test', 'unit');
  assert.strictEqual(data.status, 'SUCCESS');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].method, 'get');
  assert(calls[0].url.endsWith('/9001?api'), calls[0].url);
  assert.strictEqual(calls[1].method, 'post');
  assert(calls[1].url.endsWith('/9001?api'), calls[1].url);
  assert.deepStrictEqual(calls[1].payload, { 1003633: uid });
  assert.strictEqual(audits[0].status, 'success');
  assert.strictEqual(audits[0].oldValue, `U${'e'.repeat(32)}`);
  assert.strictEqual(audits[0].newValue, uid);
}

(async () => {
  await testRejectsUrlIntoH01UidWithoutHttp();
  await testRejectsUidResidueWithoutHttp();
  await testRejectsFieldNameWrites();
  await testH01BlocklistWinsOverWhitelist();
  await testValidH01UidWritesByFieldId();
  console.log('ragic_writer_test: PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
