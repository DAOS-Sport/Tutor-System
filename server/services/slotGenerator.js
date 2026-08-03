'use strict';
/**
 * 時段產生器（slotSupply / migration 038）
 *
 * 設計：家教預約從「教練加入可排課時間」反轉為「系統全開、教練自己關」。
 *
 *   場館營業時間（venue_business_hours）
 *        ↓ 切成 slot_minutes 的格子
 *        ↓ 扣掉「智慧記憶」：上一輪教練關掉的同星期幾＋同時刻
 *        ↓ 扣掉已存在的（DB UNIQUE(coach_id,start_at) 是最終防線）
 *   產生 coach_availability_slots，generated_by='auto'
 *
 * 智慧記憶（carry-forward）：教練兩週排一次班，下一輪直接沿用上一輪關掉的時段，
 * 教練只需微調而不是從頭關 200 格。這也是為什麼不需要另建「教練不可上課規則」表——
 * 教練「關過什麼」本身就是規則，行為即設定。
 *
 * 本檔的核心 computeSlots() 是純函式（不碰 DB、不碰時鐘），可單元測試。
 */

/** 台北時區固定 +08:00，本系統全站以此為準（見 utils/dateTime.js 慣例）。 */
const TAIPEI_OFFSET = '+08:00';

function pad2(n) { return String(n).padStart(2, '0'); }

/** 'HH:MM' 或 'HH:MM:SS' → 當日分鐘數 */
function timeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

function minutesToTime(mins) {
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}

/**
 * 'YYYY-MM-DD' → 該日 0..6（0=週日）
 * 刻意用 T00:00:00Z 而非 +08:00：ymd 是「日曆日期」不是時刻，
 * 若套 +08:00 會轉成前一天的 UTC，getUTCDay() 就少一天（實測 2026-08-03 週一被算成週日）。
 */
function weekdayOf(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

/** 'YYYY-MM-DD' + n 天 → 'YYYY-MM-DD'（純日期運算，不受時區/日光節約影響） */
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** carry-forward 的比對鍵：同星期幾 + 同時刻。跨輪次可比。 */
function carryKey(weekday, hhmm) {
  return `${weekday}|${hhmm}`;
}

/**
 * 產生指定日期區間的時段（純函式）。
 *
 * @param {object}   p
 * @param {Array}    p.businessHours  [{ weekday, open_time, close_time, slot_minutes }]
 * @param {string}   p.fromDate       'YYYY-MM-DD'（含）
 * @param {string}   p.toDate         'YYYY-MM-DD'（含）
 * @param {Set}      [p.blockedKeys]  智慧記憶：上一輪被關掉的 carryKey 集合
 * @param {Set}      [p.existingKeys] 已存在的 ISO start_at 集合（避免重複產生）
 * @returns {Array<{startAtISO,durationMinutes,status}>}  status='available'|'blocked'
 */
function computeSlots({
  businessHours, fromDate, toDate,
  blockedKeys = new Set(), existingKeys = new Set(), closedDates = new Set(),
}) {
  if (!Array.isArray(businessHours) || !businessHours.length) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new Error('fromDate / toDate 需為 YYYY-MM-DD');
  }
  if (toDate < fromDate) return [];

  // 先依 weekday 分組，避免逐日重掃整份營業時間
  const byWeekday = new Map();
  for (const bh of businessHours) {
    const wd = Number(bh.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) continue;
    if (!byWeekday.has(wd)) byWeekday.set(wd, []);
    byWeekday.get(wd).push(bh);
  }

  const out = [];
  for (let ymd = fromDate; ymd <= toDate; ymd = addDays(ymd, 1)) {
    if (closedDates.has(ymd)) continue;   // 特殊日期休館（migration 041）：整天不產生
    const wd = weekdayOf(ymd);
    for (const bh of byWeekday.get(wd) || []) {
      const open = timeToMinutes(bh.open_time);
      const close = timeToMinutes(bh.close_time);
      const step = Number(bh.slot_minutes) || 60;
      if (open == null || close == null || step <= 0 || close <= open) continue;

      // 只產生「完整放得下」的格子：最後一格結束時間不得超過打烊時間。
      for (let t = open; t + step <= close; t += step) {
        const hhmm = minutesToTime(t);
        const startAtISO = new Date(`${ymd}T${hhmm}:00${TAIPEI_OFFSET}`).toISOString();
        if (existingKeys.has(startAtISO)) continue;   // 已存在（教練手建或前次產生）→ 不重複
        out.push({
          startAtISO,
          durationMinutes: step,
          // 智慧記憶命中 → 直接建成 blocked，教練想開再自己開
          status: blockedKeys.has(carryKey(wd, hhmm)) ? 'blocked' : 'available',
        });
      }
    }
  }
  return out;
}

