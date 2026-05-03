/**
 * 報表 (F-M01)
 *   GET /api/admin/reports/revenue          ?from=&to=&coachId=&venueId=&courseType=
 *   GET /api/admin/reports/sessions         ?from=&to=&venueId=&coachId=
 *   GET /api/admin/reports/discounts        ?from=&to=&venueId=
 *   GET /api/admin/reports/mgm-conversion   ?from=&to=&venueId=
 *   GET /api/admin/reports/learning-completion  ?from=&to=&venueId=
 *
 * 預設區間：最近 30 天。staff 強制鎖自己 venue。
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();
router.use(requireAdminAuth, requireAdminRole('admin', 'manager'));

function parseRange(q) {
  const to = q.to || new Date().toISOString().slice(0, 10);
  const from = q.from || (() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  return { from, to };
}

function venueScope(req) {
  if (req.adminUser.role === 'staff') return req.adminUser.venue_id || '__no__';
  return req.query.venueId || null;
}

router.get('/revenue', async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const venueId = venueScope(req);
    const conds = [`cp.created_at::date BETWEEN $1 AND $2`];
    const args = [from, to];
    if (venueId) { args.push(venueId); conds.push(`cp.venue_id = $${args.length}`); }
    if (req.query.coachId) { args.push(req.query.coachId); conds.push(`cp.coach_id = $${args.length}`); }
    if (req.query.courseType) { args.push(Number(req.query.courseType)); conds.push(`cp.course_type = $${args.length}`); }
    const r = await pool.query(
      `SELECT cp.venue_id, cp.coach_id, co.name AS coach_name, cp.course_type,
              COUNT(*)::int AS period_count,
              COALESCE(SUM(cp.original_price),0)::numeric AS original_total,
              COALESCE(SUM(cp.final_price),0)::numeric    AS final_total
         FROM course_periods cp
         JOIN coaches co ON co.id = cp.coach_id
        WHERE ${conds.join(' AND ')}
        GROUP BY cp.venue_id, cp.coach_id, co.name, cp.course_type
        ORDER BY final_total DESC`,
      args
    );
    res.json({ from, to, rows: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sessions', async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const venueId = venueScope(req);
    const conds = [`cp.created_at::date <= $2`];
    const args = [from, to];
    if (venueId) { args.push(venueId); conds.push(`cp.venue_id = $${args.length}`); }
    if (req.query.coachId) { args.push(req.query.coachId); conds.push(`cp.coach_id = $${args.length}`); }
    const r = await pool.query(
      `SELECT cp.venue_id, cp.coach_id, co.name AS coach_name,
              SUM(cp.used_sessions)::int AS used,
              SUM(cp.total_sessions - cp.used_sessions)::int AS remaining,
              SUM(CASE WHEN cp.expires_at < CURRENT_DATE THEN (cp.total_sessions - cp.used_sessions) ELSE 0 END)::int AS expired,
              SUM(CASE WHEN cp.created_at::date BETWEEN $1 AND $2 THEN cp.total_sessions ELSE 0 END)::int AS new_this_period
         FROM course_periods cp JOIN coaches co ON co.id = cp.coach_id
        WHERE ${conds.join(' AND ')}
        GROUP BY cp.venue_id, cp.coach_id, co.name
        ORDER BY used DESC`,
      args
    );
    res.json({ from, to, rows: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/discounts', async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const venueId = venueScope(req);
    const conds = [`pu.created_at::date BETWEEN $1 AND $2`];
    const args = [from, to];
    if (venueId) {
      args.push(venueId);
      conds.push(`(cp.venue_id = $${args.length} OR cp.venue_id IS NULL)`);
    }
    const r = await pool.query(
      `SELECT p.id, p.name, p.coupon_code, p.type,
              COUNT(*)::int AS use_count,
              COALESCE(SUM(pu.discount_amount),0)::int AS discount_total,
              COALESCE(SUM(pu.original_price),0)::int  AS original_total,
              COALESCE(SUM(pu.final_price),0)::int     AS final_total
         FROM promotion_usages pu
         JOIN promotions p ON p.id = pu.promotion_id
         LEFT JOIN course_periods cp ON cp.id = pu.course_period_id
        WHERE ${conds.join(' AND ')}
        GROUP BY p.id, p.name, p.coupon_code, p.type
        ORDER BY use_count DESC`,
      args
    );
    res.json({ from, to, rows: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/mgm-conversion', async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at::date BETWEEN $1 AND $2)::int AS total_links,
         COUNT(*) FILTER (WHERE registered_at::date BETWEEN $1 AND $2)::int AS registered,
         COUNT(*) FILTER (WHERE trial_paid_at::date BETWEEN $1 AND $2)::int AS trial_paid,
         COUNT(*) FILTER (WHERE checked_in_at::date BETWEEN $1 AND $2)::int AS checked_in,
         COUNT(*) FILTER (WHERE reward_issued_at::date BETWEEN $1 AND $2)::int AS rewarded
       FROM referral_records`,
      [from, to]
    );
    const k = r.rows[0];
    const safe = (n, d) => (d > 0 ? Number((n / d * 100).toFixed(1)) : 0);
    res.json({
      from, to,
      kpis: k,
      conversion: {
        register_rate: safe(k.registered, k.total_links),
        trial_rate:    safe(k.trial_paid, k.registered),
        checkin_rate:  safe(k.checked_in, k.trial_paid),
        reward_rate:   safe(k.rewarded,   k.checked_in),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/learning-completion', async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const venueId = venueScope(req);
    const conds = [`cp.created_at::date BETWEEN $1 AND $2`, `co.is_senior = TRUE`];
    const args = [from, to];
    if (venueId) { args.push(venueId); conds.push(`cp.venue_id = $${args.length}`); }
    const r = await pool.query(
      `SELECT cp.coach_id, co.name AS coach_name,
              COUNT(DISTINCT cp.id)::int AS periods,
              COUNT(DISTINCT lp.course_period_id) FILTER (WHERE lp.status='published')::int AS plans_published,
              COUNT(cs.id)::int AS sessions_count,
              COUNT(sr.id) FILTER (WHERE sr.status='submitted')::int AS records_submitted
         FROM course_periods cp
         JOIN coaches co ON co.id = cp.coach_id
         LEFT JOIN lesson_plans lp ON lp.course_period_id = cp.id
         LEFT JOIN course_sessions cs ON cs.course_period_id = cp.id AND cs.status IN ('completed','confirmed')
         LEFT JOIN session_records sr ON sr.course_session_id = cs.id
        WHERE ${conds.join(' AND ')}
        GROUP BY cp.coach_id, co.name
        ORDER BY records_submitted DESC`,
      args
    );
    const rows = r.rows.map((x) => ({
      ...x,
      plan_rate: x.periods > 0 ? Number((x.plans_published / x.periods * 100).toFixed(1)) : 0,
      record_rate: x.sessions_count > 0 ? Number((x.records_submitted / x.sessions_count * 100).toFixed(1)) : 0,
    }));
    res.json({ from, to, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
