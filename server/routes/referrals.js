/**
 * /api/referrals — MGM 推薦連結 (F-S10)
 *  POST /                            建立推薦連結（家長 JWT；body: { coach_id }）
 *  GET  /by-token/:token             公開查詢（LIFF RegisterPage 用以顯示推薦人/教練）
 *  GET  /mine                        家長自己已產生過的推薦連結（含狀態）
 *
 * 短連結 redirect /r/:token 由 server/index.js 直接掛載到根路徑。
 */
const express = require('express');
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');
const referrals = require('../services/referrals');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/', requireParent, async (req, res) => {
  try {
    const coachId = String(req.body?.coach_id || '').trim();
    if (!UUID_RE.test(coachId)) return res.status(400).json({ error: 'invalid coach_id' });
    const cr = await pool.query(`SELECT id FROM coaches WHERE id = $1 AND is_active = TRUE`, [coachId]);
    if (!cr.rowCount) return res.status(404).json({ error: 'coach not found' });
    const link = await referrals.createReferralLink({ parentId: req.parent.id, coachId });
    const host = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      id: link.id,
      token: link.token,
      url: `${host}/r/${link.token}`,
    });
  } catch (err) {
    console.error('[referrals.create]', err);
    res.status(500).json({ error: 'create referral failed' });
  }
});

router.get('/by-token/:token', async (req, res) => {
  try {
    const link = await referrals.findByToken(req.params.token);
    if (!link) return res.status(404).json({ error: 'token not found' });
    res.json({
      token: link.token,
      coach: { id: link.coach_id, name: link.coach_name, is_senior: link.is_senior, multiplier: Number(link.pricing_multiplier) || 1 },
      referrer: { name: link.referrer_name },
      status: link.status,
      already_bound: !!link.referee_phone,
    });
  } catch (err) {
    console.error('[referrals.by-token]', err);
    res.status(500).json({ error: 'lookup failed' });
  }
});

router.get('/mine', requireParent, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT rr.id, rr.token, rr.coach_id, c.name AS coach_name, rr.status,
              rr.referee_phone, rr.created_at, rr.reward_issued_at
         FROM referral_records rr
         JOIN coaches c ON c.id = rr.coach_id
        WHERE rr.referrer_parent_id = $1
        ORDER BY rr.created_at DESC`,
      [req.parent.id]
    );
    const host = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
    res.json(r.rows.map((x) => ({
      id: x.id, token: x.token, url: `${host}/r/${x.token}`,
      coach: { id: x.coach_id, name: x.coach_name },
      status: x.status, referee_phone: x.referee_phone,
      created_at: x.created_at, reward_issued_at: x.reward_issued_at,
    })));
  } catch (err) {
    console.error('[referrals.mine]', err);
    res.status(500).json({ error: 'list failed' });
  }
});

module.exports = router;
