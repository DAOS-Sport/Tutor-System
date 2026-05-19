import { callApi } from './client';
import { mockDb } from './mock';

function qs(params) {
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== '' && v != null) q.set(k, v);
  });
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const staffApi = {
  list: (params = {}) =>
    callApi(`/staff${qs(params)}`, {}, () => mockDb.staff(params)),
  create: (body) =>
    callApi(`/staff`, { method: 'post', data: body }, () => mockDb.createStaff?.(body) || { ...body, default_password_hint: body.id }),
  update: (id, patch) =>
    callApi(`/staff/${id}`, { method: 'patch', data: patch }, () => mockDb.updateStaff(id, patch)),
  syncRagic: () =>
    callApi('/staff/sync', { method: 'post', data: {} }, () => ({ synced: 0, skipped: true })),
};
