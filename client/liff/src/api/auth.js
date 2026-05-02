import { callApi } from './client';

export const authApi = {
  // 真實階段會帶 LINE access token 比對 Z01；Phase 1 mock 直接成功
  bindLineUid: ({ lineUid, parentId }) =>
    callApi('/auth/bind-line', { method: 'post', data: { lineUid, parentId } }, () => ({
      ok: true,
      bound_at: new Date().toISOString(),
    })),
};
