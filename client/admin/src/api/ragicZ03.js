import { http } from './client';

// Task #70 慣例：skipAuthRedirect:true，401 由頁面自己判斷是否登出。
export const ragicZ03Api = {
  async list(status = 'pending', q = '') {
    const params = { status };
    if (q) params.q = q;
    const r = await http.get('/ragic-z03', { params, skipAuthRedirect: true });
    return r.data;
  },
  async saveDraft(id, payload) {
    const r = await http.patch(`/ragic-z03/${id}/draft`, payload, { skipAuthRedirect: true });
    return r.data;
  },
  async resolve(id, fixedName) {
    const r = await http.patch(`/ragic-z03/${id}`, { fixed_name: fixedName }, { skipAuthRedirect: true });
    return r.data;
  },
  async dismiss(id) {
    const r = await http.post(`/ragic-z03/${id}/dismiss`, {}, { skipAuthRedirect: true });
    return r.data;
  },
};
