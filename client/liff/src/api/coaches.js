import { callApi } from './client';
import { mockDb } from './mock';

export const coachesApi = {
  list: ({ venueId } = {}) =>
    callApi('/coaches', { method: 'get', params: { venueId } }, () => mockDb.coaches({ venueId })),

  detail: (id) =>
    callApi(`/coaches/${id}`, { method: 'get' }, () => mockDb.coach(id)),

  // 教練端登入：手機 +（如可取得）LINE id_token 雙因素
  // 安全考量：id_token 走 header（X-Line-Id-Token）而非 query string，避免在 access log / proxy 留痕
  byPhone: (phone, idToken = null) =>
    callApi(
      '/coaches/by-phone',
      {
        method: 'get',
        params: { phone },
        headers: idToken ? { 'X-Line-Id-Token': idToken } : undefined,
      },
      () => mockDb.coachByPhone(phone)
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

  reorderMedia: (id, ids) =>
    callApi(`/coaches/${id}/media/reorder`, { method: 'patch', data: { ids } }, () =>
      mockDb.reorderCoachMedia(id, ids)),

  deleteMedia: (id, mediaId) =>
    callApi(`/coaches/${id}/media/${mediaId}`, { method: 'delete' }, () =>
      mockDb.deleteCoachMedia(id, mediaId)),
};
