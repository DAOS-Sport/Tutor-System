import { callApi } from './client';
import { mockDb } from './mock';

export const checkinsApi = {
  // Task #60：今日（或指定日期）已簽到名單
  list: ({ venueId, date } = {}) =>
    callApi('/checkins', { params: { venueId, date } }, () => mockDb.checkins({ venueId, date })),
  // 撤銷保留 attendance 稽核，只將同 session 全部列標記 REVERSED。
  revokeSelfSession: (sessionId, reason) =>
    callApi(`/checkins/self-sessions/${sessionId}`, { method: 'delete', data: { reason } },
      () => ({ ok: true, session_id: sessionId, reversed_attendances: 1 })),
};
