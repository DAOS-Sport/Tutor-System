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
  const client = await pool.connect();
  try {
    const ct = parseInt(req.params.type, 10);
    if (isNaN(ct)) return res.status(400).json({ error: 'invalid type' });

    await client.query('BEGIN');
    const cfg = await client.query(`SELECT label FROM course_type_configs WHERE course_type=$1`, [ct]);
    if (!cfg.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '無效的 course_type' });
    }
    const label = cfg.rows[0].label;

    const p = req.body || {};
    // 長度驗證（與 course_type_configs.label 一致）
    if (p.title !== undefined) {
      const t = String(p.title);
      if (!t.trim()) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'title 不可為空' }); }
      if (t.length > 50) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'title 長度不可超過 50' }); }
    }
    if (p.body !== undefined && String(p.body).length > 1000) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'body 長度不可超過 1000' });
    }
    if (p.image_url !== undefined && String(p.image_url).length > 500) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'image_url 長度不可超過 500' });
    }

    // 原子化：INSERT 預設列；若已存在則套用 patch（COALESCE 保留未提供欄位）
    const newTitleArg = p.title !== undefined ? String(p.title) : null;
    const newBodyArg  = p.body  !== undefined ? String(p.body)  : null;
    const newImgArg   = p.image_url !== undefined ? String(p.image_url) : null;
    const r = await client.query(
      `INSERT INTO admin_course_intros (course_type, title, body, image_url, title_overridden)
       VALUES ($1, COALESCE($2, $5), COALESCE($3, ''), COALESCE($4, ''),
               CASE WHEN $2 IS NULL THEN FALSE ELSE ($2 <> $5) END)
       ON CONFLICT (course_type) DO UPDATE SET
         title  = COALESCE($2, admin_course_intros.title),
         body   = COALESCE($3, admin_course_intros.body),
         image_url = COALESCE($4, admin_course_intros.image_url),
         title_overridden = CASE
           WHEN $2 IS NULL THEN admin_course_intros.title_overridden
           ELSE ($2 <> $5)
         END,
         updated_at = NOW()
       RETURNING course_type, title, body, image_url, title_overridden`,
      [ct, newTitleArg, newBodyArg, newImgArg, label]
    );
    await client.query('COMMIT');
    const row = r.rows[0];
    res.json({
      course_type: row.course_type,
      title: row.title,
      body: row.body,
      image_url: row.image_url || '',
      title_overridden: row.title_overridden,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[admin/course-intros/:type PATCH]', err);
    res.status(500).json({ error: 'update intro failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