/** 由「上一輪已關閉的時段」推出 carry-forward 集合（純函式）。 */
function buildBlockedKeys(previousBlockedSlots) {
  const keys = new Set();
  for (const s of previousBlockedSlots || []) {
    const d = s.start_at instanceof Date ? s.start_at : new Date(s.start_at);
    if (Number.isNaN(d.getTime())) continue;
    // 轉台北時區後取星期幾與時刻
    const tpe = new Date(d.getTime() + 8 * 60 * 60 * 1000);
    keys.add(carryKey(tpe.getUTCDay(), `${pad2(tpe.getUTCHours())}:${pad2(tpe.getUTCMinutes())}`));
  }
  return keys;
}

// ─────────────────────────────────────────────────────────────────────
// DB 層：純函式之外的薄包裝。所有寫入都只碰 generated_by='auto'。
// ─────────────────────────────────────────────────────────────────────
const { pool } = require('../models/db');

/**
 * 合併同一教練跨多場館的營業時間（純函式）。
 *
 * 為什麼要合併：時段代表「教練這個時間有空」而非「某館這個時間開著」。
 * 一位教練掛 3 個場館，若逐館產生會在同一時刻產出 3 格，撞上
 * UNIQUE(coach_id, start_at) 只會留下一格 —— 其餘場館的家長就看到空清單。
 *
 * 合併規則：同一 weekday 取「最早開店 ~ 最晚打烊」，slot_minutes 取最小值。
 * 這假設各館當日是單一連續時段（正式庫目前四館皆是）；若未來出現中午休息的
 * 分段營業，這裡要改成真正的區間聯集。
 */
function unionHours(rows) {
  const byWeekday = new Map();
  for (const r of rows || []) {
    const wd = Number(r.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) continue;
    const open = timeToMinutes(r.open_time);
    const close = timeToMinutes(r.close_time);
    const step = Number(r.slot_minutes) || 60;
    if (open == null || close == null || close <= open) continue;
    const cur = byWeekday.get(wd);
    if (!cur) { byWeekday.set(wd, { weekday: wd, open, close, step }); continue; }
    cur.open = Math.min(cur.open, open);
    cur.close = Math.max(cur.close, close);
    cur.step = Math.min(cur.step, step);
  }
  return [...byWeekday.values()].map((x) => ({
    weekday: x.weekday, open_time: minutesToTime(x.open), close_time: minutesToTime(x.close), slot_minutes: x.step,
  }));
}

/** 產生對象：教練（含其所屬場館清單）。'active-periods' 只取實際帶課者。 */
async function loadTargets(scope, db) {
  const sql = scope === 'active-periods'
    ? `SELECT cp.coach_id, array_agg(DISTINCT cp.venue_id) AS venue_ids
         FROM course_periods cp JOIN coaches c ON c.id = cp.coach_id
        WHERE cp.status = 'active' AND c.is_active
        GROUP BY cp.coach_id`
    : `SELECT cv.coach_id, array_agg(DISTINCT cv.venue_id) AS venue_ids
         FROM coach_venues cv
         JOIN coaches c ON c.id = cv.coach_id AND c.is_active
         JOIN venues  v ON v.id = cv.venue_id AND v.is_active
        GROUP BY cv.coach_id`;
  const r = await db.query(sql);
  return r.rows;
}

/** 特殊日期休館（migration 041）：venue_id → Set<'YYYY-MM-DD'> */
async function loadClosedDates(db, fromDate, toDate) {
  const r = await db.query(
    `SELECT venue_id, to_char(closed_date,'YYYY-MM-DD') AS d
       FROM venue_closed_dates WHERE closed_date BETWEEN $1::date AND $2::date`,
    [fromDate, toDate]
  );
  const byVenue = new Map();
  for (const row of r.rows) {
    if (!byVenue.has(row.venue_id)) byVenue.set(row.venue_id, new Set());
    byVenue.get(row.venue_id).add(row.d);
  }
  return byVenue;
}

async function loadBusinessHours(db) {
  const r = await db.query(
    `SELECT venue_id, weekday, open_time, close_time, slot_minutes
       FROM venue_business_hours WHERE is_active ORDER BY venue_id, weekday, open_time`
  );
  const byVenue = new Map();
  for (const row of r.rows) {
    if (!byVenue.has(row.venue_id)) byVenue.set(row.venue_id, []);
    byVenue.get(row.venue_id).push(row);
  }
  return byVenue;
}

