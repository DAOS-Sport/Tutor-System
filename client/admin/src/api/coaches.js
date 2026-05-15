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

export const coachesApi = {
  list: (params = {}) =>
    callApi(`/coaches${qs(params)}`, {}, () => mockDb.coaches(params)),
  get:  (id) => callApi(`/coaches/${id}`, {}, () => mockDb.coachDetail(id)),
  update: (id, patch) =>
    callApi(`/coaches/${id}`, { method: 'patch', data: patch },
      () => mockDb.updateCoach(id, patch)),
  syncRagic: () =>
    callApi('/coaches/sync', { method: 'post', data: {} }, () => ({ synced: 0, skipped: true })),
};
