import { callApi } from './client';

// ── 標籤庫 (F-A08) ─────────────────────────
export const adminTagsApi = {
  list: () => callApi('/learn/tags', {}, () => ({ categories: [], tags: [] })),
  createCategory: (data) =>
    callApi('/learn/tag-categories', { method: 'post', data }, () => ({ id: 'cat_mock', ...data })),
  removeCategory: (id) =>
    callApi(`/learn/tag-categories/${id}`, { method: 'delete' }, () => ({ ok: true })),
  createTag: (data) =>
    callApi('/learn/tags', { method: 'post', data }, () => ({ id: 'tag_mock', ...data })),
  updateTag: (id, patch) =>
    callApi(`/learn/tags/${id}`, { method: 'patch', data: patch }, () => ({ id, ...patch })),
  removeTag: (id) =>
    callApi(`/learn/tags/${id}`, { method: 'delete' }, () => ({ ok: true })),
};

// ── 考核 (F-M09) + 門檻 (F-A09) ─────────────
export const adminEvalApi = {
  listCoaches: (params = {}) =>
    callApi('/learn/coach-eval', { params }, () => []),
  coachReport: (coachId, params = {}) =>
    callApi(`/learn/coach-eval/${coachId}`, { params }, () => ({ summary: {}, monthly: [], comments: [] })),
  thresholds: () => callApi('/learn/thresholds', {}, () => []),
  upsertThreshold: (data) =>
    callApi('/learn/thresholds', { method: 'put', data }, () => data),
};

// ── 教練介紹送審 (F-C06) ─────────────────────
export const adminIntrosApi = {
  list: (status = 'pending_review') =>
    callApi('/learn/intros', { params: { status } }, () => []),
  approve: (coachId) =>
    callApi(`/learn/intros/${coachId}/approve`, { method: 'post' }, () => ({ id: coachId, intro_review_status: 'published' })),
  reject: (coachId, note) =>
    callApi(`/learn/intros/${coachId}/reject`, { method: 'post', data: { note } }, () => ({ id: coachId, intro_review_status: 'rejected' })),
};
