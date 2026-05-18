import { http } from './client';

export const ragicStagingApi = {
  async list(params = {}) {
    const r = await http.get('/ragic-staging', { params });
    return r.data;
  },
  async count() {
    // Task #68：背景輪詢用，401 不要觸發全域登出/跳轉，靜默忽略即可
    const r = await http.get('/ragic-staging/count', { skipAuthRedirect: true });
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
