/**
 * /api/admin/learn — Phase 5 後台
 *
 *  ── 標籤庫 (F-A08) ──
 *   GET    /tags                              { categories: [...], tags: [...] }
 *   POST   /tag-categories      { name }
 *   DELETE /tag-categories/:id
 *   POST   /tags                { category_id, label, text_template }
 *   PATCH  /tags/:id            { label?, text_template?, is_active? }
 *   DELETE /tags/:id
 *
 *  ── 考核 (F-M09) + 門檻 (F-A09) ──
 *   GET    /coach-eval                        全教練匯總（avg + 不達標）
 *   GET    /coach-eval/:coachId               單教練詳細（avg + monthly + comments）
 *   GET    /thresholds
 *   PUT    /thresholds                        { metric, min_value, window_months, is_active }
 *
 *  ── 教練介紹送審 (F-C06) ──
 *   GET    /intros?status=pending|all
 *   POST   /intros/:coachId/approve
 *   POST   /intros/:coachId/reject  { note }
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const evals = require('../../services/evaluations');

const router = express.Router();
router.use(requireAdminAuth);

// ── 標籤庫 ───────────────────────────────
router.get('/tags', async (_req, res) => {
  const cats = await pool.query(`SELECT * FROM tag_categories ORDER BY sort_order, name`);
  const tags = await pool.query(
    `SELECT * FROM tag_library ORDER BY category_id, sort_order, label`
  );
  res.json({ categories: cats.rows, tags: tags.rows });
});

router.post('/tag-categories', requireAdminRole('admin', 'manager'), async (req, res) => {
  const { name, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await pool.query(
      `INSERT INTO tag_categories (name, sort_order) VALUES ($1, $2) RETURNING *`,
      [String(name).slice(0, 40), Number(sort_order) || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '此分類已存在' });
    throw e;
  }
});

router.delete('/tag-categories/:id', requireAdminRole('admin'), async (req, res) => {
  await pool.query(`DELETE FROM tag_categories WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

router.post('/tags', requireAdminRole('admin', 'manager'), async (req, res) => {
  const { category_id, label, text_template, sort_order } = req.body || {};
  if (!category_id || !label || !text_template)
    return res.status(400).json({ error: 'category_id / label / text_template required' });
  try {
    const r = await pool.query(
      `INSERT INTO tag_library (category_id, label, text_template, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [category_id, String(label).slice(0, 40), String(text_template).slice(0, 1000), Number(sort_order) || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '同分類下已有相同標籤' });
    throw e;
  }
});

router.patch('/tags/:id', requireAdminRole('admin', 'manager'), async (req, res) => {
  const sets = [];
  const args = [];
  for (const k of ['label', 'text_template', 'is_active', 'sort_order']) {
    if (req.body[k] !== undefined) {
      args.push(req.body[k]);
      sets.push(`${k} = $${args.length}`);
    }
  }
  if (!sets.length) return res.json({ ok: true });
  args.push(req.params.id);
  const r = await pool.query(
    `UPDATE tag_library SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`,
    args
  );
  res.json(r.rows[0] || null);
});

router.delete('/tags/:id', requireAdminRole('admin', 'manager'), async (req, res) => {
  await pool.query(`DELETE FROM tag_library WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ── 考核報表 (F-M09) ────────────────────────
router.get('/coach-eval', requireAdminRole('admin', 'manager'), async (req, res) => {
  const list = await evals.listAllCoachReports({ from: req.query.from, to: req.query.to });
  res.json(list);
});

router.get('/coach-eval/:coachId', requireAdminRole('admin', 'manager'), async (req, res) => {
  const data = await evals.coachReport(req.params.coachId, { from: req.query.from, to: req.query.to });
  res.json(data);
});

// ── 門檻 (F-A09) ────────────────────────────
router.get('/thresholds', async (_req, res) => {
  res.json(await evals.thresholds());
});

router.put('/thresholds', requireAdminRole('admin'), async (req, res) => {
  const { metric, min_value, window_months, is_active } = req.body || {};
  if (!metric || min_value === undefined)
    return res.status(400).json({ error: 'metric / min_value required' });
  const row = await evals.upsertThreshold({
    metric: String(metric).slice(0, 40),
    min_value: Number(min_value),
    window_months: Number(window_months) || 3,
    is_active: is_active === undefined ? true : !!is_active,
  });
  res.json(row);
});

// ── 教練介紹送審 (F-C06) ────────────────────
router.get('/intros', async (req, res) => {
  const status = req.query.status || 'pending';
  const where = status === 'all'
    ? `WHERE is_active = TRUE`
    : `WHERE is_active = TRUE AND intro_review_status = $1`;
  const args = status === 'all' ? [] : [status];
  const r = await pool.query(
    `SELECT id, name, phone, intro_review_status, intro_review_note,
            intro_submitted_at, intro_reviewed_at, bio_rich_text,
            (SELECT json_agg(json_build_object('url', storage_url, 'type', media_type, 'alt', alt_text) ORDER BY sort_order)
               FROM coach_bio_media WHERE coach_id = coaches.id) AS media
       FROM coaches ${where} ORDER BY intro_submitted_at DESC NULLS LAST, name`,
    args
  );
  res.json(r.rows);
});

router.post('/intros/:coachId/approve', requireAdminRole('admin', 'manager'), async (req, res) => {
  const r = await pool.query(
    `UPDATE coaches SET intro_review_status = 'published',
                       intro_reviewed_at = NOW(),
                       intro_reviewed_by = $1,
                       intro_review_note = NULL
      WHERE id = $2 RETURNING id, name, intro_review_status`,
    [req.adminUser.sub, req.params.coachId]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'coach not found' });
  res.json(r.rows[0]);
});

router.post('/intros/:coachId/reject', requireAdminRole('admin', 'manager'), async (req, res) => {
  const note = String(req.body?.note || '').slice(0, 500);
  if (!note) return res.status(400).json({ error: 'note required' });
  const r = await pool.query(
    `UPDATE coaches SET intro_review_status = 'rejected',
                       intro_reviewed_at = NOW(),
                       intro_reviewed_by = $1,
                       intro_review_note = $2
      WHERE id = $3 RETURNING id, name, intro_review_status, intro_review_note`,
    [req.adminUser.sub, note, req.params.coachId]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'coach not found' });
  res.json(r.rows[0]);
});

module.exports = router;
