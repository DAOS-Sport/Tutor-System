/**
 * 家庭異動的 LINE 通知（規格 §7「每次異動通知家庭所有成員」、§14「送出時通知孩子的所屬家長」）。
 *
 * - 一律在 COMMIT 之後、best-effort：送不出去只記 log，不影響已落地的家庭資料。
 * - 事件名 family_changed，受 pushGate 管：要在後台「系統設定 → 推播」打開「家庭異動 → 通知家庭成員」才會真的送。
 * - refId 每則唯一（異動紀錄 id＋收件人），避免 line_push_log 的去重把後續通知吃掉。
 */
const { pool } = require('../models/db');

const EVENT = 'family_changed';

// 只推真的 LINE UID（U＋32 碼 hex）；demo／測試帳號一律跳過
function isRealLineUid(uid) {
  return /^U[0-9a-f]{32}$/i.test(String(uid || ''));
}

async function recipientsFor(notice, db) {
  if (notice.kind === 'family') {
    return (await db.query(
      `SELECT p.id, p.line_uid, p.primary_venue_id
         FROM family_members fm JOIN parents p ON p.id = fm.parent_id
        WHERE fm.family_id = $1 AND fm.status = 'active' AND COALESCE(p.is_active, TRUE) = TRUE`,
      [notice.familyId]
    )).rows;
  }
  return (await db.query(
    `SELECT id, line_uid, primary_venue_id FROM parents WHERE id = $1 AND COALESCE(is_active, TRUE) = TRUE`,
    [notice.parentId]
  )).rows;
}

async function sendNotices(notices, { db = pool, line = require('./line'), routing = require('./lineRouting') } = {}) {
  const sent = [];
  for (const notice of notices || []) {
    try {
      for (const r of await recipientsFor(notice, db)) {
        if (!isRealLineUid(r.line_uid)) continue;
        const ch = (await routing.resolveChannel({ kind: 'parent', venueId: r.primary_venue_id }))?.channel;
        if (!ch) continue;
        try {
          const res = await line.pushMessage(r.line_uid, [{ type: 'text', text: notice.text }], ch,
            { event: EVENT, refId: `${notice.refKey}:${r.id}`, recipientKind: 'parent' });
          sent.push({ parent_id: r.id, sent: !!res?.sent, reason: res?.reason || null });
        } catch (err) {
          console.warn('[familyNotify] push failed parent=%s: %s', r.id, err.message);
        }
      }
    } catch (err) {
      console.warn('[familyNotify] recipients failed:', err.message);
    }
  }
  return sent;
}

module.exports = { sendNotices, isRealLineUid, EVENT };
