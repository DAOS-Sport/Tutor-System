/**
 * /api/admin/mgm-stats — F-M10 MGM 統計報表
 *   GET /                 ?coachId= &venueId= &from=YYYY-MM-DD &to=YYYY-MM-DD
 *      → { total, byStatus, conversionRate, coachRanking[] }
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requireAdminRole('admin', 'manager'));

function isISO(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')); }

router.get('/', async (req, res) => {
  try {
    const { coachId, venueId, from, to } = req.query || {};
    const where = ['1=1'];
    const args = [];
    if (coachId) { args.push(coachId); where.push(`rr.coach_id = $${args.length}`); }
    if (isISO(from)) { args.push(from); where.push(`rr.created_at >= $${args.length}::date`); }
    if (isISO(to))   { args.push(to);   where.push(`rr.created_at <  ($${args.length}::date + INTERVAL '1 day')`); }
    let venueJoin = '';
    if (venueId) {
      args.push(venueId);
      venueJoin = `JOIN coach_venues cv ON cv.coach_id = rr.coach_id AND cv.venue_id = $${args.length}`;
    }

    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM referral_records rr ${venueJoin} WHERE ${where.join(' AND ')}`,
      args
    );
    const byStatus = await pool.query(
      `SELECT rr.status, COUNT(*)::int AS n FROM referral_records rr ${venueJoin}
        WHERE ${where.join(' AND ')} GROUP BY rr.status`,
      args
    );
    const ranking = await pool.query(
      `SELECT c.id AS coach_id, c.name AS coach_name,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE rr.status = 'reward_issued')::int AS rewarded
         FROM referral_records rr
         JOIN coaches c ON c.id = rr.coach_id
         ${venueJoin}
        WHERE ${where.join(' AND ')}
     GROUP BY c.id, c.name
     ORDER BY total DESC, rewarded DESC
        LIMIT 50`,
      args
    );

    const counts = byStatus.rows.reduce((m, x) => { m[x.status] = x.n; return m; }, {});
    const t = total.rows[0].n;
    const issued = counts.reward_issued || 0;
    res.json({
      total: t,
      byStatus: {
        pending: counts.pending || 0,
        registered: counts.registered || 0,
        trial_paid: counts.trial_paid || 0,
        checked_in: counts.checked_in || 0,
        reward_issued: issued,
      },
      conversionRate: t > 0 ? Math.round((issued / t) * 1000) / 10 : 0, // %
      coachRanking: ranking.rows,
    });
  } catch (err) {
    console.error('[admin/mgm-stats]', err);
    res.status(500).json({ error: 'mgm-stats failed' });
  }
});

module.exports = router;
