/**
 * 課程需求管理（師生比規格）
 *  GET    /api/admin/course-types         → 全部設定（含停用）
 *  POST   /api/admin/course-types         → 新增課程需求（同步建一筆預設課程介紹）
 *  PATCH  /api/admin/course-types/:type   → 更新 label / is_active（label 同步未被覆寫的介紹 title）
 *  DELETE /api/admin/course-types/:type   → 刪除（cascade 刪對應介紹；只允許無報名記錄）
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();
const AM = requireAdminRole('admin', 'manager');

router.get('/', requireAdminAuth, AM, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT course_type, label, min_students, max_students, base_price, is_active, sort_order
       FROM course_type_configs ORDER BY sort_order, course_type`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin/course-types GET]', err);
    res.status(500).json({ error: 'load failed' });
  }
});

router.post('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { course_type, label, max_students, min_students } = req.body || {};
    if (course_type == null || label == null || max_students == null) {
      return res.status(400).json({ error: '缺少必填欄位：course_type / label / max_students' });
    }
    const ct = parseInt(course_type, 10);
    const ms = parseInt(max_students, 10);
    // min_students 選填，預設 1
    const mn = min_students == null || min_students === '' ? 1 : parseInt(min_students, 10);
    const lb = String(label).trim();
    if (isNaN(ct) || ct < 1) return res.status(400).json({ error: 'course_type 必須為正整數' });
    if (!lb) return res.status(400).json({ error: 'label 不可為空' });
    if (lb.length > 50) return res.status(400).json({ error: 'label 長度不可超過 50' });
    if (isNaN(ms) || ms < 1 || ms > 10) return res.status(400).json({ error: 'max_students 必須為 1–10' });
    if (isNaN(mn) || mn < 1 || mn > 10) return res.status(400).json({ error: 'min_students 必須為 1–10' });
    if (mn > ms) return res.status(400).json({ error: 'min_students 不可大於 max_students' });

    await client.query('BEGIN');
    const maxOrder = await client.query(`SELECT COALESCE(MAX(sort_order),0) AS m FROM course_type_configs`);
    const nextOrder = maxOrder.rows[0].m + 1;

    const r = await client.query(
      `INSERT INTO course_type_configs (course_type, label, min_students, max_students, sort_order)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (course_type) DO NOTHING
       RETURNING *`,
      [ct, lb, mn, ms, nextOrder]
    );
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `課程需求 ${ct} 已存在` });
    }
    // Task #67：同步建一筆預設介紹，title 取 label，body / image 留空
    await client.query(
      `INSERT INTO admin_course_intros (course_type, title, body, image_url, title_overridden)
       VALUES ($1, $2, '', '', FALSE)
       ON CONFLICT (course_type) DO NOTHING`,
      [ct, lb]
    );
    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[admin/course-types POST]', err);
    res.status(500).json({ error: 'create failed' });
  } finally {
    client.release();
  }
});

router.patch('/:type', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const ct = parseInt(req.params.type, 10);
    if (isNaN(ct)) return res.status(400).json({ error: 'invalid type' });

    await client.query('BEGIN');
    const cur = await client.query(`SELECT * FROM course_type_configs WHERE course_type=$1`, [ct]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到此課程需求' });
    }

    const p = req.body || {};
    let label = cur.rows[0].label;
    if (p.label !== undefined) {
      const lb = String(p.label).trim();
      if (!lb) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'label 不可為空' }); }
      if (lb.length > 50) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'label 長度不可超過 50' }); }
      label = lb;
    }
    let max_students = cur.rows[0].max_students;
    if (p.max_students !== undefined) {
      const ms = parseInt(p.max_students, 10);
      if (isNaN(ms) || ms < 1 || ms > 10) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'max_students 必須為 1–10' }); }
      max_students = ms;
    }
    let min_students = cur.rows[0].min_students;
    if (p.min_students !== undefined) {
      const mn = parseInt(p.min_students, 10);
      if (isNaN(mn) || mn < 1 || mn > 10) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'min_students 必須為 1–10' }); }
      min_students = mn;
    }
    if (min_students > max_students) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'min_students 不可大於 max_students' });
    }
    const is_active = p.is_active !== undefined ? Boolean(p.is_active) : cur.rows[0].is_active;
    let base_price = cur.rows[0].base_price;
    if (p.base_price !== undefined) {
      const bp = Number(p.base_price);
      if (!Number.isFinite(bp) || bp < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'base_price 必須為非負數' });
      }
      base_price = bp;
    }

    const r = await client.query(
      `UPDATE course_type_configs SET label=$2, max_students=$3, is_active=$4, base_price=$5, min_students=$6 WHERE course_type=$1 RETURNING *`,
      [ct, label, max_students, is_active, base_price, min_students]
    );
    // Task #67：label 變更時，若對應介紹的 title 未被 admin 覆寫過，同步更新 title
    if (label !== cur.rows[0].label) {
      await client.query(
        `UPDATE admin_course_intros
            SET title = $2, updated_at = NOW()
          WHERE course_type = $1 AND title_overridden = FALSE`,
        [ct, label]
      );
    }
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[admin/course-types PATCH]', err);
    res.status(500).json({ error: 'update failed' });
  } finally {
    client.release();
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
    // FK ON DELETE CASCADE → admin_course_intros 對應記錄會一起刪除
    await pool.query(`DELETE FROM course_type_configs WHERE course_type=$1`, [ct]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/course-types DELETE]', err);
    res.status(500).json({ error: 'delete failed' });
  }
});

module.exports = router;
