/**
 * 課程需求管理（師生比規格）
 *  GET    /api/admin/course-types         → 全部設定（含停用）
 *  POST   /api/admin/course-types         → 新增課程需求
 *  PATCH  /api/admin/course-types/:type   → 更新 label / is_active
 *  DELETE /api/admin/course-types/:type   → 刪除（只允許無報名記錄的類型）
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();
const AM = requireAdminRole('admin', 'manager');

router.get('/', requireAdminAuth, AM, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT course_type, label, max_students, is_active, sort_order
       FROM course_type_configs ORDER BY sort_order, course_type`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin/course-types GET]', err);
    res.status(500).json({ error: 'load failed' });
  }
});

router.post('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const { course_type, label, max_students } = req.body || {};
    if (course_type == null || label == null || max_students == null) {
      return res.status(400).json({ error: '缺少必填欄位：course_type / label / max_students' });
    }
    const ct = parseInt(course_type, 10);
    const ms = parseInt(max_students, 10);
    const lb = String(label).trim();
    if (isNaN(ct) || ct < 1) return res.status(400).json({ error: 'course_type 必須為正整數' });
    if (!lb) return res.status(400).json({ error: 'label 不可為空' });
    if (lb.length > 50) return res.status(400).json({ error: 'label 長度不可超過 50' });
    if (isNaN(ms) || ms < 1 || ms > 10) return res.status(400).json({ error: 'max_students 必須為 1–10' });

    const maxOrder = await pool.query(`SELECT COALESCE(MAX(sort_order),0) AS m FROM course_type_configs`);
    const nextOrder = maxOrder.rows[0].m + 1;

    const r = await pool.query(
      `INSERT INTO course_type_configs (course_type, label, max_students, sort_order)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (course_type) DO NOTHING
       RETURNING *`,
      [ct, lb, ms, nextOrder]
    );
    if (!r.rowCount) return res.status(409).json({ error: `課程需求 ${ct} 已存在` });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[admin/course-types POST]', err);
    res.status(500).json({ error: 'create failed' });
  }
});

router.patch('/:type', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const ct = parseInt(req.params.type, 10);
    if (isNaN(ct)) return res.status(400).json({ error: 'invalid type' });
    const cur = await pool.query(`SELECT * FROM course_type_configs WHERE course_type=$1`, [ct]);
    if (!cur.rowCount) return res.status(404).json({ error: '找不到此課程需求' });

    const p = req.body || {};
    let label = cur.rows[0].label;
    if (p.label !== undefined) {
      const lb = String(p.label).trim();
      if (!lb) return res.status(400).json({ error: 'label 不可為空' });
      if (lb.length > 50) return res.status(400).json({ error: 'label 長度不可超過 50' });
      label = lb;
    }
    let max_students = cur.rows[0].max_students;
    if (p.max_students !== undefined) {
      const ms = parseInt(p.max_students, 10);
      if (isNaN(ms) || ms < 1 || ms > 10) return res.status(400).json({ error: 'max_students 必須為 1–10' });
      max_students = ms;
    }
    const is_active = p.is_active !== undefined ? Boolean(p.is_active) : cur.rows[0].is_active;

    const r = await pool.query(
      `UPDATE course_type_configs SET label=$2, max_students=$3, is_active=$4 WHERE course_type=$1 RETURNING *`,
      [ct, label, max_students, is_active]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[admin/course-types PATCH]', err);
    res.status(500).json({ error: 'update failed' });
  }
});

router.delete('/:type', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const ct = parseInt(req.params.type, 10);
    if (isNaN(ct)) return res.status(400).json({ error: 'invalid type' });
    const used = await pool.query(
      `SELECT COUNT(*) AS n FROM course_periods WHERE course_type=$1`, [ct]
    );
    if (parseInt(used.rows[0].n, 10) > 0) {
      return res.status(409).json({ error: '此課程需求已有報名記錄，無法刪除；請改為停用' });
    }
    await pool.query(`DELETE FROM course_type_configs WHERE course_type=$1`, [ct]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/course-types DELETE]', err);
    res.status(500).json({ error: 'delete failed' });
  }
});

module.exports = router;
