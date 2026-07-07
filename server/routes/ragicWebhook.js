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
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ragic-webhook]', req.params.sheetCode, err.message);
    res.status(400).json({ error: err.message || 'ragic webhook failed' });
  }
});

module.exports = router;
