import { callApi } from './client';
import { mockDb } from './mock';

export const checkinsApi = {
  // Task #60：今日（或指定日期）已簽到名單
  list: ({ venueId, date } = {}) =>
    callApi('/checkins', { params: { venueId, date } }, () => mockDb.checkins({ venueId, date })),
  // U13 撤銷自助簽到（櫃檯更正）：刪除該堂全部簽到、課堂取消、釋放當日名額、堂數歸還
  revokeSelfSession: (sessionId) =>
    callApi(`/checkins/self-sessions/${sessionId}`, { method: 'delete' },
      () => ({ ok: true, session_id: sessionId, removed_checkins: 1 })),
};
