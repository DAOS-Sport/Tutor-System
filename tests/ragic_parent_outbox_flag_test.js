'use strict';

const assert = require('assert');
const { envFlag, STABILITY_FLAGS } = require('../server/config/ragicSchema');

const original = process.env.RAGIC_PARENT_OUTBOX;

try {
  for (const value of ['true', 'TRUE', 'TrUe', '1', 'yes', 'YES', 'on', 'ON']) {
    process.env.RAGIC_PARENT_OUTBOX = value;
    assert.strictEqual(envFlag('RAGIC_PARENT_OUTBOX'), true, value);
    assert.strictEqual(STABILITY_FLAGS.RAGIC_PARENT_OUTBOX, true, value);
  }
  for (const value of ['false', 'FALSE', '0', 'no', 'off', 'random']) {
    process.env.RAGIC_PARENT_OUTBOX = value;
    assert.strictEqual(envFlag('RAGIC_PARENT_OUTBOX'), false, value);
    assert.strictEqual(STABILITY_FLAGS.RAGIC_PARENT_OUTBOX, false, value);
  }
  delete process.env.RAGIC_PARENT_OUTBOX;
  assert.strictEqual(STABILITY_FLAGS.RAGIC_PARENT_OUTBOX, false, 'unset must fail closed');
  process.env.RAGIC_PARENT_OUTBOX = '';
  assert.strictEqual(STABILITY_FLAGS.RAGIC_PARENT_OUTBOX, false, 'empty must fail closed');
  console.log('ragic_parent_outbox_flag_test: PASS');
} finally {
  if (original == null) delete process.env.RAGIC_PARENT_OUTBOX;
  else process.env.RAGIC_PARENT_OUTBOX = original;
}
