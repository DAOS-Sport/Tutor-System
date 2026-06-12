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
    // 注意：body 必須是物件（{}）。傳 null 會被 axios 序列化成字面 "null"，
    // 後端 express.json() strict 模式視為非法 JSON → 400（同步 / ping 點下去就失敗）。
    const r = await http.post(
      `/ragic-status/sync?form=${encodeURIComponent(form)}`,
      {},
      { skipAuthRedirect: true }
    );
    return r.data;
  },
};
