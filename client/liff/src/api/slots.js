import { callApi } from './client';
import { mockDb } from './mock';

export const slotsApi = {
  // 教練排課總表（指定範圍，預設本週）
  listByCoach: (coachId, { from, to } = {}) =>
    callApi(`/slots/coach/${coachId}`, { method: 'get', params: { from, to } }, () =>
      mockDb.coachSlots(coachId, from, to)),

  // 教練端唯讀：自己所屬場館的營業時間 + 範圍內的特殊休館日。
  // 排課總表只看得到「有哪些格」，看不到「依據是什麼」；整週空白時教練
  // 無從判斷是自己關光了還是場館根本沒設營業時間。
  venueHoursForCoach: (coachId, { from, to } = {}) =>
    callApi(`/slots/coach/${coachId}/venue-hours`, { method: 'get', params: { from, to } },
      () => ({ venues: [] })),

  create: (payload) =>
    callApi('/slots', { method: 'post', data: payload }, () => mockDb.createSlot(payload)),

  batch: (payload) =>
    callApi('/slots/batch', { method: 'post', data: payload }, () => mockDb.batchCreateSlots(payload)),

  block: (id) =>
    callApi(`/slots/${id}/block`, { method: 'patch' }, () => mockDb.updateSlotStatus(id, 'blocked', 'available')),

  unblock: (id) =>
    callApi(`/slots/${id}/unblock`, { method: 'patch' }, () => mockDb.updateSlotStatus(id, 'available', 'blocked')),

  remove: (id) =>
    callApi(`/slots/${id}`, { method: 'delete' }, () => mockDb.deleteSlot(id)),

  previewConflict: (payload) =>
    callApi('/slots/preview-conflict', { method: 'post', data: payload }, () =>
      mockDb.previewConflict(payload)),

  availableForPeriod: (coursePeriodId, { from, to } = {}) =>
    callApi(`/slots/period/${coursePeriodId}`, { method: 'get', params: { from, to } }, () =>
      mockDb.availableSlotsForPeriod(coursePeriodId, from, to)),

  book: (slotId, coursePeriodId) =>
    callApi(`/slots/${slotId}/book`, { method: 'post', data: { course_period_id: coursePeriodId } }, () =>
      mockDb.bookSlot(slotId, coursePeriodId)),

  // 模組 1：首次預約提示確認（每個課期一次；伺服器端事實，不靠 localStorage）
  ackBookingNotice: (coursePeriodId) =>
    callApi(`/slots/period/${coursePeriodId}/ack-notice`, { method: 'post', data: {} },
      () => ({ ok: true, acked: true })),

  // 模組 1：家長自助取消預約（開課前 ≥24h）
  cancelBooking: (sessionId) =>
    callApi(`/slots/booking/${sessionId}`, { method: 'delete' }, () => ({ ok: true, session_id: sessionId })),
};
