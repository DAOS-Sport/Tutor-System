/**
 * coaches API（教練主檔）
 * - GET  /api/coaches                            列表（公開：家長端選擇教練）
 * - GET  /api/coaches/by-phone?phone=09xxxx      LIFF 教練端登入：回傳 coach 資訊 + JWT token
 * - GET  /api/coaches/:id                        單筆細節（公開：家長端選擇教練看 bio）
 * - PUT  /api/coaches/:id/bio                    教練自編 bio（須登入且本人）
 * - GET  /api/coaches/:id/media                  介紹媒體列表（公開）
 * - POST /api/coaches/:id/media                  新增介紹媒體（須登入且本人）
 * - PATCH /api/coaches/:id/media/reorder         排序（須登入且本人）
 * - DELETE /api/coaches/:id/media/:mediaId       刪除（須登入且本人）
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { signCoachToken, requireCoach, requireCoachOwner } = require('../middlewares/coachAuth');

/**
 * 將 DB 欄位 pricing_multiplier 同時對外曝露為 multiplier，
 * 維持與既有家長端 (CoachCard, useEnrollmentPricing) 的相容性。
 */
function withMultiplierAlias(row) {
  if (!row) return row;
  const pm = row.pricing_multiplier;
  return { ...row, multiplier: pm == null ? 1 : Number(pm) };
}

async function loadCoach(id) {
  const r = await pool.query(
    `SELECT c.*, COALESCE(
       (SELECT json_agg(cv.venue_id) FROM coach_venues cv WHERE cv.coach_id = c.id),
       '[]'::json
     ) AS venue_ids
     FROM coaches c WHERE c.id = $1`,
    [id]
  );
  return withMultiplierAlias(r.rows[0]) || null;
}

router.get('/', async (req, res) => {
  const { venueId } = req.query;
  try {
    const r = venueId
      ? await pool.query(
          `SELECT c.id, c.name, c.is_senior, c.pricing_multiplier, c.bio_rich_text
           FROM coaches c
           JOIN coach_venues cv ON cv.coach_id = c.id
           WHERE cv.venue_id = $1 AND c.is_active = TRUE
           ORDER BY c.name`,
          [venueId]
        )
      : await pool.query(
          `SELECT id, name, is_senior, pricing_multiplier, bio_rich_text
           FROM coaches WHERE is_active = TRUE ORDER BY name`
        );
    res.json(r.rows.map(withMultiplierAlias));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 教練端登入：以手機作為憑據，回傳 coach + token。
 * 注意：本 MVP 與家長端相同，使用「手機驗證」作為唯一識別；正式版本應以 LINE LIFF id_token 換 token。
 */
router.get('/by-phone', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  try {
    const r = await pool.query(
      `SELECT c.*, COALESCE(
         (SELECT json_agg(cv.venue_id) FROM coach_venues cv WHERE cv.coach_id = c.id),
         '[]'::json
       ) AS venue_ids
       FROM coaches c WHERE c.phone = $1 AND c.is_active = TRUE`,
      [phone]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
    const coach = withMultiplierAlias(r.rows[0]);
    const token = signCoachToken({ coachId: coach.id, phone: coach.phone });
    res.json({ ...coach, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const c = await loadCoach(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/bio', requireCoach, requireCoachOwner('id'), async (req, res) => {
  const { bio_rich_text } = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE coaches SET bio_rich_text = $1, intro_review_status = 'submitted', updated_at = NOW()
       WHERE id = $2 RETURNING id, bio_rich_text, intro_review_status`,
      [bio_rich_text || '', req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/media', async (req, res) => {
  const r = await pool.query(
    `SELECT id, media_type, storage_url, alt_text, sort_order
     FROM coach_bio_media WHERE coach_id = $1 ORDER BY sort_order, created_at`,
    [req.params.id]
  );
  res.json(r.rows);
});

router.post('/:id/media', requireCoach, requireCoachOwner('id'), async (req, res) => {
  const { storage_url, alt_text = '', media_type = 'image' } = req.body || {};
  if (!storage_url) return res.status(400).json({ error: 'storage_url is required' });
  const max = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM coach_bio_media WHERE coach_id = $1`,
    [req.params.id]
  );
  const r = await pool.query(
    `INSERT INTO coach_bio_media (coach_id, media_type, storage_url, alt_text, sort_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.params.id, media_type, storage_url, alt_text, max.rows[0].m + 1]
  );
  res.status(201).json(r.rows[0]);
});

router.patch('/:id/media/reorder', requireCoach, requireCoachOwner('id'), async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids[] required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        `UPDATE coach_bio_media SET sort_order = $1 WHERE id = $2 AND coach_id = $3`,
        [i, ids[i], req.params.id]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: ids.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/:id/media/:mediaId', requireCoach, requireCoachOwner('id'), async (req, res) => {
  const r = await pool.query(
    `DELETE FROM coach_bio_media WHERE id = $1 AND coach_id = $2 RETURNING id`,
    [req.params.mediaId, req.params.id]
  );
  if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

module.exports = router;
