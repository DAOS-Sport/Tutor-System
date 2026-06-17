/**
 * 後台優惠活動管理 (F-M07 主管 CRUD + 送審 / F-A05 管理員核准 / F-R05 active 列表)
 *
 *   GET    /api/admin/promotions                 list (?status=&q=)
 *   POST   /api/admin/promotions                 create draft (manager/admin)
 *   GET    /api/admin/promotions/:id             detail + audit logs + usage count
 *   PATCH  /api/admin/promotions/:id             edit (僅 draft/rejected 可改；admin 可改 active)
 *   POST   /api/admin/promotions/:id/submit      manager 送審 → pending_review
 *   POST   /api/admin/promotions/:id/approve     admin 核准 → active
 *   POST   /api/admin/promotions/:id/reject      admin 拒絕（含 note）
 *   POST   /api/admin/promotions/:id/archive     停用 → archived
 *   GET    /api/admin/promotions/active          R05 唯讀
 */
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();
router.use(requireAdminAuth);

const PROMO_FIELDS = `id, name, description, type, discount_value,
  min_threshold_type, min_threshold_value, applicable_course_types, applicable_venue_ids,
  coupon_code, start_date, end_date, max_uses, current_uses, status, review_note,
  created_by, reviewed_by, reviewed_at, submitted_at, created_at, updated_at`;

function genCouponCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars
}

function validatePayload(p) {
  const errs = [];
  if (!p.name || p.name.length > 100) errs.push('name 必填且 ≤100');
  if (!['PERCENTAGE', 'FIXED_AMOUNT'].includes(p.type)) errs.push('type 必須為 PERCENTAGE / FIXED_AMOUNT');
  const v = Number(p.discount_value);
  if (!Number.isFinite(v) || v <= 0) errs.push('discount_value 必須 > 0');
  if (p.type === 'PERCENTAGE' && (v <= 0 || v >= 1)) errs.push('折數 PERCENTAGE 必須 0 < v < 1（如 0.9 = 9折）');
  if (!p.start_date || !p.end_date) errs.push('start_date / end_date 必填');
  if (p.start_date && p.end_date && p.end_date < p.start_date) errs.push('end_date 不可早於 start_date');
  if (p.min_threshold_type && p.min_threshold_type !== 'PERIOD_COUNT') errs.push('min_threshold_type 僅支援 PERIOD_COUNT');
  if (p.applicable_course_types && !Array.isArray(p.applicable_course_types)) errs.push('applicable_course_types 必須為陣列');
  if (p.applicable_venue_ids && !Array.isArray(p.applicable_venue_ids)) errs.push('applicable_venue_ids 必須為陣列');
  return errs;
}

async function audit(client, promotionId, action, byUser, note) {
  await (client || pool).query(
    `INSERT INTO promotion_audit_logs (promotion_id, action, by_user, note) VALUES ($1,$2,$3,$4)`,
    [promotionId, action, byUser || null, note || null]
  );
}

router.get('/', requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const { status, q } = req.query;
    const where = [];
    const args = [];
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    if (q) { args.push(`%${q}%`); where.push(`(name ILIKE $${args.length} OR coupon_code ILIKE $${args.length})`); }
    const sql = `SELECT ${PROMO_FIELDS} FROM promotions
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT 200`;
    const r = await pool.query(sql, args);
    res.json(r.rows);
  } catch (err) {
    console.error('[admin promotions list]', err);
    res.status(500).json({ error: 'list failed' });
  }
});

router.get('/active', requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${PROMO_FIELDS} FROM promotions
        WHERE status = 'active' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
          AND (max_uses IS NULL OR current_uses < max_uses)
        ORDER BY end_date ASC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin promotions active]', err);
    res.status(500).json({ error: 'list active failed' });
  }
});

router.get('/:id', requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT ${PROMO_FIELDS} FROM promotions WHERE id = $1`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    const audits = await pool.query(
      `SELECT a.action, a.note, a.created_at, u.name AS by_name
         FROM promotion_audit_logs a LEFT JOIN admin_users u ON u.id = a.by_user
        WHERE a.promotion_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
      [req.params.id]
    );
    const usage = await pool.query(
      `SELECT COUNT(*)::int AS used, COALESCE(SUM(discount_amount),0)::int AS total_discount
         FROM promotion_usages WHERE promotion_id = $1`,
      [req.params.id]
    );
    res.json({ ...r.rows[0], audit_logs: audits.rows, usage: usage.rows[0] });
  } catch (err) {
    console.error('[admin promotion detail]', err);
    res.status(500).json({ error: 'detail failed' });
  }
});

