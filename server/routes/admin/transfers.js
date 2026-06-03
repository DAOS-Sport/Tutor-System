/**
 * 課程轉讓審核 (F-M04)
 *   GET  /api/admin/transfers           ?status= &venueId=
 *   POST /api/admin/transfers/:id/approve  body: { note? }
 *   POST /api/admin/transfers/:id/reject   body: { note }
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole, getScopedVenueIds, isVenueInScope } = require('../../middlewares/adminAuth');

async function assertTransferInScope(req, transferId) {
  const r = await pool.query(
    `SELECT cp.venue_id
       FROM transfer_records tr
       JOIN course_periods cp ON cp.id = tr.course_period_id
      WHERE tr.id = $1`,
    [transferId]
  );
  if (!r.rowCount) return { ok: false, status: 404, error: 'transfer not found' };
  if (!isVenueInScope(req, r.rows[0].venue_id)) {
    return { ok: false, status: 403, error: '此轉讓不在您的場館範圍內' };
  }
  return { ok: true };
}
const transfers = require('../../services/transfers');
const line = require('../../services/line');

const router = express.Router();

router.get('/', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    // Task #90：staff/manager 鎖自己所屬全部場館
    const scope = getScopedVenueIds(req);
    const venueIds = scope || (req.query.venueId ? [String(req.query.venueId)] : null);
    const list = await transfers.listForAdmin({ status: req.query.status, venueIds });
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function notifyBoth(rec, approved, note) {
  try {
    const meta = await pool.query(
      `SELECT co.name AS coach_name, cp.venue_id, cp.course_type,
              fp.line_uid AS from_uid, tp.line_uid AS to_uid
         FROM course_periods cp
         JOIN coaches co ON co.id = cp.coach_id
         JOIN parents fp ON fp.id = $1
         LEFT JOIN parents tp ON tp.id = $2
        WHERE cp.id = $3`,
      [rec.from_parent_id, rec.to_parent_id, rec.course_period_id]
    );
    const m = meta.rows[0];
    if (!m) return;
    const courseInfo = `${m.coach_name} 教練・1 對 ${m.course_type}`;
    const msg = line.templates.transferReviewed({ approved, courseInfo, note });
    for (const uid of [m.from_uid, m.to_uid].filter(Boolean)) {
      try { await line.pushMessage(uid, msg, m.venue_id); }
      catch (e) { console.warn('[transfers] notify failed:', e.message); }
    }
  } catch (e) { console.warn('[transfers] notify lookup failed:', e.message); }
}

router.post('/:id/approve', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const scope = await assertTransferInScope(req, req.params.id);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const r = await transfers.approve({ id: req.params.id, adminUserId: req.adminUser.sub, note: req.body?.note });
    notifyBoth(r, true, req.body?.note);
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/:id/reject', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  if (!req.body?.note) return res.status(400).json({ error: '拒絕原因必填' });
  try {
    const scope = await assertTransferInScope(req, req.params.id);
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    const r = await transfers.reject({ id: req.params.id, adminUserId: req.adminUser.sub, note: req.body.note });
    notifyBoth(r, false, req.body.note);
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
