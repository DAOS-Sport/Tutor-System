'use strict';
/**
 * GET /api/health/pipelines：給監控中樞（tools/health-hub）讀的 health-v1 報告。
 * 不走後台登入，在這裡自己驗 HEALTH_TOKEN：沒設定回 503，token 不對回 401。
 * 報告含各管線的錯誤摘要，所以一律不給快取。
 */
const crypto = require('crypto');
const express = require('express');
const { buildHealthReport } = require('../services/healthSignals');

const router = express.Router();

function tokenMatches(received, expected) {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get('/pipelines', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const expected = String(process.env.HEALTH_TOKEN || '').trim();
  if (!expected) return res.status(503).json({ error: 'HEALTH_TOKEN_NOT_CONFIGURED' });
  const header = String(req.get('authorization') || '');
  const received = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!received || !tokenMatches(received, expected)) return res.status(401).json({ error: 'INVALID_HEALTH_TOKEN' });
  try {
    res.json(await buildHealthReport(new Date()));
  } catch (err) {
    console.error('[health/pipelines]', err.message);
    res.status(500).json({ error: 'HEALTH_REPORT_FAILED' });
  }
});

module.exports = router;
