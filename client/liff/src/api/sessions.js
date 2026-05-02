import { callApi } from './client';
import { mockDb } from './mock';

export const sessionsApi = {
  todayByCoach: (coachId) =>
    callApi(`/sessions/coach/${coachId}/today`, { method: 'get' }, () => mockDb.coachTodaySessions(coachId)),

  weekByCoach: (coachId, { from, to } = {}) =>
    callApi(`/sessions/coach/${coachId}/week`, { method: 'get', params: { from, to } }, () =>
      mockDb.coachWeekSessions(coachId, from, to)),

  detail: (id) =>
    callApi(`/sessions/${id}`, { method: 'get' }, () => mockDb.sessionDetail(id)),
};
