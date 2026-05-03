/**
 * 教練資料管理 (F-C-Admin) — Task #32
 *  GET    /api/admin/coaches          → 全部教練（先 best-effort sync H01）
 *                                        含 venue_ids、line 綁定狀態、簡介審核狀態
 *  GET    /api/admin/coaches/:id      → 單一教練詳細（含 bio_media 與可教場館）
 *  PATCH  /api/admin/coaches/:id      → 更新 is_senior / pricing_multiplier(1.0–1.5) /
 *                                        specialties / bio_rich_text / email / is_active /
 *                                        venue_ids（M:N, 全量替換）
 *
 * 注意：H01 沒有「教練可教場館」欄位 → coach_venues 由後台手動維護。
 * 系統內部欄位（is_senior / multiplier / bio / specialties / intro_review_status / line_uid）
 * 在 Ragic 同步時不會被覆寫。
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const { syncCoachesFromRagic } = require('../../services/ragicAdmin');

const router = express.Router();

const MULTIPLIER_MIN = 1.00;
const MULTIPLIER_MAX = 1.50;

function rowToCoach(r, venueIds = []) {
  return {
    id: r.id,
    ragic_employee_id: r.ragic_employee_id,
    name: r.name,
    phone: r.phone,
    email: r.email || '',
    line_uid: r.line_uid || '',
    line_bound: !!r.line_uid,
    is_senior: !!r.is_senior,
    pricing_multiplier: Number(r.pricing_multiplier),
    specialties: Array.isArray(r.specialties) ? r.specialties : [],
    bio_rich_text: r.bio_rich_text || '',
    is_active: !!r.is_active,
    intro_review_status: r.intro_review_status || 'draft',
    venue_ids: venueIds,
  };
}

/** 一次撈 coach + 對應 venue_ids（避免 N+1）。回傳 [{...coach, venue_ids}] */
async function listCoachesWithVenues() {
  const [coachesRes, venuesRes] = await Promise.all([
    pool.query(`SELECT * FROM coaches ORDER BY is_active DESC, name`),
    pool.query(`SELECT coach_id, venue_id FROM coach_venues`),
  ]);
  const venuesByCoach = new Map();
  for (const row of venuesRes.rows) {
    if (!venuesByCoach.has(row.coach_id)) venuesByCoach.set(row.coach_id, []);
    venuesByCoach.get(row.coach_id).push(row.venue_id);
  }
  return coachesRes.rows.map((r) => rowToCoach(r, (venuesByCoach.get(r.id) || []).sort()));
}

router.get('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    await syncCoachesFromRagic(); // best-effort
    const coaches = await listCoachesWithVenues();
    res.json(coaches);
  } catch (err) {
    console.error('[admin/coaches]', err);
    res.status(500).json({ error: 'list coaches failed' });
  }
});

router.get('/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const cur = await pool.query(`SELECT * FROM coaches WHERE id = $1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'coach not found' });
    const [venuesRes, mediaRes] = await Promise.all([
      pool.query(`SELECT venue_id FROM coach_venues WHERE coach_id = $1 ORDER BY venue_id`, [id]),
      pool.query(
        `SELECT id, media_type, storage_url, alt_text, sort_order
           FROM coach_bio_media WHERE coach_id = $1 ORDER BY sort_order, id`,
        [id]
      ),
    ]);
    const coach = rowToCoach(cur.rows[0], venuesRes.rows.map((r) => r.venue_id));
    res.json({ ...coach, bio_media: mediaRes.rows });
  } catch (err) {
    console.error('[admin/coaches/:id GET]', err);
    res.status(500).json({ error: 'get coach failed' });
  }
});

router.patch('/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const patch = req.body || {};
    const cur = await client.query(`SELECT * FROM coaches WHERE id = $1`, [id]);
    if (!cur.rowCount) {
      return res.status(404).json({ error: 'coach not found' });
    }

    // 修課係數驗證
    if (patch.pricing_multiplier != null) {
      const m = Number(patch.pricing_multiplier);
      if (Number.isNaN(m) || m < MULTIPLIER_MIN || m > MULTIPLIER_MAX) {
        return res.status(400).json({
          error: `修課係數需在 ${MULTIPLIER_MIN.toFixed(2)}–${MULTIPLIER_MAX.toFixed(2)} 之間`,
        });
      }
    }

    // specialties: 接受 array 或 null（轉空陣列）
    let specialties = cur.rows[0].specialties || [];
    if (patch.specialties !== undefined) {
      if (!Array.isArray(patch.specialties)) {
        return res.status(400).json({ error: 'specialties 必須為陣列' });
      }
      specialties = patch.specialties.map((s) => String(s).trim()).filter(Boolean);
    }

    const merged = {
      email: patch.email !== undefined ? String(patch.email || '') : (cur.rows[0].email || ''),
      is_senior: patch.is_senior != null ? !!patch.is_senior : !!cur.rows[0].is_senior,
      pricing_multiplier: patch.pricing_multiplier != null
        ? Number(patch.pricing_multiplier)
        : Number(cur.rows[0].pricing_multiplier),
      bio_rich_text: patch.bio_rich_text !== undefined
        ? String(patch.bio_rich_text || '')
        : (cur.rows[0].bio_rich_text || ''),
      is_active: patch.is_active != null ? !!patch.is_active : !!cur.rows[0].is_active,
    };

    await client.query('BEGIN');
    await client.query(
      `UPDATE coaches SET
         email = $2,
         is_senior = $3,
         pricing_multiplier = $4,
         specialties = $5,
         bio_rich_text = $6,
         is_active = $7,
         updated_at = NOW()
       WHERE id = $1`,
      [id, merged.email, merged.is_senior, merged.pricing_multiplier, specialties,
       merged.bio_rich_text, merged.is_active]
    );

    // 可教場館 M:N 全量替換（只有 patch 有給 venue_ids 才動）
    if (Array.isArray(patch.venue_ids)) {
      const venueIds = patch.venue_ids.map((v) => String(v).trim()).filter(Boolean);
      // 驗證所有 venue 存在且為履約中（已軟下架的 stale 場館不可指派）
      if (venueIds.length > 0) {
        const vr = await client.query(
          `SELECT id FROM venues WHERE id = ANY($1::varchar[]) AND is_active = TRUE`,
          [venueIds]
        );
        if (vr.rows.length !== venueIds.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: '部分場館代碼不存在或已下架' });
        }
      }
      await client.query(`DELETE FROM coach_venues WHERE coach_id = $1`, [id]);
      for (const vid of venueIds) {
        await client.query(
          `INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, vid]
        );
      }
    }
    await client.query('COMMIT');

    // 回傳完整最新狀態
    const [after, vAfter] = await Promise.all([
      pool.query(`SELECT * FROM coaches WHERE id = $1`, [id]),
      pool.query(`SELECT venue_id FROM coach_venues WHERE coach_id = $1 ORDER BY venue_id`, [id]),
    ]);
    res.json(rowToCoach(after.rows[0], vAfter.rows.map((r) => r.venue_id)));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    console.error('[admin/coaches/:id PATCH]', err);
    res.status(500).json({ error: 'update coach failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