router.post('/', requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const p = req.body || {};
    const errs = validatePayload(p);
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });

    let coupon = p.coupon_code ? String(p.coupon_code).trim().toUpperCase() : null;
    if (p.generate_coupon_code) coupon = genCouponCode();

    const r = await pool.query(
      `INSERT INTO promotions (name, description, type, discount_value,
         min_threshold_type, min_threshold_value, applicable_course_types, applicable_venue_ids,
         coupon_code, start_date, end_date, max_uses, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13)
       RETURNING ${PROMO_FIELDS}`,
      [
        p.name, p.description || '', p.type, p.discount_value,
        p.min_threshold_type || null, p.min_threshold_value || null,
        p.applicable_course_types && p.applicable_course_types.length ? p.applicable_course_types : null,
        p.applicable_venue_ids && p.applicable_venue_ids.length ? p.applicable_venue_ids : null,
        coupon, p.start_date, p.end_date, p.max_uses || null, req.adminUser.sub,
      ]
    );
    await audit(null, r.rows[0].id, 'create', req.adminUser.sub, null);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '折價券代碼已存在' });
    console.error('[admin promotion create]', err);
    res.status(500).json({ error: 'create failed' });
  }
});

router.patch('/:id', requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const cur = await pool.query(`SELECT * FROM promotions WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not found' });
    const old = cur.rows[0];
    const role = req.adminUser.role;
    // manager 只能改 draft / rejected；admin 額外允許改 active（用於微調 description / max_uses）
    // 任何角色都不得直接改 pending_review（請先 reject）或 archived
    const editable = role === 'admin'
      ? ['draft', 'rejected', 'active']
      : ['draft', 'rejected'];
    if (!editable.includes(old.status)) {
      return res.status(400).json({ error: `狀態 ${old.status} 不可編輯` });
    }
    const p = { ...old, ...req.body };
    const errs = validatePayload(p);
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });

    const r = await pool.query(
      `UPDATE promotions SET
         name=$2, description=$3, type=$4, discount_value=$5,
         min_threshold_type=$6, min_threshold_value=$7,
         applicable_course_types=$8, applicable_venue_ids=$9,
         coupon_code=$10, start_date=$11, end_date=$12, max_uses=$13,
         updated_at=NOW()
       WHERE id=$1 RETURNING ${PROMO_FIELDS}`,
      [
        old.id, p.name, p.description || '', p.type, p.discount_value,
        p.min_threshold_type || null, p.min_threshold_value || null,
        p.applicable_course_types && p.applicable_course_types.length ? p.applicable_course_types : null,
        p.applicable_venue_ids && p.applicable_venue_ids.length ? p.applicable_venue_ids : null,
        p.coupon_code ? String(p.coupon_code).toUpperCase() : null,
        p.start_date, p.end_date, p.max_uses || null,
      ]
    );
    await audit(null, old.id, 'edit', req.adminUser.sub, null);
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '折價券代碼已存在' });
    console.error('[admin promotion patch]', err);
    res.status(500).json({ error: 'update failed' });
  }
});

async function transition(req, res, fromStatuses, toStatus, action, requiredRoles) {
  const role = req.adminUser.role;
  if (!requiredRoles.includes(role)) return res.status(403).json({ error: '權限不足' });
  const cur = await pool.query(`SELECT status FROM promotions WHERE id = $1`, [req.params.id]);
  if (!cur.rowCount) return res.status(404).json({ error: 'not found' });
  if (!fromStatuses.includes(cur.rows[0].status)) {
    return res.status(400).json({ error: `當前狀態 ${cur.rows[0].status} 無法執行 ${action}` });
  }
  const note = (req.body && req.body.note) || null;
  const sets = [`status = $2`, `updated_at = NOW()`];
  const args = [req.params.id, toStatus];
  if (toStatus === 'pending_review') sets.push(`submitted_at = NOW()`);
  if (toStatus === 'active' || toStatus === 'rejected') {
    sets.push(`reviewed_at = NOW()`, `reviewed_by = $${args.length + 1}`);
    args.push(req.adminUser.sub);
  }
  if (note) {
    sets.push(`review_note = $${args.length + 1}`);
    args.push(note);
  }
  const r = await pool.query(
    `UPDATE promotions SET ${sets.join(', ')} WHERE id = $1 RETURNING ${PROMO_FIELDS}`,
    args
  );
  await audit(null, req.params.id, action, req.adminUser.sub, note);
  res.json(r.rows[0]);
}

router.post('/:id/submit',  (req, res) => transition(req, res, ['draft', 'rejected'], 'pending_review', 'submit',  ['admin', 'manager']).catch((e) => { console.error(e); res.status(500).json({ error: 'submit failed' }); }));
router.post('/:id/approve', (req, res) => transition(req, res, ['pending_review'],  'active',         'approve', ['admin', 'manager']).catch((e) => { console.error(e); res.status(500).json({ error: 'approve failed' }); }));
router.post('/:id/reject',  (req, res) => {
  const note = (req.body && req.body.note ? String(req.body.note).trim() : '');
  if (!note) return res.status(400).json({ error: '退回時必須填寫退回原因' });
  return transition(req, res, ['pending_review'], 'rejected', 'reject', ['admin', 'manager']).catch((e) => { console.error(e); res.status(500).json({ error: 'reject failed' }); });
});
router.post('/:id/archive', (req, res) => transition(req, res, ['draft', 'pending_review', 'active', 'rejected'], 'archived', 'archive', ['admin', 'manager']).catch((e) => { console.error(e); res.status(500).json({ error: 'archive failed' }); }));

module.exports = router;
