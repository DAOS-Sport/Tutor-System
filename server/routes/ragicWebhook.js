const express = require('express');
const ragicAdmin = require('../services/ragicAdmin');
const { parseWebhookBody, describeBody } = require('../services/ragicWebhookBody');
const attempts = require('../services/ragicWebhookAttempts');

const router = express.Router();

// 這支路由掛在全域 body parser 之前（見 index.js）：Ragic 沒保證 Content-Type，
// 一律讀成原始文字，交給 ragicWebhookBody 解析。
const readRawText = express.text({ type: () => true, limit: '1mb' });

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

function _requestMeta(req) {
  return {
    method: req.method,
    sheetCode: req.params.sheetCode,
    contentType: req.get('content-type') || null,
    userAgent: req.get('user-agent') || null,
  };
}

router.post('/:sheetCode', readRawText, async (req, res) => {
  const meta = _requestMeta(req);
  const raw = typeof req.body === 'string' ? req.body : '';
  meta.bodyBytes = Buffer.byteLength(raw);
  if (!_authorized(req)) {
    attempts.record({ ...meta, status: 401, outcome: 'unauthorized' });
    return res.status(401).json({ error: 'unauthorized ragic webhook' });
  }
  const body = parseWebhookBody(req.body);
  meta.bodyKind = describeBody(body);
  try {
    const result = await ragicAdmin.handleRagicWebhook(req.params.sheetCode, body);
    attempts.record({ ...meta, idCount: result.count, status: result.ok ? 200 : 503, outcome: result.ok ? 'ok' : 'unavailable' });
    if (!result.ok) res.set('Retry-After', '30');
    res.status(result.ok ? 200 : 503).json(result);
  } catch (err) {
    console.error('[ragic-webhook]', req.params.sheetCode, err.message);
    const invalid = err.code === 'RAGIC_WEBHOOK_INVALID';
    attempts.record({ ...meta, idCount: 0, status: invalid ? 400 : 503, outcome: invalid ? 'invalid_payload' : 'unavailable' });
    res.status(invalid ? 400 : 503).json({ ok: false, error: invalid ? err.message : 'RAGIC_WEBHOOK_UNAVAILABLE' });
  }
});

// Ragic 若用 GET 或其他方法呼叫，也要留下紀錄；否則只是一個看不見的 404。
router.all('/:sheetCode', (req, res) => {
  attempts.record({ ..._requestMeta(req), status: 405, outcome: 'method_not_allowed' });
  res.set('Allow', 'POST').status(405).json({ error: 'method not allowed' });
});

module.exports = router;
