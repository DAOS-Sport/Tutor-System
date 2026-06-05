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

  checkin: (sessionId, studentId) =>
    callApi(`/sessions/${sessionId}/checkins`, { method: 'post', data: { studentId } }, () => ({
      ok: true,
      checkin_id: `ck_${Date.now()}`,
      checked_in_at: new Date().toISOString(),
      source: 'coach',
      student: { id: studentId },
    })),
};
