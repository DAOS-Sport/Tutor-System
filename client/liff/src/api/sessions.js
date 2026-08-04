import { callApi } from './client';
import { mockDb } from './mock';

export const sessionsApi = {
  todayByCoach: (coachId) =>
    callApi(`/sessions/coach/${coachId}/today`, { method: 'get' }, () => mockDb.coachTodaySessions(coachId)),

  weekByCoach: (coachId, { from, to } = {}) =>
    callApi(`/sessions/coach/${coachId}/week`, { method: 'get', params: { from, to } }, () =>
      mockDb.coachWeekSessions(coachId, from, to)),

  historyByCoach: (coachId, { from, to, status, periodId } = {}) =>
    callApi(`/sessions/coach/${coachId}/history`, { method: 'get', params: { from, to, status, periodId } }, () =>
      mockDb.coachHistorySessions(coachId, { from, to, status, periodId })),

  // 教練端唯讀：自己學生的報名狀態（含卡在待付款的）。
  // 只回狀態與姓名，不含金額／付款證明——教練不需要也不該看到金流細節。
  enrollmentsByCoach: (coachId) =>
    callApi(`/sessions/coach/${coachId}/enrollments`, { method: 'get' },
      () => ({ counts: {}, items: [] })),

  // 教練端唯讀：目前進行中、且會套用到這位教練的優惠活動。
  promotionsByCoach: (coachId) =>
    callApi(`/sessions/coach/${coachId}/promotions`, { method: 'get' },
      () => ({ promotions: [] })),

  historyPeriodsByCoach: (coachId) =>
    callApi(`/sessions/coach/${coachId}/history/periods`, { method: 'get' }, () =>
      mockDb.coachHistoryPeriods(coachId)),

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
