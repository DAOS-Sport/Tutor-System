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
const { applyDueScheduledCourseTypeChanges } = require('../../services/courseTypeSchedule');

const router = express.Router();
const AM = requireAdminRole('admin', 'manager');

router.get('/', requireAdminAuth, AM, async (req, res) => {
  try {
    // 讀取前先套用「已到期」排程（保險：即使每日 cron 沒跑，下次讀取也會生效）。
    try { await applyDueScheduledCourseTypeChanges(pool); } catch (e) { console.warn('[course-types apply-due]', e.message); }
    const r = await pool.query(
      `SELECT course_type, label, min_students, max_students,
              base_price::float8 AS base_price, is_active, sort_order,
              created_at, updated_at, data_group, effective_date,
              scheduled_effective_date, pending_changes,
              CURRENT_DATE AS current_date
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
    const { course_type, label, max_students, min_students, base_price, data_group } = req.body || {};
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
    const bp = base_price == null || base_price === '' ? 0 : Number(base_price);
    if (!Number.isFinite(bp) || bp < 0) return res.status(400).json({ error: '每期價格必須為非負數' });
    const dg = data_group == null ? null : (String(data_group).trim() || null);

    await client.query('BEGIN');
    const maxOrder = await client.query(`SELECT COALESCE(MAX(sort_order),0) AS m FROM course_type_configs`);
    const nextOrder = maxOrder.rows[0].m + 1;

    const r = await client.query(
      `INSERT INTO course_type_configs (course_type, label, min_students, max_students, sort_order, base_price, data_group, effective_date, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,NOW())
       ON CONFLICT (course_type) DO NOTHING
       RETURNING *`,
      [ct, lb, mn, ms, nextOrder, bp, dg]
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
    const row = cur.rows[0];
    const p = req.body || {};

    // 取消排程：清掉 pending_changes / scheduled_effective_date（正式資料不動）。
    if (p.clear_schedule === true) {
      const r = await client.query(
        `UPDATE course_type_configs SET pending_changes=NULL, scheduled_effective_date=NULL, updated_at=NOW() WHERE course_type=$1 RETURNING *`,
        [ct]
      );
      await client.query('COMMIT');
      return res.json(r.rows[0]);
    }

    // 合併出「下一版值」（未提供者沿用現值），逐欄驗證。
    let label = row.label;
    if (p.label !== undefined) {
      const lb = String(p.label).trim();
      if (!lb) { await client.query('ROLLBACK'); return res.status(400).json({ error: '標題不可為空' }); }
      if (lb.length > 50) { await client.query('ROLLBACK'); return res.status(400).json({ error: '標題長度不可超過 50' }); }
      label = lb;
    }
    let max_students = row.max_students;
    if (p.max_students !== undefined) {
      const ms = parseInt(p.max_students, 10);
      if (isNaN(ms) || ms < 1 || ms > 10) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'max_students 必須為 1–10' }); }
      max_students = ms;
    }
    let min_students = row.min_students;
    if (p.min_students !== undefined) {
      const mn = parseInt(p.min_students, 10);
      if (isNaN(mn) || mn < 1 || mn > 10) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'min_students 必須為 1–10' }); }
      min_students = mn;
    }
    if (min_students > max_students) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '最少學生不可大於最多學生' });
    }
    const is_active = p.is_active !== undefined ? Boolean(p.is_active) : row.is_active;
    let base_price = Number(row.base_price);
    if (p.base_price !== undefined) {
      const bp = Number(p.base_price);
      if (!Number.isFinite(bp) || bp < 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: '每期價格不可小於 0' }); }
      base_price = bp;
    }
    let data_group = row.data_group;
    if (p.data_group !== undefined) {
      const dg = p.data_group === null ? null : String(p.data_group).trim();
      if (dg && dg.length > 100) { await client.query('ROLLBACK'); return res.status(400).json({ error: '資料管理群組長度不可超過 100' }); }
      data_group = dg || null;
    }

    const next = { label, min_students, max_students, is_active, base_price, data_group };

    // 判斷生效方式：給未來日期的 scheduled_effective_date → 排程；否則（含等於今天）立即。
    let scheduledDate = null;
    if (p.scheduled_effective_date) {
      const d = String(p.scheduled_effective_date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { await client.query('ROLLBACK'); return res.status(400).json({ error: '生效日格式需為 YYYY-MM-DD' }); }
      const cmp = await client.query(`SELECT $1::date < CURRENT_DATE AS past, $1::date = CURRENT_DATE AS today`, [d]);
      if (cmp.rows[0].past) { await client.query('ROLLBACK'); return res.status(400).json({ error: '排程生效日不可早於今天' }); }
      if (!cmp.rows[0].today) scheduledDate = d; // 等於今天 → 視為立即生效
    }

    let result;
    if (scheduledDate) {
      // 排程：存 pending_changes，正式資料不動，待生效日由 cron / 讀取時套用。
      const r = await client.query(
        `UPDATE course_type_configs
            SET pending_changes = $2::jsonb, scheduled_effective_date = $3::date, updated_at = NOW()
          WHERE course_type = $1 RETURNING *`,
        [ct, JSON.stringify(next), scheduledDate]
      );
      result = r.rows[0];
    } else {
      // 立即：套用到正式資料、清掉任何既有排程。
      const r = await client.query(
        `UPDATE course_type_configs
            SET label=$2, max_students=$3, is_active=$4, base_price=$5, min_students=$6, data_group=$7,
                effective_date=CURRENT_DATE, scheduled_effective_date=NULL, pending_changes=NULL, updated_at=NOW()
          WHERE course_type=$1 RETURNING *`,
        [ct, label, max_students, is_active, base_price, min_students, data_group]
      );
      result = r.rows[0];
      // label 變更 → 同步未被覆寫的介紹 title
      if (label !== row.label) {
        await client.query(
          `UPDATE admin_course_intros SET title=$2, updated_at=NOW() WHERE course_type=$1 AND title_overridden=FALSE`,
          [ct, label]
        );
      }
    }
    await client.query('COMMIT');
    res.json(result);
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
