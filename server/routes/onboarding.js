const express = require('express');
const { pool } = require('../models/db');
const { requireLiffUser } = require('../middlewares/parentAuth');
const { claimTour, TOUR_VERSION } = require('../services/featureTour');
const router = express.Router();

router.post('/claim', requireLiffUser, async (req, res) => {
  // Identity always comes from the verified login, never a supplied account ID.
  if (Object.keys(req.body || {}).length) return res.status(400).json({ error: 'No account parameters allowed' });
  try {
    const show = await claimTour(pool, req.liffUser.type, req.liffUser.id);
    res.set('Cache-Control', 'no-store').json({ show, version: TOUR_VERSION });
  } catch (err) {
    console.error('[onboarding] Claim failed:', err.code || err.name);
    res.status(503).json({ error: '導覽記錄暫時無法讀取' });
  }
});

module.exports = router;
