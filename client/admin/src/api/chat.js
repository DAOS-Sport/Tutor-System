import { callApi } from './client';
import { mockDb } from './mock';

// ── 聊天監察（F-M03 主管查閱） ─────────────────
export const adminChatApi = {
  listRooms: (params = {}) =>
    callApi('/admin/chat/rooms', { params }, () => mockDb.adminChatRooms(params)),
  listMessages: (id, params = {}) =>
    callApi(`/admin/chat/rooms/${id}/messages`, { params }, () => mockDb.adminChatMessages(id, params)),
};

// ── 關鍵字管理（F-A07） ─────────────────────────
export const adminKeywordsApi = {
  list: () => callApi('/admin/chat/keywords', {}, () => mockDb.adminKeywords()),
  create: (data) =>
    callApi('/admin/chat/keywords', { method: 'post', data }, () => mockDb.adminCreateKeyword(data)),
  update: (id, patch) =>
    callApi(`/admin/chat/keywords/${id}`, { method: 'patch', data: patch }, () => mockDb.adminUpdateKeyword(id, patch)),
  remove: (id) =>
    callApi(`/admin/chat/keywords/${id}`, { method: 'delete' }, () => mockDb.adminDeleteKeyword(id)),
};

// ── 警示清單 ────────────────────────────────────
export const adminAlertsApi = {
  list: (params = {}) =>
    callApi('/admin/chat/alerts', { params }, () => mockDb.adminAlerts(params)),
  update: (id, patch) =>
    callApi(`/admin/chat/alerts/${id}`, { method: 'patch', data: patch }, () => mockDb.adminUpdateAlert(id, patch)),
};
