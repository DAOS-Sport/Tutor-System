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
    // 依需求「拿掉所有驗證」：除主鍵 course_type 仍需可解析為整數外，其餘欄位不檢查範圍/長度/大小關係，
    // 僅做型別解析與安全預設（避免 NaN/NULL 寫入 NOT NULL 欄位）。
    const ct = parseInt(course_type, 10);
    if (isNaN(ct)) return res.status(400).json({ error: 'course_type 必須為整數' });
    const lb = label == null ? '' : String(label).trim();
    // max_students NOT NULL：未填則沿用前台「最多＝編號」習慣預設為 ct；可為任意整數。
    const msParsed = parseInt(max_students, 10);
    const ms = isNaN(msParsed) ? ct : msParsed;
    // min_students 未填預設 1；可為任意整數。
    const mnParsed = parseInt(min_students, 10);
    const mn = isNaN(mnParsed) ? 1 : mnParsed;
    const bpParsed = Number(base_price);
    const bp = Number.isFinite(bpParsed) ? bpParsed : 0;
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

    // 合併出「下一版值」（未提供者沿用現值）。依需求「拿掉所有驗證」：不再檢查長度/範圍/大小關係，
    // 僅保留型別解析——數字無法解析時沿用現值，避免寫入 NaN/NULL 破壞 NOT NULL 欄位。
    let label = p.label !== undefined ? String(p.label).trim() : row.label;
    let max_students = row.max_students;
    if (p.max_students !== undefined) {
      const ms = parseInt(p.max_students, 10);
      if (!isNaN(ms)) max_students = ms;
    }
    let min_students = row.min_students;
    if (p.min_students !== undefined) {
      const mn = parseInt(p.min_students, 10);
      if (!isNaN(mn)) min_students = mn;
    }
    const is_active = p.is_active !== undefined ? Boolean(p.is_active) : row.is_active;
    let base_price = Number(row.base_price);
    if (p.base_price !== undefined) {
      const bp = Number(p.base_price);
      if (Number.isFinite(bp)) base_price = bp;
    }
    let data_group = row.data_group;
    if (p.data_group !== undefined) {
      data_group = p.data_group === null ? null : (String(p.data_group).trim() || null);
    }

    const next = { label, min_students, max_students, is_active, base_price, data_group };

    // 生效方式（不限制日期/時間）：scheduled_effective_date 接受 datetime-local（YYYY-MM-DDTHH:MM）
    // 或純日期（自動補 00:00），一律以台北固定時區 +08:00 解讀（台灣全年無日光節約）。
    // > 現在 → 排程；否則（過去／現在／無法解析）→ 立即生效。用 JS 解析（不在交易內查詢），
    // 避免無效字串讓資料庫交易進入中止狀態而拖垮後續 UPDATE。
    let scheduledAt = null;
    if (p.scheduled_effective_date) {
      const raw = String(p.scheduled_effective_date).trim();
      const local = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00` : raw;
      const iso = local.length === 16 ? `${local}:00+08:00` : `${local}+08:00`;
      const dt = new Date(iso);
      if (!isNaN(dt.getTime()) && dt.getTime() > Date.now()) scheduledAt = dt;
    }

    let result;
    if (scheduledAt) {
      // 排程：存 pending_changes，正式資料不動，待生效時間由 cron / 讀取時套用。
      const r = await client.query(
        `UPDATE course_type_configs
            SET pending_changes = $2::jsonb, scheduled_effective_date = $3::timestamptz, updated_at = NOW()
          WHERE course_type = $1 RETURNING *`,
        [ct, JSON.stringify(next), scheduledAt]
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
