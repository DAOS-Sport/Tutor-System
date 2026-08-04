/**
 * 課程需求管理（師生比規格）
 *  GET    /api/admin/course-types         → 全部設定（含停用）；讀取一併開放 staff，
 *                                            因為「手動建檔」的組別型態與自動帶入價格以此為唯一來源。
 *                                            寫入（POST/PATCH/DELETE）維持 admin-only。
 *  POST   /api/admin/course-types         → 新增課程需求（同步建一筆預設課程介紹）
 *  PATCH  /api/admin/course-types/:type   → 更新 label / is_active（label 同步未被覆寫的介紹 title）
 *  DELETE /api/admin/course-types/:type   → 刪除（cascade 刪對應介紹；只允許無報名記錄）
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const { applyDueScheduledCourseTypeChanges } = require('../../services/courseTypeSchedule');
const { normalizeTierPrices } = require('../../services/coursePricing');

const router = express.Router();
const AM = requireAdminRole('admin', 'manager');

const EDITABLE_FIELDS = ['label', 'min_students', 'max_students', 'is_active', 'base_price', 'data_group', 'trial_enabled', 'trial_price', 'tier_prices'];
const pad2 = (n) => String(n).padStart(2, '0');

// datetime-local（YYYY-MM-DDTHH:MM）或純日期 → 以台北固定時區 +08:00 解讀的 Date（無法解析回 null）。
function parseTaipei(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const local = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00` : s;
  const iso = local.length === 16 ? `${local}:00+08:00` : `${local}+08:00`;
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? null : dt;
}
// Date → 台北「YYYY/MM/DD HH:MM」字串（不依賴 Intl）。
function taipeiStr(d) {
  if (!d) return '';
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}/${pad2(t.getUTCMonth() + 1)}/${pad2(t.getUTCDate())} ${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}
// 只記實際變動的白名單欄位 → { field: { before, after } }；無變動回 null。
// 數值欄位（如 base_price：PG DECIMAL 回 "9000.00" 字串 vs 數字 9000）以數值比較，避免假變動。
// key 排序後序列化：jsonb 讀回來的 key 順序不保證與寫入時相同，直接比字串會誤判成「有變動」。
function stableJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}
function diffChanges(before, after, fields) {
  const out = {};
  for (const k of fields) {
    const b = before?.[k];
    const a = after?.[k];
    const isObj = (x) => x !== null && x !== undefined && typeof x === 'object';
    const bn = Number(b);
    const an = Number(a);
    const numeric = b !== null && b !== '' && a !== null && a !== '' && Number.isFinite(bn) && Number.isFinite(an);
    // 物件欄位（tier_prices）走 stableJson —— 走 String() 會兩邊都變 "[object Object]"，永遠判定沒變動。
    const same = (isObj(b) || isObj(a))
      ? stableJson(b ?? null) === stableJson(a ?? null)
      : (numeric ? bn === an : String(b ?? '') === String(a ?? ''));
    if (!same) out[k] = { before: b ?? null, after: a ?? null };
  }
  return Object.keys(out).length ? out : null;
}
async function writeCtAudit(db, courseType, action, byUser, changes, note) {
  await db.query(
    `INSERT INTO course_type_config_audit_logs (course_type, action, by_user, changes, note)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [courseType, action, byUser || 'unknown', changes ? JSON.stringify(changes) : null, note || null]
  );
}
const auditUser = (req) => req.adminUser?.name || req.adminUser?.username || 'unknown';

router.get('/', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  try {
    // 讀取前先套用「已到期」排程（保險：即使每日 cron 沒跑，下次讀取也會生效）。
    try { await applyDueScheduledCourseTypeChanges(pool); } catch (e) { console.warn('[course-types apply-due]', e.message); }
    const r = await pool.query(
      `SELECT course_type, label, min_students, max_students,
              base_price::float8 AS base_price, is_active, sort_order,
              trial_enabled, trial_price::float8 AS trial_price, tier_prices,
              created_at, updated_at, data_group, effective_date, effective_until,
              scheduled_effective_date, scheduled_effective_until, pending_changes,
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
    const { course_type, label, max_students, min_students, base_price, data_group, trial_enabled, trial_price, tier_prices } = req.body || {};
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
    // 試上設定（F-A07 試上開關 + 試上單價）：trial_price 可為 NULL（未設定 → 沿用推算 fallback）。
    const te = Boolean(trial_enabled);
    const tpParsed = Number(trial_price);
    const tp = trial_price == null || trial_price === '' || !Number.isFinite(tpParsed) ? null : tpParsed;
    // 各加成級距明價：未填的級距不落庫（＝沿用 base_price x 加成）。
    const tprc = normalizeTierPrices(tier_prices);

    await client.query('BEGIN');
    const maxOrder = await client.query(`SELECT COALESCE(MAX(sort_order),0) AS m FROM course_type_configs`);
    const nextOrder = maxOrder.rows[0].m + 1;

    const r = await client.query(
      `INSERT INTO course_type_configs (course_type, label, min_students, max_students, sort_order, base_price, data_group, trial_enabled, trial_price, tier_prices, effective_date, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,CURRENT_DATE,NOW())
       ON CONFLICT (course_type) DO NOTHING
       RETURNING *`,
      [ct, lb, mn, ms, nextOrder, bp, dg, te, tp, tprc === null ? null : JSON.stringify(tprc)]
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
    await writeCtAudit(client, ct, '新增', auditUser(req), {
      label: { before: null, after: lb },
      base_price: { before: null, after: bp },
      min_students: { before: null, after: mn },
      max_students: { before: null, after: ms },
      data_group: { before: null, after: dg },
      trial_enabled: { before: null, after: te },
      trial_price: { before: null, after: tp },
      tier_prices: { before: null, after: tprc },
    }, null);
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
    const by = auditUser(req);

    // 取消排程：清掉 pending_changes / scheduled_effective_date / scheduled_effective_until（正式資料不動）。
    if (p.clear_schedule === true) {
      const r = await client.query(
        `UPDATE course_type_configs SET pending_changes=NULL, scheduled_effective_date=NULL,
                scheduled_effective_until=NULL, updated_at=NOW() WHERE course_type=$1 RETURNING *`,
        [ct]
      );
      await writeCtAudit(client, ct, '取消排程', by, null, '取消既有排程');
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
    const trial_enabled = p.trial_enabled !== undefined ? Boolean(p.trial_enabled) : row.trial_enabled;
    // trial_price 允許清空（null / 空字串 → NULL，回退推算 fallback）；無法解析時沿用現值。
    let trial_price = row.trial_price === null ? null : Number(row.trial_price);
    if (p.trial_price !== undefined) {
      if (p.trial_price === null || p.trial_price === '') {
        trial_price = null;
      } else {
        const tp = Number(p.trial_price);
        if (Number.isFinite(tp)) trial_price = tp;
      }
    }

    // tier_prices 允許清空（null / 空物件 → NULL，所有級距回退 base_price x 加成）；未提供則沿用現值。
    let tier_prices = row.tier_prices || null;
    if (p.tier_prices !== undefined) tier_prices = normalizeTierPrices(p.tier_prices);

    const next = { label, min_students, max_students, is_active, base_price, data_group, trial_enabled, trial_price, tier_prices };

    // 生效方式：scheduled_effective_date 接受 datetime-local（YYYY-MM-DDTHH:MM）或純日期，
    // 以台北固定時區 +08:00 解讀。> 現在 → 排程；否則（過去／現在／無法解析）→ 立即生效。
    const startAt = parseTaipei(p.scheduled_effective_date);
    const scheduledAt = (startAt && startAt.getTime() > Date.now()) ? startAt : null;

    let result;
    if (scheduledAt) {
      // 排程生效「起訖日」必填：必須同時填生效迄日，且迄 > 起。
      const untilAt = parseTaipei(p.scheduled_effective_until);
      if (!p.scheduled_effective_until || !untilAt) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '排程生效需同時填寫「生效起日」與「生效迄日」', code: 'SCHEDULE_RANGE_REQUIRED' });
      }
      if (untilAt.getTime() <= scheduledAt.getTime()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '「生效迄日」需晚於「生效起日」', code: 'SCHEDULE_RANGE_INVALID' });
      }
      // 排程：存 pending_changes + 起訖，正式資料不動，待生效時間由 cron / 讀取時套用。
      const r = await client.query(
        `UPDATE course_type_configs
            SET pending_changes = $2::jsonb, scheduled_effective_date = $3::timestamptz,
                scheduled_effective_until = $4::timestamptz, updated_at = NOW()
          WHERE course_type = $1 RETURNING *`,
        [ct, JSON.stringify(next), scheduledAt, untilAt]
      );
      result = r.rows[0];
      await writeCtAudit(client, ct, '編輯(排程)', by, diffChanges(row, next, EDITABLE_FIELDS),
        `排程生效 ${taipeiStr(scheduledAt)} ～ ${taipeiStr(untilAt)}`);
    } else {
      // 立即：套用到正式資料、清掉任何既有排程（含迄日）。effective_until 不在立即流程變動。
      const r = await client.query(
        `UPDATE course_type_configs
            SET label=$2, max_students=$3, is_active=$4, base_price=$5, min_students=$6, data_group=$7,
                trial_enabled=$8, trial_price=$9, tier_prices=$10::jsonb,
                effective_date=CURRENT_DATE, scheduled_effective_date=NULL, scheduled_effective_until=NULL,
                pending_changes=NULL, updated_at=NOW()
          WHERE course_type=$1 RETURNING *`,
        [ct, label, max_students, is_active, base_price, min_students, data_group, trial_enabled, trial_price,
         tier_prices === null ? null : JSON.stringify(tier_prices)]
      );
      result = r.rows[0];
      // label 變更 → 同步未被覆寫的介紹 title
      if (label !== row.label) {
        await client.query(
          `UPDATE admin_course_intros SET title=$2, updated_at=NOW() WHERE course_type=$1 AND title_overridden=FALSE`,
          [ct, label]
        );
      }
      await writeCtAudit(client, ct, '編輯(立即)', by, diffChanges(row, next, EDITABLE_FIELDS), null);
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

// 編輯軌跡：某品項的變更歷史（時間 DESC）。
router.get('/:type/audit-logs', requireAdminAuth, AM, async (req, res) => {
  try {
    const ct = parseInt(req.params.type, 10);
    if (isNaN(ct)) return res.status(400).json({ error: 'invalid type' });
    const r = await pool.query(
      `SELECT id, at, action, by_user, changes, note
         FROM course_type_config_audit_logs
        WHERE course_type = $1
        ORDER BY at DESC, id DESC
        LIMIT 200`,
      [ct]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin/course-types audit-logs]', err);
    res.status(500).json({ error: 'load failed' });
  }
});

module.exports = router;
