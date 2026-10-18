const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('client/shared/ErrorBoundary.jsx', 'utf8');
const stamp = source.slice(source.indexOf('function stamp()'), source.indexOf('export default class'));
for (const [instant, expected] of [
  ['2026-09-08T15:59:59Z', '2026-09-08 23:59:59'],
  ['2026-09-08T16:00:00Z', '2026-09-09 00:00:00'],
]) {
  class Clock extends Date { static now() { return Date.parse(instant); } }
  assert.equal(vm.runInNewContext(stamp + '; stamp()', { Date: Clock }), expected);
}
console.log('PASS error boundary Taipei midnight');
