import { http, callApi } from './client';
import { mockDb } from './mock';

// 直打真後端（需要真實 JWT），用於 admin/manager 操作
async function req(path, options = {}) {
  const { method = 'get', data, params } = options;
  const res = await http.request({ url: path, method, data, params });
  return res.data;
}

export const promotionsApi = {
  // active：staff 也需要看，必須尊重 USE_MOCK（mock token 打不了真後端）
  active:  ()              => callApi('/promotions/active', {}, () => mockDb.activePromotions()),
  list:    (params)        => callApi('/promotions', { params }, () => mockDb.allPromotions(params)),
  detail:  (id)            => req(`/promotions/${id}`),
  create:  (payload)       => req('/promotions', { method: 'post', data: payload }),
  update:  (id, payload)   => req(`/promotions/${id}`, { method: 'patch', data: payload }),
  submit:  (id)            => req(`/promotions/${id}/submit`,  { method: 'post' }),
  approve: (id)            => req(`/promotions/${id}/approve`, { method: 'post' }),
  reject:  (id, note)      => req(`/promotions/${id}/reject`,  { method: 'post', data: { note } }),
  archive: (id, note)      => req(`/promotions/${id}/archive`, { method: 'post', data: { note } }),
};
