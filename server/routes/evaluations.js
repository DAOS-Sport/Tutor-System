/**
 * /api/evaluations — 期末評鑑（家長端）
 *
 *  GET  /mine              要我填的 + 已填的
 *  GET  /:id               單筆評鑑（含 prefilled 資料）
 *  POST /:id/submit        提交評分 { score_*, comment, renew_intent }
 */
const express = require('express');
const { requireParent } = require('../middlewares/parentAuth');
const evaluations = require('../services/evaluations');

const router = express.Router();

router.get('/mine', requireParent, async (req, res) => {
  try {
    const list = await evaluations.listForParent(req.parent.id);
    res.json(list);
  } catch (e) {
    console.error('[eval/mine]', e);
    res.status(500).json({ error: 'list failed' });
  }
});

router.get('/:id', requireParent, async (req, res) => {
  try {
    const row = await evaluations.getMine(req.params.id, req.parent.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    console.error('[eval/get]', e);
    res.status(500).json({ error: 'get failed' });
  }
});

router.post('/:id/submit', requireParent, async (req, res) => {
  try {
    const row = await evaluations.submit(req.params.id, req.parent.id, req.body || {});
    res.json(row);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('[eval/submit]', e);
    res.status(500).json({ error: 'submit failed' });
  }
});

module.exports = router;
