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
