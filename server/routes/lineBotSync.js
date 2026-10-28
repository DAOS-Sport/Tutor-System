'use strict';
/**
 * LINE 小助理教練查課：拉取 API（SPEC §4.3，比照雅正轉對帳 API）。
 *
 *   GET /api/integrations/line-bot/coaches?since=<ISO>&limit=100&after_id=<coach_id>
 *
 * 用途：第一次匯入、手動重新對帳、驗收比筆數。不帶 since 就是小助理該有的全部教練。
 * 認證：Authorization: Bearer <LB_SYNC_API_KEY>（Replit Secrets，至少 32 字元）。沒設定回 503；不對回 401（不說原因）。
 * 欄位白名單在 services/lineBotSync.js。
 */
const crypto = require('crypto');
const express = require('express');
const { listCoaches } = require('../services/lineBotSync');

const router = express.Router();

function keyMatches(header, expected) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/coaches', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const expected = String(process.env.LB_SYNC_API_KEY || '').trim();
  if (expected.length < 32) return res.status(503).json({ error: 'LB_SYNC_NOT_CONFIGURED' });
  if (!keyMatches(req.get('authorization'), expected)) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const since = req.query.since ? String(req.query.since) : null;
  if (since && Number.isNaN(Date.parse(since))) return res.status(400).json({ error: 'BAD_SINCE' });
  const afterId = req.query.after_id ? String(req.query.after_id) : null;
  if (afterId && !UUID.test(afterId)) return res.status(400).json({ error: 'BAD_AFTER_ID' });
  try {
    const page = await listCoaches({ since, afterId, limit: req.query.limit });
    res.json({ generated_at: new Date().toISOString(), ...page });
  } catch (err) {
    console.error('[integrations/line-bot]', err.code || err.message);
    res.status(503).json({ error: 'LB_SYNC_UNAVAILABLE' });
  }
});

module.exports = router;
