/**
 * 定價區管理（F-A08）—— 後台「課程需求管理」上方那排分頁的後端。
 *
 *   GET    /api/admin/pricing-zones            → 分頁列（含各區的場館、未分配場館）
 *   POST   /api/admin/pricing-zones            → 新增一區（新區會在下次啟動自動補一套課別起點）
 *   PATCH  /api/admin/pricing-zones/:id        → 改名／一期堂數／期數上下限／停用
 *   PUT    /api/admin/pricing-zones/:id/venues → 設定「哪些場館吃這一區的費率」
 *   DELETE /api/admin/pricing-zones/:id        → 刪除（只允許沒有場館、且不是最後一區）
 *
 * ── 場館互斥是結構保證的，而且已被佔用的不給搶 ──
 * venues.pricing_zone_id 是單一外鍵，一個場館只可能屬於一個定價區。
 *
 * 在此之上再加一道：**已經屬於別區的場館，這裡直接擋，不給搬**。
 * 早期版本是「勾選＝搬過來」，一個誤觸就會把新北高中從三蘆抽到松山 ——
 * 那一刻該館的價目表整個換掉、家長端看到的金額跟著變，而畫面上不會有任何阻攔。
 * 要換區必須分兩步：先到原本那一區取消勾選、存檔，再到新的一區勾選。
 * 兩個刻意的動作，誤觸就做不到。
 *
 * 中間會有一小段「未分配」空窗（該館報名會失敗、家長端選不到），這是刻意的代價：
 * 讓搬移這件事是看得見的，而不是一個沒人察覺的副作用。
 *
 * ── 為什麼容許「沒有定價區的場館」，而且不當成警告 ──
 * 因為對大多數場館來說，「沒有定價區」是正常狀態而不是錯誤：26 個場館裡只有
 * 三個真的有家教課期（新北高中 146、三重商工 175、三民高中 151），其餘多半是
 * 勞務館，根本沒有這個品項。把「未分配 N 館」做成醒目提示，等於天天喊狼來了，
 * 真正該注意的那次反而會被當成背景雜訊。
 *
 * 所以警告的條件收窄成「**這個場館真的有在賣課**，卻掉出定價區」——
 * 那才是會壞事的情況（既有課期的報名會開始回 VENUE_ZONE_MISSING）。
 * 沒賣課的場館沒有定價區，不需要任何提示。
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const { listZones } = require('../../services/courseConfig');

const router = express.Router();
const READ_ROLES = requireAdminRole('admin', 'manager', 'staff');
const WRITE_ROLES = requireAdminRole('admin');

const MAX_SESSIONS_PER_PERIOD = 60;   // 一期 60 堂已經遠超實務，超過就是填錯
const MAX_PERIOD_COUNT = 24;

function parsePositiveInt(raw, { min = 1, max, fallback = null }) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) return undefined; // undefined = 無效
  return n;
}

// 只回「有課期、卻沒有定價區」的場館。沒賣課的場館不算問題，不要回。
async function unassignedVenuesWithCourses(db, onlyIds = null) {
  const r = await db.query(
    `SELECT v.id, v.name
       FROM venues v
      WHERE v.pricing_zone_id IS NULL
        AND ($1::text[] IS NULL OR v.id = ANY($1))
        AND EXISTS (SELECT 1 FROM course_periods cp WHERE cp.venue_id = v.id)
      ORDER BY v.id`, [onlyIds]);
  return r.rows;
}

// ── GET / 分頁列 ────────────────────────────────────────────
router.get('/', requireAdminAuth, READ_ROLES, async (req, res) => {
  try {
    const zones = await listZones(pool);
    const names = await pool.query('SELECT id, name, is_active FROM venues ORDER BY id');
    const venueName = new Map(names.rows.map((v) => [v.id, v.name]));
    res.json({
      zones: zones.map((z) => ({
        id: z.id,
        name: z.name,
        sessions_per_period: z.sessions_per_period,
        period_count_min: z.period_count_min,
        period_count_max: z.period_count_max,
        is_active: z.is_active,
        venues: (z.venue_ids || []).map((id) => ({ id, name: venueName.get(id) || id })),
      })),
      // 所有場館都列出來：勾選 UI 需要知道「這個場館現在在哪一區」才能顯示歸屬，
      // 也才做得到「勾了就從別區搬過來」。
      all_venues: names.rows,
      // 正常情況是空陣列。只有「有課期卻沒定價區」才列進來 —— 那是真的會壞事的狀況。
      unassigned_with_courses: await unassignedVenuesWithCourses(pool),
    });
  } catch (err) {
    console.error('[admin/pricing-zones GET]', err);
    res.status(500).json({ error: '載入定價區失敗' });
  }
});

// ── POST / 新增 ─────────────────────────────────────────────
router.post('/', requireAdminAuth, WRITE_ROLES, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 50);
    if (!name) return res.status(400).json({ error: '請填寫定價區名稱', code: 'NAME_REQUIRED' });
    const spp = parsePositiveInt(req.body?.sessions_per_period, { max: MAX_SESSIONS_PER_PERIOD, fallback: 6 });
    const pmin = parsePositiveInt(req.body?.period_count_min, { max: MAX_PERIOD_COUNT, fallback: 1 });
    const pmax = parsePositiveInt(req.body?.period_count_max, { max: MAX_PERIOD_COUNT, fallback: 6 });
    if (spp === undefined || pmin === undefined || pmax === undefined) {
      return res.status(400).json({ error: '一期堂數或期數上下限不是有效數字', code: 'INVALID_NUMBER' });
    }
    if (pmin > pmax) {
      return res.status(400).json({ error: '期數下限不可大於上限', code: 'PERIOD_RANGE_INVALID' });
    }
    const r = await pool.query(
      `INSERT INTO pricing_zones (name, sessions_per_period, period_count_min, period_count_max, sort_order)
       VALUES ($1,$2,$3,$4, COALESCE((SELECT MAX(sort_order) + 1 FROM pricing_zones), 1))
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, sessions_per_period, period_count_min, period_count_max, is_active`,
      [name, spp, pmin, pmax]);
    if (!r.rowCount) {
      return res.status(409).json({ error: '已有同名的定價區', code: 'NAME_TAKEN' });
    }
    // 新區目前沒有任何課別設定；bootstrap 會在下次啟動補一套起點，
    // 但不必等重啟 —— 這裡直接複製一份，讓分頁一開就有東西可以編。
    //
    // 複製過來的一律 is_active = FALSE。這一條很重要：價格是從別區抄來的佔位值，
    // 若跟著啟用，新開的區從建立那一刻就「可以賣」，而且賣的是別區的價 ——
    // 家長在松山用三蘆的價下單，畫面上完全正常。營運端必須先把價格改對、
    // 再逐項啟用，那個動作就是「這一區真的開賣了」的明確意思表示。
    await pool.query(
      `INSERT INTO course_type_configs
         (pricing_zone_id, course_type, label, min_students, max_students, sort_order,
          base_price, trial_enabled, trial_price, tier_prices, is_active)
       SELECT $1, c.course_type, c.label, c.min_students, c.max_students, c.sort_order,
              c.base_price, c.trial_enabled, c.trial_price, c.tier_prices, FALSE
         FROM course_type_configs c
        WHERE c.pricing_zone_id = (SELECT id FROM pricing_zones WHERE id <> $1 ORDER BY sort_order, id LIMIT 1)
       ON CONFLICT (pricing_zone_id, course_type) DO NOTHING`,
      [r.rows[0].id]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[admin/pricing-zones POST]', err);
    res.status(500).json({ error: '新增定價區失敗' });
  }
});

// ── PATCH /:id 改名與設定 ───────────────────────────────────
router.patch('/:id', requireAdminAuth, WRITE_ROLES, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const cur = await pool.query('SELECT * FROM pricing_zones WHERE id = $1', [id]);
    if (!cur.rowCount) return res.status(404).json({ error: '找不到此定價區' });

    const sets = [];
    const args = [id];
    const push = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };

    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim().slice(0, 50);
      if (!name) return res.status(400).json({ error: '定價區名稱不可為空', code: 'NAME_REQUIRED' });
      push('name', name);
    }
    for (const [col, max] of [['sessions_per_period', MAX_SESSIONS_PER_PERIOD],
      ['period_count_min', MAX_PERIOD_COUNT], ['period_count_max', MAX_PERIOD_COUNT]]) {
      if (req.body?.[col] === undefined) continue;
      const n = parsePositiveInt(req.body[col], { max });
      if (n === undefined || n === null) {
        return res.status(400).json({ error: `${col} 不是有效數字`, code: 'INVALID_NUMBER' });
      }
      push(col, n);
    }
    if (req.body?.is_active !== undefined) push('is_active', !!req.body.is_active);
    if (!sets.length) return res.status(400).json({ error: '沒有要更新的欄位' });

    const nextMin = req.body?.period_count_min !== undefined
      ? Number(req.body.period_count_min) : cur.rows[0].period_count_min;
    const nextMax = req.body?.period_count_max !== undefined
      ? Number(req.body.period_count_max) : cur.rows[0].period_count_max;
    if (nextMin > nextMax) {
      return res.status(400).json({ error: '期數下限不可大於上限', code: 'PERIOD_RANGE_INVALID' });
    }

    const r = await pool.query(
      `UPDATE pricing_zones SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1
       RETURNING id, name, sessions_per_period, period_count_min, period_count_max, is_active`, args);
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: '已有同名的定價區', code: 'NAME_TAKEN' });
    }
    console.error('[admin/pricing-zones PATCH]', err);
    res.status(500).json({ error: '更新定價區失敗' });
  }
});

// ── PUT /:id/venues 設定哪些場館吃這一區的費率 ──────────────
router.put('/:id/venues', requireAdminAuth, WRITE_ROLES, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const ids = Array.isArray(req.body?.venue_ids)
      ? [...new Set(req.body.venue_ids.map((v) => String(v).trim()).filter(Boolean))]
      : null;
    if (!ids) return res.status(400).json({ error: 'venue_ids 必須是陣列', code: 'VENUE_IDS_REQUIRED' });

    await client.query('BEGIN');
    const z = await client.query('SELECT id, name FROM pricing_zones WHERE id = $1 FOR UPDATE', [id]);
    if (!z.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '找不到此定價區' }); }

    if (ids.length) {
      // 一次做三件事：確認存在、取得目前歸屬、鎖住這幾列。
      // ORDER BY id 是為了讓併發的兩個請求以相同順序取鎖，不會互相死鎖。
      // 鎖住才擋得住競態：兩位管理員同時把同一個未分配場館指給不同區時，
      // 沒有鎖的話兩邊都讀到 NULL、兩邊都寫入，後寫的無聲蓋掉前一個。
      const cur = await client.query(
        'SELECT id, name, pricing_zone_id FROM venues WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
      if (cur.rowCount !== ids.length) {
        const found = new Set(cur.rows.map((x) => x.id));
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: '有場館代號不存在：' + ids.filter((x) => !found.has(x)).join('、'),
          code: 'VENUE_NOT_FOUND',
        });
      }

      // 已屬於別區的一律擋。前端會把這些選項變成唯讀，但唯讀只是提示 ——
      // 開著舊分頁、或直接打這支 API 一樣搬得走，所以真正的把關在這裡。
      const taken = cur.rows.filter((v) => v.pricing_zone_id && Number(v.pricing_zone_id) !== id);
      if (taken.length) {
        const owners = await client.query(
          'SELECT id, name FROM pricing_zones WHERE id = ANY($1)',
          [[...new Set(taken.map((v) => Number(v.pricing_zone_id)))]]);
        const nameOf = new Map(owners.rows.map((z) => [Number(z.id), z.name]));
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: taken.map((v) => `「${v.name}」目前屬於「${nameOf.get(Number(v.pricing_zone_id)) || '其他需求頁'}」`).join('；')
            + '。要改到這一頁，請先到原本那一頁取消勾選並儲存。',
          code: 'VENUE_OWNED_BY_OTHER_ZONE',
          venues: taken.map((v) => ({
            id: v.id, name: v.name,
            zone_id: Number(v.pricing_zone_id),
            zone_name: nameOf.get(Number(v.pricing_zone_id)) || null,
          })),
        });
      }

      await client.query('UPDATE venues SET pricing_zone_id = $1, updated_at = NOW() WHERE id = ANY($2)', [id, ids]);
    }
    // 取消勾選的場館變成未分配。不擋下來的理由見檔頭。
    const orphanedRows = await client.query(
      `UPDATE venues SET pricing_zone_id = NULL, updated_at = NOW()
        WHERE pricing_zone_id = $1 AND NOT (id = ANY($2::text[]))
        RETURNING id, name`, [id, ids]);
    // 只有「真的有在賣課」的場館掉出定價區才提醒 —— 那會讓既有課期的報名開始失敗。
    // 沒賣課的場館（多數是勞務館）沒有定價區完全正常，提醒它只會製造雜訊。
    const risky = orphanedRows.rowCount
      ? await unassignedVenuesWithCourses(client, orphanedRows.rows.map((v) => v.id))
      : [];
    await client.query('COMMIT');
    res.json({
      ok: true,
      zone_id: id,
      assigned: ids.length,
      unassigned: orphanedRows.rows,
      warning: risky.length
        ? `${risky.map((v) => v.name).join('、')} 已有課程在跑，但現在沒有定價區，該館的報名會失敗，請指派到其他需求頁`
        : null,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 已結束 */ }
    console.error('[admin/pricing-zones PUT venues]', err);
    res.status(500).json({ error: '設定場館失敗' });
  } finally {
    client.release();
  }
});

// ── DELETE /:id ─────────────────────────────────────────────
router.delete('/:id', requireAdminAuth, WRITE_ROLES, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const v = await pool.query('SELECT COUNT(*)::int AS n FROM venues WHERE pricing_zone_id = $1', [id]);
    if (v.rows[0].n > 0) {
      return res.status(409).json({
        error: `此定價區還有 ${v.rows[0].n} 個場館，請先把它們指派到其他定價區`,
        code: 'ZONE_HAS_VENUES',
      });
    }
    const total = await pool.query('SELECT COUNT(*)::int AS n FROM pricing_zones');
    if (total.rows[0].n <= 1) {
      return res.status(409).json({ error: '至少要保留一個定價區', code: 'LAST_ZONE' });
    }
    const r = await pool.query('DELETE FROM pricing_zones WHERE id = $1 RETURNING id', [id]);
    if (!r.rowCount) return res.status(404).json({ error: '找不到此定價區' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/pricing-zones DELETE]', err);
    res.status(500).json({ error: '刪除定價區失敗' });
  }
});

module.exports = router;
