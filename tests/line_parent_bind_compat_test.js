const assert = require('assert');
const fs = require('fs');
const path = require('path');

const router = require('../server/routes/auth');

const callbackLayer = router.stack.find((entry) => entry.route?.path === '/line/callback');
assert(callbackLayer, 'legacy parent callback compatibility route must exist');

const response = {
  headers: {},
  set(name, value) { this.headers[name] = value; },
  redirect(status, target) { this.status = status; this.target = target; },
};

callbackLayer.route.stack[0].handle({}, response);
assert.strictEqual(response.status, 303);
assert.strictEqual(response.target, '/liff/bind?source=legacy-callback');
assert.strictEqual(response.headers['Cache-Control'], 'no-store');
assert.strictEqual(response.headers['Referrer-Policy'], 'no-referrer');
assert.ok(!response.target.includes('code') && !response.target.includes('state'),
  'legacy callback must not forward OAuth query values into the browser URL');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
assert.ok(indexSource.includes("app.get('/auth/line/callback'"),
  'non-/api legacy callback alias must also be present');
assert.ok(indexSource.includes("'/liff/bind?source=legacy-callback'"),
  'non-/api legacy callback must target the same safe bind entry');
assert.ok(indexSource.includes("res.set('Referrer-Policy', 'no-referrer')"),
  'non-/api legacy callback must not forward callback query via Referer');

const authSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'auth.js'), 'utf8');
const lineAuthSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'lineAuth.js'), 'utf8');
assert.ok(!/line_uid:\s*lineUid/.test(authSource),
  'parent auth responses must not expose the verified full LINE UID');
assert.ok(!lineAuthSource.includes('_tokenFingerprint'),
  'id_token fingerprint logging must stay removed');

console.log('line_parent_bind_compat_test: PASS');
