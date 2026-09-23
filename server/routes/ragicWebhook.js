const express = require('express');
const ragicAdmin = require('../services/ragicAdmin');

const router = express.Router();

function _authorized(req) {
  const secret = String(process.env.RAGIC_WEBHOOK_SECRET || '').trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  const got = String(
    req.get('X-Ragic-Webhook-Secret') ||
    req.get('X-Webhook-Secret') ||
    req.query.secret ||
    ''
  ).trim();
  return got && got === secret;
}

router.post('/:sheetCode', async (req, res) => {
  if (!_authorized(req)) return res.status(401).json({ error: 'unauthorized ragic webhook' });
  try {
    const result = await ragicAdmin.handleRagicWebhook(req.params.sheetCode, req.body);
    if (!result.ok) res.set('Retry-After', '30');
    res.status(result.ok ? 200 : 503).json(result);
  } catch (err) {
    console.error('[ragic-webhook]', req.params.sheetCode, err.message);
    const invalid = err.code === 'RAGIC_WEBHOOK_INVALID';
    res.status(invalid ? 400 : 503).json({ ok: false, error: invalid ? err.message : 'RAGIC_WEBHOOK_UNAVAILABLE' });
  }
});

module.exports = router;
