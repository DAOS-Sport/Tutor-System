/**
 * 課程介紹維護 (F-A04)
 *  GET    /api/admin/course-intros        → array：[{ course_type, label, is_active, sort_order, title, body, image_url, title_overridden }, ...]
 *  PATCH  /api/admin/course-intros/:type  → 單筆更新；title 與 label 不同 → 自動把 title_overridden=true
 *
 * Task #67：以 course_type_configs 為單一真實來源，JOIN 其 label / is_active / sort_order；
 * 介紹的新增/刪除已由「課程需求」端與 FK ON DELETE CASCADE 處理，故本路由不再提供 POST/DELETE。
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();
const AM = requireAdminRole('admin', 'manager');

router.get('/', requireAdminAuth, AM, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.course_type, c.label, c.is_active, c.sort_order,
              COALESCE(i.title, c.label)            AS title,
              COALESCE(i.body, '')                  AS body,
              COALESCE(i.image_url, '')             AS image_url,
              COALESCE(i.title_overridden, FALSE)   AS title_overridden
         FROM course_type_configs c
    LEFT JOIN admin_course_intros i ON i.course_type = c.course_type
        ORDER BY c.sort_order, c.course_type`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin/course-intros]', err);
    res.status(500).json({ error: 'load course intros failed' });
  }
});

router.patch('/:type', requireAdminAuth, AM, async (req, res) => {
  try {
    const ct = parseInt(req.params.type, 10);
    if (isNaN(ct)) return res.status(400).json({ error: 'invalid type' });
    const cfg = await pool.query(`SELECT label FROM course_type_configs WHERE course_type=$1`, [ct]);
    if (!cfg.rowCount) return res.status(400).json({ error: '無效的 course_type' });
    const label = cfg.rows[0].label;

    const p = req.body || {};
    // 確保 intro 列存在（理論上 POST course-type 時就會建；保險）
    await pool.query(
      `INSERT INTO admin_course_intros (course_type, title, body, image_url, title_overridden)
       VALUES ($1, $2, '', '', FALSE)
       ON CONFLICT (course_type) DO NOTHING`,
      [ct, label]
    );
    const cur = await pool.query(`SELECT * FROM admin_course_intros WHERE course_type = $1`, [ct]);
    const existing = cur.rows[0];

    const newTitle = p.title !== undefined ? String(p.title) : existing.title;
    const newBody  = p.body  !== undefined ? String(p.body)  : existing.body;
    const newImage = p.image_url !== undefined ? String(p.image_url) : existing.image_url;
    // Task #67：title 一旦被 admin 改成跟 label 不同，就標記為 overridden（label 同步不再覆蓋）
    let titleOverridden = existing.title_overridden;
    if (p.title !== undefined && newTitle !== label) titleOverridden = true;
    if (p.title !== undefined && newTitle === label) titleOverridden = false;

    const r = await pool.query(
      `UPDATE admin_course_intros SET
         title = $2, body = $3, image_url = $4, title_overridden = $5, updated_at = NOW()
       WHERE course_type = $1
       RETURNING course_type, title, body, image_url, title_overridden`,
      [ct, newTitle, newBody, newImage, titleOverridden]
    );
    const row = r.rows[0];
    res.json({
      course_type: row.course_type,
      title: row.title,
      body: row.body,
      image_url: row.image_url || '',
      title_overridden: row.title_overridden,
    });
  } catch (err) {
    console.error('[admin/course-intros/:type PATCH]', err);
    res.status(500).json({ error: 'update intro failed' });
  }
});

module.exports = router;