/**
 * 智慧記憶來源：該教練在該場館「最近 lookbackDays 天內被關閉」的時段。
 * 教練兩週排一次班，取 21 天足以涵蓋上一輪。
 */
async function loadPreviousBlocks(coachId, lookbackDays, db) {
  const r = await db.query(
    `SELECT start_at FROM coach_availability_slots
      WHERE coach_id = $1 AND status = 'blocked'
        AND start_at >= NOW() - ($2 || ' days')::interval`,
    [coachId, String(lookbackDays)]
  );
  return r.rows;
}

async function loadExistingStarts(coachId, fromISO, toISO, db) {
  const r = await db.query(
    `SELECT start_at FROM coach_availability_slots
      WHERE coach_id = $1 AND start_at >= $2 AND start_at < $3`,
    [coachId, fromISO, toISO]
  );
  return new Set(r.rows.map((x) => new Date(x.start_at).toISOString()));
}

/**
 * 為單一教練產生時段。venue_id 留 NULL —— 語意是「這位教練這個時間有空」，
 * 場館由家長預約當下依 course_period.venue_id 認領（見 routes/slots.js /book）。
 * UNIQUE(coach_id, start_at) 因此成為正確的約束，而非障礙。
 */
async function generateForCoach({ coachId, fromDate, toDate, hours, lookbackDays = 21, closedDates = new Set() }, db) {
  if (!hours || !hours.length) return { inserted: 0, blocked: 0 };
  const fromISO = new Date(`${fromDate}T00:00:00+08:00`).toISOString();
  const toISO = new Date(`${addDays(toDate, 1)}T00:00:00+08:00`).toISOString();

  const [prev, existing] = await Promise.all([
    loadPreviousBlocks(coachId, lookbackDays, db),
    loadExistingStarts(coachId, fromISO, toISO, db),
  ]);
  const slots = computeSlots({
    businessHours: hours, fromDate, toDate,
    blockedKeys: buildBlockedKeys(prev), existingKeys: existing, closedDates,
  });
  if (!slots.length) return { inserted: 0, blocked: 0 };

  const r = await db.query(
    `INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status, generated_by)
     SELECT $1, NULL, s.start_at::timestamptz, s.dur::int, s.st::slot_status, 'auto'
       FROM unnest($2::text[], $3::int[], $4::text[]) AS s(start_at, dur, st)
     ON CONFLICT (coach_id, start_at) DO NOTHING`,
    [coachId, slots.map((x) => x.startAtISO), slots.map((x) => x.durationMinutes), slots.map((x) => x.status)]
  );
  return { inserted: r.rowCount, blocked: slots.filter((x) => x.status === 'blocked').length };
}

/** 每日排程進入點。days 預設 21（教練兩週排一次，多給一週緩衝）。 */
async function generateAll({ days = 21, scope = 'active-periods', lookbackDays = 21 } = {}) {
  const db = pool;
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); // 台北今天
  const toDate = addDays(today, days);
  const [targets, hoursByVenue, closedByVenue] = await Promise.all([
    loadTargets(scope, db), loadBusinessHours(db), loadClosedDates(db, today, toDate),
  ]);

  let inserted = 0; let blocked = 0; let coaches = 0; let skipped = 0;
  for (const t of targets) {
    const venueIds = t.venue_ids || [];
    const rows = venueIds.flatMap((vid) => hoursByVenue.get(vid) || []);
    const hours = unionHours(rows);
    if (!hours.length) { skipped += 1; continue; }   // 所屬場館都沒設營業時間 → 略過，非錯誤
    // 跨館教練：只有「所有所屬場館都休館」的日子才整天不產生，
    // 否則某館公休會誤刪掉他在其他館的可上課時間。
    const closedDates = new Set();
    for (const d of closedByVenue.get(venueIds[0]) || []) {
      if (venueIds.every((vid) => (closedByVenue.get(vid) || new Set()).has(d))) closedDates.add(d);
    }
    const r = await generateForCoach({ coachId: t.coach_id, fromDate: today, toDate, hours, lookbackDays, closedDates }, db);
    inserted += r.inserted; blocked += r.blocked; coaches += 1;
  }
  return { coaches, skipped, inserted, blocked, fromDate: today, toDate, scope };
}

module.exports = {
  computeSlots, buildBlockedKeys, unionHours, timeToMinutes, minutesToTime, weekdayOf, addDays, carryKey,
  generateAll, generateForCoach, loadTargets, loadBusinessHours, loadClosedDates,
};