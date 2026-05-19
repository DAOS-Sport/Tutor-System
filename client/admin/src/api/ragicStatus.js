import { http } from './client';

// Task #70：兩支 API 全部加 skipAuthRedirect:true，讓頁面自己 try/catch 處理
// 401/500/timeout，不把使用者踢回登入頁。真正的 token 過期（localStorage 已清空）
// 由 RequireAuth component 在元件渲染期擋住，不會打到這兩支 API。
export const ragicStatusApi = {
  async get() {
    const r = await http.get('/ragic-status', { skipAuthRedirect: true });
    return r.data;
  },
  async sync(form = 'all') {
    const r = await http.post(
      `/ragic-status/sync?form=${encodeURIComponent(form)}`,
      null,
      { skipAuthRedirect: true }
    );
    return r.data;
  },
};
