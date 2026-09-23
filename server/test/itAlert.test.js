const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(replies, configured = true) {
  const calls = [], warnings = [], delays = [];
  const context = {
    module: { exports: {} },
    process: { env: configured ? { LINE_IT_GROUP_ID: 'test-target', LINE_MESSAGING_TOKENS: '{"dreams400":"secret-token"}' } : {} },
    console: { warn: (...args) => warnings.push(args) },
    setTimeout: (fn, ms) => { delays.push(ms); fn(); },
    require: name => {
      if (name === 'node:crypto') return { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' };
      assert.equal(name, 'axios');
      return { post: async (...args) => {
        calls.push(args);
        const reply = replies.shift();
        assert.ok(reply, 'unexpected outbound attempt');
        if (reply.error) throw Object.assign(new Error('secret-token private body'), { code: reply.error });
        return reply;
      } };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/itAlert.js'), 'utf8'), context);
  return { push: () => context.module.exports.pushCoachUnbound({ lineUid: 'private-line', name: 'test' }), calls, warnings, delays };
}

test('IT alert reports accepted 2xx and skips unconfigured sends', async () => {
  for (const status of [200, 202, 204]) {
    const f = fixture([{ status }]); assert.equal(await f.push(), true); assert.equal(f.calls.length, 1);
  }
  const f = fixture([], false); assert.equal(await f.push(), false); assert.equal(f.calls.length, 0);
});
test('IT alert rejects 4xx, redirects and unconfirmed 409 without retry', async () => {
  for (const status of [301, 400, 401, 403, 409, 429]) {
    const f = fixture([{ status, data: { message: 'secret-token private body' } }]);
    assert.equal(await f.push(), false); assert.equal(f.calls.length, 1);
    assert.equal(f.warnings[0][1].status, status);
    assert.doesNotMatch(JSON.stringify(f.warnings), /secret-token|private body/);
  }
});
test('IT alert retries 5xx with identical recipient, payload and retry key', async () => {
  const f = fixture([{ status: 500 }, { status: 503 }, { status: 200 }]);
  assert.equal(await f.push(), true); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.delays, [250, 500]);
  for (const c of f.calls) {
    assert.equal(c[1], f.calls[0][1]);
    assert.equal(c[2].headers['X-Line-Retry-Key'], f.calls[0][2].headers['X-Line-Retry-Key']);
    assert.equal(c[2].timeout, 8000);
  }
});
test('IT alert recognizes LINE accepted retry response after timeout', async () => {
  const f = fixture([{ error: 'ECONNABORTED' }, { status: 409, headers: { 'x-line-accepted-request-id': 'accepted' } }]);
  assert.equal(await f.push(), true); assert.equal(f.calls.length, 2);
  assert.equal(f.warnings[0][1].code, 'TIMEOUT');
});
test('IT alert bounds repeated timeout and 5xx failures and redacts errors', async () => {
  for (const reply of [{ error: 'ETIMEDOUT' }, { error: 'ECONNRESET' }, { status: 503 }]) {
    const f = fixture([reply, reply, reply]);
    assert.equal(await f.push(), false); assert.equal(f.calls.length, 3);
    assert.doesNotMatch(JSON.stringify(f.warnings), /secret-token|private body|private-line/);
  }
});
