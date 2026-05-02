import { callApi } from './client';
import { mockDb } from './mock';

export const sessionsApi = {
  today: (venueId) =>
    callApi('/sessions/today', { params: { venueId } }, () => mockDb.todaySessions(venueId)),
  verifyCheckin: (q) =>
    callApi('/sessions/verify-checkin', { params: q }, () => mockDb.verifyCheckin(q)),
  cancelled: () => callApi('/sessions/cancelled', {}, () => mockDb.cancelledSessions()),
  revive: (id) =>
    callApi(`/sessions/${id}/revive`, { method: 'post' }, () => mockDb.reviveSession(id)),
};
