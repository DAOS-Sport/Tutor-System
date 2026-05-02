/**
 * 課程介紹維護 (F-A04)
 *  GET    /api/admin/course-intros        → { 1: {...}, 2: {...}, 3: {...} }
 *  PATCH  /api/admin/course-intros/:type  → 單筆更新
 *
 * mock.js shape：每筆 { title, body, image_url }
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();

router.get('/', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT course_type, title, body, image_url FROM admin_course_intros ORDER BY course_type`);
    const out = {};
    for (const row of r.rows) {
      out[row.course_type] = {
        title: row.title,
        body: row.body,
        image_url: row.image_url || '',
      };
    }
    res.json(out);
  } catch (err) {
    console.error('[admin/course-intros]', err);
    res.status(500).json({ error: 'load course intros failed' });
  }
});

router.patch('/:type', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const ct = parseInt(req.params.type, 10);
    if (![1, 2, 3].includes(ct)) return res.status(400).json({ error: 'course_type 僅支援 1/2/3' });
    const cur = await pool.query(`SELECT * FROM admin_course_intros WHERE course_type = $1`, [ct]);
    if (!cur.rowCount) return res.status(404).json({ error: 'intro not found' });

    const p = req.body || {};
    const r = await pool.query(
      `UPDATE admin_course_intros SET
         title = $2,
         body = $3,
         image_url = $4,
         updated_at = NOW()
       WHERE course_type = $1 RETURNING title, body, image_url`,
      [
        ct,
        p.title !== undefined ? p.title : cur.rows[0].title,
        p.body !== undefined ? p.body : cur.rows[0].body,
        p.image_url !== undefined ? p.image_url : cur.rows[0].image_url,
      ]
    );
    res.json({
      title: r.rows[0].title,
      body: r.rows[0].body,
      image_url: r.rows[0].image_url || '',
    });
  } catch (err) {
    console.error('[admin/course-intros/:type PATCH]', err);
    res.status(500).json({ error: 'update intro failed' });
  }
});

module.exports = router;
