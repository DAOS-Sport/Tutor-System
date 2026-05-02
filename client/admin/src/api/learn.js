import { callApi } from './client';

// ── 標籤庫 (F-A08) ─────────────────────────
export const adminTagsApi = {
  list: () => callApi('/admin/learn/tags', {}, () => ({ categories: [], tags: [] })),
  createCategory: (data) =>
    callApi('/admin/learn/tag-categories', { method: 'post', data }, () => ({ id: 'cat_mock', ...data })),
  removeCategory: (id) =>
    callApi(`/admin/learn/tag-categories/${id}`, { method: 'delete' }, () => ({ ok: true })),
  createTag: (data) =>
    callApi('/admin/learn/tags', { method: 'post', data }, () => ({ id: 'tag_mock', ...data })),
  updateTag: (id, patch) =>
    callApi(`/admin/learn/tags/${id}`, { method: 'patch', data: patch }, () => ({ id, ...patch })),
  removeTag: (id) =>
    callApi(`/admin/learn/tags/${id}`, { method: 'delete' }, () => ({ ok: true })),
};

// ── 考核 (F-M09) + 門檻 (F-A09) ─────────────
export const adminEvalApi = {
  listCoaches: (params = {}) =>
    callApi('/admin/learn/coach-eval', { params }, () => []),
  coachReport: (coachId, params = {}) =>
    callApi(`/admin/learn/coach-eval/${coachId}`, { params }, () => ({ summary: {}, monthly: [], comments: [] })),
  thresholds: () => callApi('/admin/learn/thresholds', {}, () => []),
  upsertThreshold: (data) =>
    callApi('/admin/learn/thresholds', { method: 'put', data }, () => data),
};

// ── 教練介紹送審 (F-C06) ─────────────────────
export const adminIntrosApi = {
  list: (status = 'pending') =>
    callApi('/admin/learn/intros', { params: { status } }, () => []),
  approve: (coachId) =>
    callApi(`/admin/learn/intros/${coachId}/approve`, { method: 'post' }, () => ({ id: coachId, intro_review_status: 'published' })),
  reject: (coachId, note) =>
    callApi(`/admin/learn/intros/${coachId}/reject`, { method: 'post', data: { note } }, () => ({ id: coachId, intro_review_status: 'rejected' })),
};
