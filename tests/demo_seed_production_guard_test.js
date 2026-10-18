const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '../server/bootstrap/demoSeed.js');
const source = fs.readFileSync(filename, 'utf8');

(async () => {
  for (const env of [{ NODE_ENV: 'production' }, { REPLIT_DEPLOYMENT: '1' }, {}]) {
    for (const mode of ['seed', '1', 'cleanup', '']) {
      let reads = 0, queries = 0;
      const module = { exports: {} };
      vm.runInNewContext(source, {
        module, __dirname: path.dirname(filename), process: { env: { ...env, DEMO_SEED: mode } },
        console: { log() {}, warn() {}, error() {} },
        require(name) {
          if (name === 'fs') return { readFileSync() { reads++; return 'mock SQL'; } };
          if (name === 'path') return path;
          if (name === '../models/db') return { pool: { async query() { queries++; } } };
          throw new Error(`Unexpected module: ${name}`);
        },
      }, { filename });
      await module.exports.bootstrap();
      const expected = Object.keys(env).length || !mode ? 0 : 1;
      assert.equal(reads, expected, JSON.stringify({ env, mode, operation: 'read SQL' }));
      assert.equal(queries, expected, JSON.stringify({ env, mode, operation: 'execute SQL' }));
    }
  }
  console.log('PASS: production seed/cleanup never reads or executes SQL; development behavior retained');
})().catch(error => { console.error(error); process.exitCode = 1; });
