/**
 * 教練資料管理 (F-C-Admin) — Task #32 + Task #53
 *  GET    /api/admin/coaches            → 純讀 DB（fire-and-forget Ragic 同步）
 *                                         支援 ?status=active|inactive|all
 *                                                ?venueId=、?name=、?phone=、?senior=yes|no
 *  POST   /api/admin/coaches/sync       → 立即同步 H01（同步等待）
 *  GET    /api/admin/coaches/:id        → 單一教練詳細
 *  PATCH  /api/admin/coaches/:id        → 更新（翻轉 is_active 會寫 active_overridden_at）
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const { syncCoachesFromRagic, kickoffSyncCoachesAsync } = require('../../services/ragicAdmin');

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

async function listCoachesWithVenues(filterSql, filterParams) {
  const [coachesRes, venuesRes] = await Promise.all([
    pool.query(
      `SELECT c.* FROM coaches c
        ${filterSql.where ? 'WHERE ' + filterSql.where : ''}
        ORDER BY c.is_active DESC, c.name`,
      filterParams
    ),
    pool.query(`SELECT coach_id, venue_id FROM coach_venues`),
  ]);
  const venuesByCoach = new Map();
  for (const row of venuesRes.rows) {
    if (!venuesByCoach.has(row.coach_id)) venuesByCoach.set(row.coach_id, []);
    venuesByCoach.get(row.coach_id).push(row.venue_id);
  }
  let coaches = coachesRes.rows.map((r) => rowToCoach(r, (venuesByCoach.get(r.id) || []).sort()));
  // venueId 過濾必須等取到 M:N 關聯後才能套用
  if (filterSql.venueId) {
    coaches = coaches.filter((c) => c.venue_ids.includes(filterSql.venueId));
  }
  return coaches;
}

router.get('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    kickoffSyncCoachesAsync();
    const { status, venueId, name, phone, senior } = req.query;
    const where = [];
    const params = [];
    if (status === 'active')   where.push(`c.is_active = TRUE`);
    else if (status === 'inactive') where.push(`c.is_active = FALSE`);
    if (name)  { params.push(`%${name}%`);  where.push(`c.name  ILIKE $${params.length}`); }
    if (phone) { params.push(`%${phone}%`); where.push(`c.phone ILIKE $${params.length}`); }
    if (senior === 'yes') where.push(`c.is_senior = TRUE`);
    else if (senior === 'no') where.push(`(c.is_senior IS NULL OR c.is_senior = FALSE)`);

    const coaches = await listCoachesWithVenues(
      { where: where.join(' AND '), venueId: venueId || '' },
      params
    );
    res.json(coaches);
  } catch (err) {
    console.error('[admin/coaches]', err);
    res.status(500).json({ error: 'list coaches failed' });
  }
});

router.post('/sync', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const result = await syncCoachesFromRagic();
    if (result && result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    console.error('[admin/coaches/sync]', err);
    res.status(500).json({ error: 'sync failed' });
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

    if (patch.pricing_multiplier != null) {
      const m = Number(patch.pricing_multiplier);
      if (Number.isNaN(m) || m < MULTIPLIER_MIN || m > MULTIPLIER_MAX) {
        return res.status(400).json({
          error: `修課係數需在 ${MULTIPLIER_MIN.toFixed(2)}–${MULTIPLIER_MAX.toFixed(2)} 之間`,
        });
      }
    }

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
    const activeChanged = patch.is_active != null && (!!patch.is_active) !== !!cur.rows[0].is_active;

    await client.query('BEGIN');
    await client.query(
      `UPDATE coaches SET
         email = $2,
         is_senior = $3,
         pricing_multiplier = $4,
         specialties = $5,
         bio_rich_text = $6,
         is_active = $7,
         active_overridden_at = CASE WHEN $8::boolean THEN NOW() ELSE active_overridden_at END,
         updated_at = NOW()
       WHERE id = $1`,
      [id, merged.email, merged.is_senior, merged.pricing_multiplier, specialties,
       merged.bio_rich_text, merged.is_active, activeChanged]
    );

    if (Array.isArray(patch.venue_ids)) {
      const venueIds = patch.venue_ids.map((v) => String(v).trim()).filter(Boolean);
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
