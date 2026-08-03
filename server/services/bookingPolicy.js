'use strict';
/**
 * 預約政策（模組 1：取消與逾時復原）
 *
 * 使用者決策 2026-08-03：
 *   · 開課前 ≥ 24 小時：家長可自行取消 → cancelled_normal（釋回槽位 + 歸還堂數）
 *   · 開課前 < 24 小時：不可取消。家長「不簽到」即可，等時間過去
 *   · 時間過了仍未簽到：自動復原，容量回到可再預約
 *   · 不做課程鎖定、不標記 no_show（使用者明確指示）
 *
 * 已知副作用（使用者已接受）：逾時未簽到等於免費取消，24 小時規則因此
 * 對「決定不出現」的家長沒有約束力，而教練仍會到場。這是刻意選擇的寬鬆政策。
 *
 * 本檔全部是純函式：不碰 DB、不讀時鐘（now 一律由呼叫端傳入），可單元測試。
 */

const CANCEL_DEADLINE_HOURS = Number(process.env.BOOKING_CANCEL_DEADLINE_HOURS) || 24;

/** 逾時未簽到的判定緩衝：課程結束後再等這麼久才視為未出席，避免剛下課就被判定。 */
const NO_SHOW_GRACE_MINUTES = Number(process.env.BOOKING_NO_SHOW_GRACE_MINUTES) || 120;

/**
 * 家長是否可自行取消（純函式）。
 * @param {Date|string} scheduledAt 上課時間
 * @param {Date}        now         現在（由呼叫端傳入，便於測試）
 * @returns {{ allowed: boolean, reason: string|null, hoursUntil: number }}
 */
function canSelfCancel(scheduledAt, now = new Date()) {
  const start = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(start.getTime())) {
    return { allowed: false, reason: 'INVALID_SCHEDULE', hoursUntil: NaN };
  }
  const hoursUntil = (start.getTime() - now.getTime()) / 3600000;
  if (hoursUntil < 0) return { allowed: false, reason: 'ALREADY_STARTED', hoursUntil };
  if (hoursUntil < CANCEL_DEADLINE_HOURS) {
    return { allowed: false, reason: 'TOO_LATE', hoursUntil };
  }
  return { allowed: true, reason: null, hoursUntil };
}

/**
 * 這堂課是否已可判定為「逾時未簽到」（純函式）。
 * 條件：課程結束 + 緩衝時間已過，且沒有任何簽到紀錄。
 * @param {{ scheduledAt: Date|string, durationMinutes: number, hasCheckin: boolean }} session
 */
function isNoShowRestorable({ scheduledAt, durationMinutes = 60, hasCheckin }, now = new Date()) {
  if (hasCheckin) return false;                       // 有人簽到 → 課上了，不復原
  const start = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(start.getTime())) return false;
  const endMs = start.getTime() + (Number(durationMinutes) || 60) * 60000;
  return now.getTime() >= endMs + NO_SHOW_GRACE_MINUTES * 60000;
}

/** 給家長看的文案：說明為什麼不能取消、以及該怎麼做。 */
function cancelRejectMessage(reason, hoursUntil) {
  if (reason === 'ALREADY_STARTED') return '此堂課已開始，無法取消';
  if (reason === 'TOO_LATE') {
    const h = Math.max(0, Math.floor(hoursUntil));
    return `距離上課不到 ${CANCEL_DEADLINE_HOURS} 小時（剩約 ${h} 小時），無法自行取消。`
      + '若無法出席，該堂課在時間過後會自動回復為可預約。';
  }
  return '此堂課目前無法取消，請洽櫃台';
}

module.exports = {
  CANCEL_DEADLINE_HOURS, NO_SHOW_GRACE_MINUTES,
  canSelfCancel, isNoShowRestorable, cancelRejectMessage,
};