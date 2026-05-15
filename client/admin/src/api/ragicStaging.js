import { http } from './client';

export const ragicStagingApi = {
  async list(params = {}) {
    const r = await http.get('/ragic-staging', { params });
    return r.data;
  },
  async count() {
    const r = await http.get('/ragic-staging/count');
    return r.data;
  },
  async approve(id) {
    const r = await http.post(`/ragic-staging/${id}/approve`);
    return r.data;
  },
  async reject(id, reason) {
    const r = await http.post(`/ragic-staging/${id}/reject`, { reason });
    return r.data;
  },
  async bulkApprove(ids) {
    const r = await http.post('/ragic-staging/bulk-approve', { ids });
    return r.data;
  },
};
