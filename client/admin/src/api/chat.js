import { callApi } from './client';
import { mockDb } from './mock';

// ── 聊天監察（F-M03 主管查閱） ─────────────────
export const adminChatApi = {
  listRooms: (params = {}) =>
    callApi('/chat/rooms', { params }, () => mockDb.adminChatRooms(params)),
  listMessages: (id, params = {}) =>
    callApi(`/chat/rooms/${id}/messages`, { params }, () => mockDb.adminChatMessages(id, params)),
};

// ── 關鍵字管理（F-A07） ─────────────────────────
export const adminKeywordsApi = {
  list: () => callApi('/chat/keywords', {}, () => mockDb.adminKeywords()),
  create: (data) =>
    callApi('/chat/keywords', { method: 'post', data }, () => mockDb.adminCreateKeyword(data)),
  update: (id, patch) =>
    callApi(`/chat/keywords/${id}`, { method: 'patch', data: patch }, () => mockDb.adminUpdateKeyword(id, patch)),
  remove: (id) =>
    callApi(`/chat/keywords/${id}`, { method: 'delete' }, () => mockDb.adminDeleteKeyword(id)),
};

// ── 警示清單 ────────────────────────────────────
export const adminAlertsApi = {
  list: (params = {}) =>
    callApi('/chat/alerts', { params }, () => mockDb.adminAlerts(params)),
  update: (id, patch) =>
    callApi(`/chat/alerts/${id}`, { method: 'patch', data: patch }, () => mockDb.adminUpdateAlert(id, patch)),
};
