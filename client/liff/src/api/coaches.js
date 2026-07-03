import { callApi } from './client';
import { mockDb } from './mock';

export const coachesApi = {
  list: ({ venueId } = {}) =>
    callApi('/coaches', { method: 'get', params: { venueId }, skipAuthRedirect: true }, () => mockDb.coaches({ venueId })),

  detail: (id) =>
    callApi(`/coaches/${id}`, { method: 'get', skipAuthRedirect: true }, () => mockDb.coach(id)),

  // 教練端登入：手機 +（如可取得）LINE id_token 雙因素
  // 安全考量：id_token 走 header（X-Line-Id-Token）而非 query string，避免在 access log / proxy 留痕
  byPhone: (phone, idToken = null) =>
    callApi(
      '/coaches/by-phone',
      {
        method: 'get',
        params: { phone },
        headers: idToken ? { 'X-Line-Id-Token': idToken } : undefined,
        skipAuthRedirect: true,
      },
      () => mockDb.coachByPhone(phone)
    ),

  // 教練端 LIFF 自動登入（Task #34）：用 LINE userId + id_token 直接登入，不用打手機
  // mock 模式直接 reject，讓上層 fallback 到手機表單
  byLineUid: (lineUid, idToken) =>
    callApi(
      '/coaches/by-line-uid',
      {
        method: 'get',
        params: { lineUid },
        headers: { 'X-Line-Id-Token': idToken },
        skipAuthRedirect: true,
      },
      () => Promise.reject(new Error('byLineUid not available in mock mode'))
    ),

  // 個人介紹文字
  updateBio: (id, bio_rich_text) =>
    callApi(`/coaches/${id}/bio`, { method: 'put', data: { bio_rich_text } }, () =>
      mockDb.updateCoachBio(id, bio_rich_text)),

  // 介紹媒體
  listMedia: (id) =>
    callApi(`/coaches/${id}/media`, { method: 'get' }, () => mockDb.coachMedia(id)),

  addMedia: (id, payload) =>
    callApi(`/coaches/${id}/media`, { method: 'post', data: payload }, () =>
      mockDb.addCoachMedia(id, payload)),

  // 上傳圖片檔並新增介紹媒體（一次往返）
  uploadMedia: (id, file, alt = '') => {
    const form = new FormData();
    form.append('file', file);
    if (alt) form.append('alt_text', alt);
    return callApi(`/coaches/${id}/media/upload`, { method: 'post', data: form }, () =>
      mockDb.addCoachMedia(id, { storage_url: `/uploads/mock-coach-${Date.now()}.jpg`, alt_text: alt }));
  },

  reorderMedia: (id, ids) =>
    callApi(`/coaches/${id}/media/reorder`, { method: 'patch', data: { ids } }, () =>
      mockDb.reorderCoachMedia(id, ids)),

  deleteMedia: (id, mediaId) =>
    callApi(`/coaches/${id}/media/${mediaId}`, { method: 'delete' }, () =>
      mockDb.deleteCoachMedia(id, mediaId)),
};
