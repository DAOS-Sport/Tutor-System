/**
 * 課別設定的唯一讀取入口（F-A08 階段 2）。
 *
 * 分區之後，「一對三的價格」這句話本身不完整 —— 一定要問「哪一區的一對三」。
 * 所以這支的每個查詢都必須指定定價區（直接給 zoneId，或給 venueId 由這裡推導）。
 *
 * ── 為什麼查不到就丟例外，而不是回 null 或退回預設區 ──
 * 這件事最危險的失敗模式不是壞掉，是「錯得很安靜」：某個呼叫點忘了帶區，
 * 靜默拿到另一區的價，台北的家長付了三蘆的錢，前後端都沒有任何錯誤訊息，
 * 可能幾個月後對帳才發現，而那時候已經收了幾十筆。
 *
 * 定價寧可壞得大聲。所以：沒有區 → throw；區裡沒有這個課別 → throw。
 * 呼叫端自己決定要回 400 還是 500，但不能假裝有值。
 *
 * ── 為什麼收 db 參數 ──
 * 金流路徑（報名成立、團購核准）都在交易裡跑。傳入當下的 client 才能讀到
 * 同一個交易內剛寫入的狀態，也才不會多開一條連線把鎖序弄亂。
 */
const { pool } = require('../models/db');

class CourseConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CourseConfigError';
    this.code = code;
  }
}

// 每個欄位都帶 z. 別名：resolveZoneByVenue 會 join venues，而 venues 也有 name 欄，
// 只前綴第一個欄位會讓 name 變成模稜兩可的欄位參照（實測就是這樣炸的）。
const ZONE_FIELDS = `z.id, z.name, z.sessions_per_period, z.period_count_min, z.period_count_max, z.is_active`;

/** 場館 → 定價區。場館沒有定價區是資料設定錯誤，不是「用預設值」。 */
async function resolveZoneByVenue(db, venueId) {
  const id = String(venueId || '').trim();
  if (!id) throw new CourseConfigError('未指定場館，無法決定定價區', 'VENUE_REQUIRED');
  const r = await (db || pool).query(
    `SELECT ${ZONE_FIELDS}
       FROM venues v JOIN pricing_zones z ON z.id = v.pricing_zone_id
      WHERE v.id = $1`, [id]);
  if (!r.rowCount) {
    throw new CourseConfigError(`場館 ${id} 尚未指定定價區`, 'VENUE_ZONE_MISSING');
  }
  return r.rows[0];
}

async function getZone(db, zoneId) {
  const n = Number(zoneId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CourseConfigError('未指定定價區', 'ZONE_REQUIRED');
  }
  const r = await (db || pool).query(`SELECT ${ZONE_FIELDS} FROM pricing_zones z WHERE z.id = $1`, [n]);
  if (!r.rowCount) throw new CourseConfigError(`找不到定價區 ${n}`, 'ZONE_NOT_FOUND');
  return r.rows[0];
}

// venueId 與 zoneId 擇一；兩個都沒有就是呼叫端漏帶，直接擋下來。
async function resolveZone(db, { venueId, zoneId }) {
  if (zoneId !== undefined && zoneId !== null && zoneId !== '') return getZone(db, zoneId);
  if (venueId !== undefined && venueId !== null && venueId !== '') return resolveZoneByVenue(db, venueId);
  throw new CourseConfigError('讀取課別設定必須指定場館或定價區', 'ZONE_REQUIRED');
}

/**
 * 取單一課別在某區的設定。
 * 回傳值多帶 zone 與 sessions_per_period，讓呼叫端不必為了拿「一期幾堂」再查一次
 * —— 那正是最容易漏掉、又會讓拆期算錯的一個值。
 */
async function getCourseConfig(db, { venueId, zoneId, courseType }) {
  const ct = Number(courseType);
  if (!Number.isInteger(ct)) {
    throw new CourseConfigError('未指定課別', 'COURSE_TYPE_REQUIRED');
  }
  const zone = await resolveZone(db, { venueId, zoneId });
  const r = await (db || pool).query(
    `SELECT * FROM course_type_configs WHERE pricing_zone_id = $1 AND course_type = $2`,
    [zone.id, ct]);
  if (!r.rowCount) {
    // 「這一區沒有開這個課別」是合法的營運狀態（例如松山不開一對六），
    // 但呼叫端必須知道，不能拿到別區的設定去算錢。
    throw new CourseConfigError(
      `定價區「${zone.name}」沒有設定課別 ${ct}`, 'COURSE_TYPE_NOT_IN_ZONE');
  }
  return { ...r.rows[0], zone, sessions_per_period: zone.sessions_per_period };
}

/** 取某區全部課別設定（後台分頁、報名頁列表用）。 */
async function listCourseConfigs(db, { venueId, zoneId, activeOnly = false } = {}) {
  const zone = await resolveZone(db, { venueId, zoneId });
  const r = await (db || pool).query(
    `SELECT * FROM course_type_configs
      WHERE pricing_zone_id = $1 ${activeOnly ? 'AND is_active' : ''}
      ORDER BY sort_order, course_type`, [zone.id]);
  return { zone, configs: r.rows };
}

/** 定價區清單（後台分頁列）。 */
async function listZones(db, { activeOnly = false } = {}) {
  const r = await (db || pool).query(
    `SELECT ${ZONE_FIELDS},
            COALESCE((SELECT array_agg(v.id ORDER BY v.id) FROM venues v WHERE v.pricing_zone_id = z.id), '{}') AS venue_ids
       FROM pricing_zones z
      ${activeOnly ? 'WHERE z.is_active' : ''}
      ORDER BY z.sort_order, z.id`);
  return r.rows;
}

module.exports = {
  CourseConfigError,
  resolveZoneByVenue,
  getZone,
  resolveZone,
  getCourseConfig,
  listCourseConfigs,
  listZones,
};
