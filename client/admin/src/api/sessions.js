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
  cancelled: () => callApi('/sessions/cancelled', {}, () => mockDb.cancelledSessions()),
  revive: (id) =>
    callApi(`/sessions/${id}/revive`, { method: 'post' }, () => mockDb.reviveSession(id)),
};
