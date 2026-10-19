const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const checker = path.join(root, 'tests/perf/assert_autocannon.js');
const latency = { p50: 10, p90: 20, p97_5: 30, p99: 40 };

function check(result) {
  const input = typeof result === 'string' ? result : JSON.stringify(result);
  return spawnSync(process.execPath, [checker, 'x'], { input, encoding: 'utf8' });
}

const healthy = check({ '2xx': 500, non2xx: 0, errors: 0, timeouts: 0, latency });
assert.equal(healthy.status, 0, healthy.stderr);
assert.match(healthy.stdout, /PASS x 2xx=500 p50=10ms p90=20ms p97\.5=30ms p99=40ms/);

const allServerErrors = check({ '2xx': 0, non2xx: 31207, errors: 0, timeouts: 0, latency });
assert.equal(allServerErrors.status, 1, '全部回 500 時必須判失敗');
assert.match(allServerErrors.stderr, /non-2xx=31207/);

const serverDown = check({ '2xx': 0, non2xx: 0, errors: 21000, timeouts: 0, latency });
assert.equal(serverDown.status, 1, '伺服器連不上時必須判失敗');
assert.match(serverDown.stderr, /errors=21000/);

const someTimeouts = check({ '2xx': 900, non2xx: 0, errors: 0, timeouts: 3, latency });
assert.equal(someTimeouts.status, 1, '有逾時就不能算成功');

const noOutput = check('');
assert.equal(noOutput.status, 1, 'autocannon 沒輸出時必須判失敗');

const script = fs.readFileSync(path.join(root, 'tests/perf/run_http_baseline.sh'), 'utf8');
assert.doesNotMatch(script, /\|\|\s*true/, 'baseline 腳本不得再用 || true 吞掉失敗');

console.log('PASS perf baseline 只在全部 2xx 且無錯誤/逾時時判成功');
