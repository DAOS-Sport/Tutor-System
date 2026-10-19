'use strict';
const express = require('express');
const { requireAdminAuth } = require('../../middlewares/adminAuth');
const { requireResource, requireAction } = require('../../middlewares/requireResource');
const { createTimeline, createReplayRunner } = require('../../services/ragicTimeline');
function createRouter(service) {
  const router = express.Router();
  // 角色權限 C 期：原本寫死 admin，改為動作權限（預設仍只有系統管理員）。
  router.use(requireAdminAuth, requireResource('ragic-status'), requireAction('ragic-status:timeline'));
  const endpoint = (action) => async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(await action(req)); }
    catch (error) { res.status(error.status || 503).json({ code: /^TIMELINE_[A-Z_]+$/.test(error.code || '') ? error.code : 'TIMELINE_UNAVAILABLE' }); }
  };
  router.get('/', endpoint(() => service.list()));
  router.get('/:id', endpoint((req) => service.get(req.params.id)));
  return router;
}
const previewOptions = process.env.RAGIC_TIMELINE_PREVIEW === '1' ? {
  schema: 'preview_timeline_20260930',
  syntheticOnly: true,
  replay: createReplayRunner('/home/runner/workspace/outputs/preview-ragic-rust-replay-20260930-b193ff3e/sha256-b193ff3ef079c718d3e6cc902bb2ffc46c9ff6b0c3c7fdda333967d4d838bcc5-ragic-shadow-core-linux-x86_64'),
} : {};
const router = createRouter(createTimeline({ pool: require('../../models/db').pool, enabled: process.env.RAGIC_TIMELINE_ENABLED === '1', expectedTargetHash: process.env.RAGIC_TIMELINE_TEST_TARGET_SHA256, ...previewOptions }));
module.exports = router;
module.exports.createRouter = createRouter;
