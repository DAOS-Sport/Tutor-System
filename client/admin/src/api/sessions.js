import { callApi } from './client';
import { mockDb } from './mock';

export const sessionsApi = {
  today: (venueId) =>
    callApi('/sessions/today', { params: { venueId } }, () => mockDb.todaySessions(venueId)),
  // Task #55：日期範圍 + 多場館；venueIds 為陣列，會被序列化成 comma-separated
  range: ({ from, to, venueIds }) =>
    callApi(
      '/sessions',
      {
        params: {
          from, to,
          ...(venueIds && venueIds.length ? { venueIds: venueIds.join(',') } : {}),
        },
      },
      () => mockDb.rangeSessions({ from, to, venueIds })
    ),
  // 2026-09-01 需求：篩選列只列有上課紀錄的館別。demo 模式沒有後端，
  // 直接從 mock 的課堂資料推 —— 回空陣列會讓畫面誤以為「一個館都沒有」。
  venueOptions: () =>
    callApi('/sessions/venue-options', {}, () => {
      const seen = new Map();
      for (const s of mockDb.rangeSessions({ from: null, to: null, venueIds: [] })) {
        if (s.venue_id && !seen.has(s.venue_id)) seen.set(s.venue_id, { id: s.venue_id, name: s.venue_id });
      }
      return [...seen.values()];
    }),
  // FR01 匯出欄位：沿用 active 教練目前設定的相異 pricing_multiplier，
  // 僅作為「可用係數類別」；不代表歷史課堂的係數快照。
  coefficientCategories: (q = {}) => callApi('/sessions/coefficient-categories', { params: q }, () => {
    throw new Error('SESSION_EXPORT_COEFFICIENT_CATEGORIES_UNAVAILABLE');
  }),
  verifyCheckin: (q) =>
    callApi('/sessions/verify-checkin', { params: q }, () => mockDb.verifyCheckin(q)),
  // F-R01 櫃台補簽到：checkin_at = 操作者選擇的簽到時間（ISO 字串）
  backfillCheckin: (id, checkinAt) =>
    callApi(`/sessions/${id}/backfill-checkin`, { method: 'post', data: { checkin_at: checkinAt } },
      () => ({ id, checkin_status: 'checked_in', checkin_at: checkinAt, backfilled_at: new Date().toISOString() })),
  cancelled: () => callApi('/sessions/cancelled', {}, () => mockDb.cancelledSessions()),
  revive: (id, reason) =>
    callApi(`/sessions/${id}/revive`, { method: 'post', data: { reason } }, () => mockDb.reviveSession(id)),
};
