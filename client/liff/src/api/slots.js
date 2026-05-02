import { callApi } from './client';
import { mockDb } from './mock';

export const slotsApi = {
  // 教練排課總表（指定範圍，預設本週）
  listByCoach: (coachId, { from, to } = {}) =>
    callApi(`/slots/coach/${coachId}`, { method: 'get', params: { from, to } }, () =>
      mockDb.coachSlots(coachId, from, to)),

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
};
