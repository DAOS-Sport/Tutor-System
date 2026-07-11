/**
 * 後台優惠活動管理 (F-M07 主管 CRUD / F-A05 管理員 / F-R05 active 列表)
 *
 * 改版：移除送審流程，草稿 → 啟用中 → 已停用（直接上架，無審核者）。
 *
 *   GET    /api/admin/promotions                 list (?status=&q=)
 *   POST   /api/admin/promotions                 create draft (manager/admin)
 *   GET    /api/admin/promotions/:id             detail + audit logs + usage count
 *   PATCH  /api/admin/promotions/:id             edit (僅 draft 可改；active/archived 唯讀)
 *   DELETE /api/admin/promotions/:id             刪除（無使用紀錄才可硬刪；否則請改用停用）
 *   POST   /api/admin/promotions/:id/activate    上架 / 啟用 → active (draft→active)
 *   POST   /api/admin/promotions/:id/archive     停用 → archived
 *   POST   /api/admin/promotions/:id/submit      （保留但 UI 已不使用）送審 → pending_review
 *   POST   /api/admin/promotions/:id/approve     （保留但 UI 已不使用）核准 → active
 *   POST   /api/admin/promotions/:id/reject      （保留但 UI 已不使用）拒絕（含 note）
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
  applicable_coach_multipliers, show_on_parent_home,
  coupon_code, start_date, end_date, max_uses, current_uses,
  platform_total_period_cap, parent_period_cap, current_period_uses, status, review_note,
  created_by, reviewed_by, reviewed_at, submitted_at, created_at, updated_at`;

function genCouponCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars
}

function optionalNonNegativeInteger(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
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
  // max_uses：留空 / 0 表示不限次數（create/update 皆以 `|| null` 收斂為 NULL）；其餘須為非負整數
  if (p.max_uses != null && p.max_uses !== '') {
    const mu = Number(p.max_uses);
    if (!Number.isInteger(mu) || mu < 0) errs.push('max_uses 必須為非負整數（留空或 0 表示不限次數）');
  }
  for (const [field, label] of [
    ['platform_total_period_cap', 'platform_total_period_cap'],
    ['parent_period_cap', 'parent_period_cap'],
  ]) {
    if (optionalNonNegativeInteger(p[field]) === undefined) errs.push(`${label} 必須為非負整數或留空`);
  }
  // min_threshold_value：留空 / 0 收斂為 NULL；其餘須為非負整數（欄位型別 INTEGER）
  if (p.min_threshold_value != null && p.min_threshold_value !== '') {
    const mt = Number(p.min_threshold_value);
    if (!Number.isInteger(mt) || mt < 0) errs.push('min_threshold_value 必須為非負整數');
  }
  // coupon_code 欄位為 VARCHAR(40)
  if (p.coupon_code != null && String(p.coupon_code).trim().length > 40) errs.push('coupon_code 長度不可超過 40 字');
  // applicable_course_types 為 INTEGER[]，每個元素須為整數；applicable_venue_ids 為 VARCHAR[]，每個元素須為字串
  const isIntElem = (x) => Number.isInteger(x) || (typeof x === 'string' && /^-?\d+$/.test(x.trim()));
  if (p.applicable_course_types && !Array.isArray(p.applicable_course_types)) errs.push('applicable_course_types 必須為陣列');
  else if (Array.isArray(p.applicable_course_types) && !p.applicable_course_types.every(isIntElem)) errs.push('applicable_course_types 每個元素必須為整數');
  if (p.applicable_venue_ids && !Array.isArray(p.applicable_venue_ids)) errs.push('applicable_venue_ids 必須為陣列');
  else if (Array.isArray(p.applicable_venue_ids) && !p.applicable_venue_ids.every((x) => typeof x === 'string')) errs.push('applicable_venue_ids 每個元素必須為字串');
  // applicable_coach_multipliers 為 NUMERIC[]，每個元素須為 > 0 的有限數（教練加成，如 1.30）
  if (p.applicable_coach_multipliers && !Array.isArray(p.applicable_coach_multipliers)) errs.push('applicable_coach_multipliers 必須為陣列');
  else if (Array.isArray(p.applicable_coach_multipliers) && !p.applicable_coach_multipliers.every((x) => Number.isFinite(Number(x)) && Number(x) > 0)) errs.push('applicable_coach_multipliers 每個元素必須為大於 0 的數值');
  // show_on_parent_home 若有值須為布林（缺省視為 true）
  if (p.show_on_parent_home != null && typeof p.show_on_parent_home !== 'boolean') errs.push('show_on_parent_home 必須為布林值');
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
          AND (platform_total_period_cap IS NULL OR current_period_uses < platform_total_period_cap)
        ORDER BY end_date ASC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin promotions active]', err);
    res.status(500).json({ error: 'list active failed' });
  }
});

// 表單「適用教練加成（％）」選項來源：目前 active 教練的相異加成值（存 pricing_multiplier）。
router.get('/coach-multipliers', requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT pricing_multiplier AS multiplier
         FROM coaches
        WHERE is_active = TRUE AND pricing_multiplier IS NOT NULL
        ORDER BY 1`
    );
    res.json(r.rows.map((row) => ({ multiplier: Number(row.multiplier) })));
  } catch (err) {
    console.error('[admin promotions coach-multipliers]', err);
    res.status(500).json({ error: 'list coach multipliers failed' });
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
         applicable_coach_multipliers, show_on_parent_home,
         coupon_code, start_date, end_date, max_uses,
         platform_total_period_cap, parent_period_cap, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'draft',$17)
       RETURNING ${PROMO_FIELDS}`,
      [
        p.name, p.description || '', p.type, p.discount_value,
        p.min_threshold_type || null, p.min_threshold_value || null,
        p.applicable_course_types && p.applicable_course_types.length ? p.applicable_course_types : null,
        p.applicable_venue_ids && p.applicable_venue_ids.length ? p.applicable_venue_ids : null,
        p.applicable_coach_multipliers && p.applicable_coach_multipliers.length ? p.applicable_coach_multipliers : null,
        p.show_on_parent_home !== false,
        coupon, p.start_date, p.end_date, p.max_uses || null,
        optionalNonNegativeInteger(p.platform_total_period_cap),
        optionalNonNegativeInteger(p.parent_period_cap),
        req.adminUser.sub,
      ]
    );
    await audit(null, r.rows[0].id, 'create', req.adminUser.sub, null);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '折價券代碼已存在' });
    if (err.code === '22P02') return res.status(400).json({ error: '欄位格式錯誤（數值或陣列型別不符）' });
    if (err.code === '22001') return res.status(400).json({ error: '欄位長度超過限制（折價券代碼上限 40 字）' });
    console.error('[admin promotion create]', err);
    res.status(500).json({ error: 'create failed' });
  }
});

router.patch('/:id', requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const cur = await pool.query(`SELECT * FROM promotions WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not found' });
    const old = cur.rows[0];
    // 改版：只有 draft 可編輯。active 已上架不可編輯（請刪除後重建）；archived 唯讀。
    const editable = ['draft', 'rejected'];
    if (!editable.includes(old.status)) {
      return res.status(400).json({ error: `狀態 ${old.status} 不可編輯，已啟用的優惠請刪除後重建` });
    }
    const p = { ...old, ...req.body };
    const errs = validatePayload(p);
    if (errs.length) return res.status(400).json({ error: errs.join('; ') });

    const r = await pool.query(
      `UPDATE promotions SET
         name=$2, description=$3, type=$4, discount_value=$5,
         min_threshold_type=$6, min_threshold_value=$7,
         applicable_course_types=$8, applicable_venue_ids=$9,
         applicable_coach_multipliers=$16, show_on_parent_home=$17,
         coupon_code=$10, start_date=$11, end_date=$12, max_uses=$13,
         platform_total_period_cap=$14, parent_period_cap=$15,
         updated_at=NOW()
       WHERE id=$1 RETURNING ${PROMO_FIELDS}`,
      [
        old.id, p.name, p.description || '', p.type, p.discount_value,
        p.min_threshold_type || null, p.min_threshold_value || null,
        p.applicable_course_types && p.applicable_course_types.length ? p.applicable_course_types : null,
        p.applicable_venue_ids && p.applicable_venue_ids.length ? p.applicable_venue_ids : null,
        p.coupon_code ? String(p.coupon_code).toUpperCase() : null,
        p.start_date, p.end_date, p.max_uses || null,
        optionalNonNegativeInteger(p.platform_total_period_cap),
        optionalNonNegativeInteger(p.parent_period_cap),
        p.applicable_coach_multipliers && p.applicable_coach_multipliers.length ? p.applicable_coach_multipliers : null,
        p.show_on_parent_home !== false,
      ]
    );
    await audit(null, old.id, 'edit', req.adminUser.sub, null);
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '折價券代碼已存在' });
    if (err.code === '22P02') return res.status(400).json({ error: '欄位格式錯誤（數值或陣列型別不符）' });
    if (err.code === '22001') return res.status(400).json({ error: '欄位長度超過限制（折價券代碼上限 40 字）' });
    console.error('[admin promotion patch]', err);
    res.status(500).json({ error: 'update failed' });
  }
});

// 刪除：無 promotion_usages 才可硬刪；有使用紀錄則回 409，請改用「停用」。
// （FK promotion_usages.promotion_id 為 ON DELETE RESTRICT，已使用者本就無法硬刪。）
router.delete('/:id', requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const cur = await pool.query(`SELECT id FROM promotions WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'not found' });
    const used = await pool.query(
      `SELECT COUNT(*)::int AS used FROM promotion_usages WHERE promotion_id = $1`,
      [req.params.id]
    );
    if (used.rows[0].used > 0) {
      return res.status(409).json({ error: '此優惠已有使用紀錄，無法刪除，請改用「停用」' });
    }
    // 先清掉稽核紀錄再刪本體（audit_logs 對 promotion 通常為 CASCADE，但保險起見手動處理）
    await pool.query(`DELETE FROM promotion_audit_logs WHERE promotion_id = $1`, [req.params.id]);
    await pool.query(`DELETE FROM promotions WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: '此優惠已有使用紀錄，無法刪除，請改用「停用」' });
    }
    console.error('[admin promotion delete]', err);
    res.status(500).json({ error: 'delete failed' });
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

// 改版：直接上架（draft→active）。set reviewed_at/reviewed_by（由 transition 內 toStatus==='active' 自動處理）。
router.post('/:id/activate', (req, res) => transition(req, res, ['draft', 'rejected'], 'active', 'activate', ['admin', 'manager']).catch((e) => { console.error(e); res.status(500).json({ error: 'activate failed' }); }));
router.post('/:id/submit',  (req, res) => transition(req, res, ['draft', 'rejected'], 'pending_review', 'submit',  ['admin', 'manager']).catch((e) => { console.error(e); res.status(500).json({ error: 'submit failed' }); }));
router.post('/:id/approve', (req, res) => transition(req, res, ['pending_review'],  'active',         'approve', ['admin', 'manager']).catch((e) => { console.error(e); res.status(500).json({ error: 'approve failed' }); }));
router.post('/:id/reject',  (req, res) => {
  const note = (req.body && req.body.note ? String(req.body.note).trim() : '');
  if (!note) return res.status(400).json({ error: '退回時必須填寫退回原因' });
  return transition(req, res, ['pending_review'], 'rejected', 'reject', ['admin', 'manager']).catch((e) => { console.error(e); res.status(500).json({ error: 'reject failed' }); });
});
router.post('/:id/archive', (req, res) => transition(req, res, ['draft', 'pending_review', 'active', 'rejected'], 'archived', 'archive', ['admin', 'manager']).catch((e) => { console.error(e); res.status(500).json({ error: 'archive failed' }); }));

module.exports = router;
