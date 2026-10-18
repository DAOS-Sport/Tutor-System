'use strict';
// Operator-only development entry. Never change the normal start script to this entry.
const { install } = require('../services/previewOutboundGuard.cjs');
const expectedTargetHash = process.argv[2];
try {
  install({ connectionString: process.env.DATABASE_URL, expectedTargetHash });
  process.env.PREVIEW_SAFE_MODE = '1';
  process.env.MAIL_DRY_RUN = '1';
  process.env.DEMO_SEED = '';
  // The parent process must already supply its environment. Never read .env files.
  const dotenv = require('dotenv');
  dotenv.config = dotenv.configDotenv = () => ({ parsed: {} });
  require('../index');
} catch {
  console.error(JSON.stringify({ event: 'preview_safe_start_refused', code: 'PREVIEW_SAFE_START_FAILED' }));
  process.exit(1);
}
