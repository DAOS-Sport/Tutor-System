import { http, USE_MOCK } from './client';
import { mockDb } from './mock';

// 這頁的 API 刻意不走 callApi 的 mock 通道，因為要保留 Task #70 的 skipAuthRedirect
// 行為（401/500/timeout 由頁面自己處理，不把使用者踢回登入）。為了讓 demo / mock 模式
// 也能開這頁並試「立即同步」按鈕，這裡直接以 USE_MOCK 分支接 mockDb，real 模式維持原樣。
export const ragicStatusApi = {
  async get() {
    if (USE_MOCK) return mockDb.ragicStatus();
    const r = await http.get('/ragic-status', { skipAuthRedirect: true });
    return r.data;
  },
  async sync(form = 'all') {
    if (USE_MOCK) return mockDb.ragicSync(form);
    // 注意：body 必須是物件（{}）。傳 null 會被 axios 序列化成字面 "null"，
    // 後端 express.json() strict 模式視為非法 JSON → 400（同步 / ping 點下去就失敗）。
    const r = await http.post(
      `/ragic-status/sync?form=${encodeURIComponent(form)}`,
      {},
      { skipAuthRedirect: true }
    );
    return r.data;
  },
  async toggle(job, enabled) {
    if (USE_MOCK) return mockDb.ragicToggle(job, enabled);
    const r = await http.post(
      '/ragic-status/toggle',
      { job, enabled },
      { skipAuthRedirect: true }
    );
    return r.data;
  },
};
