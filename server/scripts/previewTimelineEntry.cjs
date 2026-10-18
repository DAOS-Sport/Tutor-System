'use strict';
// Dedicated synthetic Preview timeline entry; never used by the normal start script.
const fs = require('node:fs'), crypto = require('node:crypto');
const target = 'e7eef8e210c8f91f9c9a8c1c9d6d3ec9db0e3568323ce3bb2ddb2c09dabe1a3d';
const keyOperator = '/home/runner/workspace/outputs/preview-ragic-keyring-operator-20260930/operator.cjs';
const keyOperatorSha = 'c99a8774975279082f72117435d4ddb923abbcab7f53af9fac9adf6cc30fbdfc';
const binary = '/home/runner/workspace/outputs/preview-ragic-rust-replay-20260930-b193ff3e/sha256-b193ff3ef079c718d3e6cc902bb2ffc46c9ff6b0c3c7fdda333967d4d838bcc5-ragic-shadow-core-linux-x86_64';
let phase = "target";
try {
  if (process.argv.length !== 3 || process.argv[2] !== target) throw Error('target');
  phase = "operator_hash";
  if (crypto.createHash('sha256').update(fs.readFileSync(keyOperator)).digest('hex') !== keyOperatorSha) throw Error('operator');
  phase = "test_keyring";
  const keys = require(keyOperator)._testing.childEnvironmentAt('/home/runner', true);
  phase = "outbound_guard";
  require('../services/previewOutboundGuard.cjs').install({ connectionString: process.env.DATABASE_URL, expectedTargetHash: target, replayPolicy: { binary, sha256: 'b193ff3ef079c718d3e6cc902bb2ffc46c9ff6b0c3c7fdda333967d4d838bcc5' } });
  Object.assign(process.env, keys, { PREVIEW_SAFE_MODE: '1', MAIL_DRY_RUN: '1', DEMO_SEED: '', RAGIC_INCREMENTAL_MODE: 'off', RAGIC_TIMELINE_PREVIEW: '1', RAGIC_TIMELINE_ENABLED: '1', RAGIC_TIMELINE_TEST_TARGET_SHA256: target });
  const dotenv = require('dotenv'); dotenv.config = dotenv.configDotenv = () => ({ parsed: {} });
  phase = "app_bootstrap";
  require('../index');
} catch (error) {
  console.error(JSON.stringify({ event: 'preview_timeline_start_refused', code: 'PREVIEW_TIMELINE_START_FAILED', phase, reason: ["ENOENT", "EACCES", "EPERM", "MODULE_NOT_FOUND", "KEY_ANCESTOR_INVALID", "KEY_DIRECTORY_INVALID", "KEY_DIRECTORY_MODE_INVALID", "KEY_FILE_CHANGED", "KEY_FILE_FORMAT_INVALID", "KEY_FILE_INVALID", "KEY_FILE_PERMISSIONS_INVALID", "KEY_FILE_SIZE_INVALID", "KEY_FIXED_LINUX_PATH_REQUIRED", "KEY_OWNER_INVALID", "KEY_PENDING_PRESENT"].includes(error?.code) ? error.code : 'CHECK_FAILED' })); process.exit(1);
}

