import { http } from './client';

// Task #70：所有 Ragic 待審核 API 全面加 skipAuthRedirect:true。
// 頁面自己 try/catch 顯示 toast，不走全域 401 → 登出流程。
// 背景輪詢的 count() 在 Task #68 已有此 flag，其餘互動式呼叫本次補齊。
export const ragicStagingApi = {
  async list(params = {}) {
    const r = await http.get('/ragic-staging', { params, skipAuthRedirect: true });
    return r.data;
  },
  async count() {
    // Task #68：背景輪詢用，401 不要觸發全域登出/跳轉，靜默忽略即可
    const r = await http.get('/ragic-staging/count', { skipAuthRedirect: true });
    return r.data;
  },
  async approve(id) {
    const r = await http.post(`/ragic-staging/${id}/approve`, null, { skipAuthRedirect: true });
    return r.data;
  },
  async reject(id, reason) {
    const r = await http.post(`/ragic-staging/${id}/reject`, { reason }, { skipAuthRedirect: true });
    return r.data;
  },
  async bulkApprove(ids) {
    const r = await http.post('/ragic-staging/bulk-approve', { ids }, { skipAuthRedirect: true });
    return r.data;
  },
};
