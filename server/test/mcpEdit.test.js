'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('MCP edit preserves literal dollar replacement tokens', () => {
  const source = fs.readFileSync(path.join(__dirname, '../mcp/index.js'), 'utf8');
  const expression = source.match(/const updated = ([\s\S]*?);/);
  assert.ok(expression, 'MCP edit expression must be found');
  for (const replace_all of [false, true]) {
    const new_string = "$$ $& $` $' $1";
    const actual = vm.runInNewContext(expression[1], {
      original: 'before TARGET after', old_string: 'TARGET', new_string, replace_all,
    });
    assert.equal(actual, 'before ' + new_string + ' after');
  }
});
