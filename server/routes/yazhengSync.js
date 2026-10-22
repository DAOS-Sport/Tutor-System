'use strict';
/**
 * 雅正轉對帳 API（雅正轉同步 SPEC v1，YZ-A2）：GPT 反查網站拉訂單清單，比對哪些舊課程包已轉進新系統。
 *
 *   GET /api/integrations/yazheng/orders?since=<ISO>&limit=500&cursor=<上一頁的 next>
 *
 * 認證：Authorization: Bearer <YZ_SYNC_API_KEY>（Replit Secrets，至少 32 字元）。
 * 沒設定回 503；不對回 401（不說原因）。欄位白名單在 services/yazhengSync.js 的 SQL。
 */
const crypto = require('crypto');
const express = require('express');
const { listOrders, decodeCursor } = require('../services/yazhengSync');

const router = express.Router();

function keyMatches(header, expected) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

router.get('/orders', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const expected = String(process.env.YZ_SYNC_API_KEY || '').trim();
  if (expected.length < 32) return res.status(503).json({ error: 'YZ_SYNC_NOT_CONFIGURED' });
  if (!keyMatches(req.get('authorization'), expected)) return res.status(401).json({ error: 'UNAUTHORIZED' });

  const since = req.query.since ? String(req.query.since) : null;
  if (since && Number.isNaN(Date.parse(since))) return res.status(400).json({ error: 'BAD_SINCE' });
  let after = null;
  try {
    after = decodeCursor(req.query.cursor);
  } catch {
    return res.status(400).json({ error: 'BAD_CURSOR' });
  }
  try {
    const page = await listOrders({ since, after, limit: req.query.limit });
    res.json({ generated_at: new Date().toISOString(), ...page });
  } catch (err) {
    console.error('[integrations/yazheng]', err.code || err.message);
    res.status(503).json({ error: 'YZ_SYNC_UNAVAILABLE' });
  }
});

module.exports = router;
