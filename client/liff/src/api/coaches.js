import { callApi } from './client';
import { mockDb } from './mock';

export const coachesApi = {
  list: ({ venueId } = {}) =>
    callApi('/coaches', { method: 'get', params: { venueId } }, () => mockDb.coaches({ venueId })),

  detail: (id) =>
    callApi(`/coaches/${id}`, { method: 'get' }, () => mockDb.coach(id)),

  // 教練端登入：以手機比對 coaches.phone
  byPhone: (phone) =>
    callApi('/coaches/by-phone', { method: 'get', params: { phone } }, () => mockDb.coachByPhone(phone)),

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
