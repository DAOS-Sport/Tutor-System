'use strict';
/**
 * 自動時段供給的功能旗標（模組 1）
 *
 * 規格要求：不得只用 cron 開關當唯一保護。旗標必須同時控制三個入口，
 * 否則關掉 cron 之後，既有的 auto 時段仍然對家長可見、仍然約得到。
 *
 *   ① cron 產生          server/cron/index.js
 *   ② 家長端查詢可見性    routes/slots.js GET /period/:id
 *   ③ 預約 auto slot     routes/slots.js POST /:id/book
 *
 * 三個入口共用這一支，避免各自寫 process.env 判斷而漂移。
 * 預設關閉：教練關班 UI、家長首次提示、取消流程完成前，不得讓家長看到自動時段。
 */

/** 自動時段功能總開關。未設或非 '1' 一律視為關閉（fail-closed）。 */
function isSlotSupplyEnabled() {
  return process.env.SLOT_GEN_ENABLED === '1';
}

/**
 * canary 範圍：只讓指定教練或場館看得到自動時段，其餘維持現況。
 * 空值＝不限制（全體適用）。格式為逗號分隔，例如：
 *   SLOT_GEN_CANARY_COACH_IDS=uuid1,uuid2
 *   SLOT_GEN_CANARY_VENUE_IDS=B,K
 */
function parseList(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function canaryCoachIds() { return parseList(process.env.SLOT_GEN_CANARY_COACH_IDS); }
function canaryVenueIds() { return parseList(process.env.SLOT_GEN_CANARY_VENUE_IDS); }

/**
 * 這個 (教練, 場館) 是否在自動時段的適用範圍內。
 * 總開關關閉 → 一律 false。canary 清單為空 → 全體適用。
 */
function isInSlotSupplyScope({ coachId, venueId } = {}) {
  if (!isSlotSupplyEnabled()) return false;
  const coaches = canaryCoachIds();
  const venues = canaryVenueIds();
  if (coaches.length && !coaches.includes(String(coachId || ''))) return false;
  if (venues.length && !venues.includes(String(venueId || ''))) return false;
  return true;
}

module.exports = {
  isSlotSupplyEnabled, isInSlotSupplyScope, canaryCoachIds, canaryVenueIds, parseList,
};