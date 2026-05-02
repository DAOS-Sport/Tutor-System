import { http } from './client';

// 後台優惠活動 API：強制走真後端 axios（繞過 callApi 的 USE_MOCK 短路），
// 確保 QA 在 mock 模式下仍能驗收真實後端行為。
async function req(path, options = {}) {
  const { method = 'get', data, params } = options;
  const res = await http.request({ url: path, method, data, params });
  return res.data;
}

export const promotionsApi = {
  list:    (params)        => req('/promotions', { params }),
  active:  ()              => req('/promotions/active'),
  detail:  (id)            => req(`/promotions/${id}`),
  create:  (payload)       => req('/promotions', { method: 'post', data: payload }),
  update:  (id, payload)   => req(`/promotions/${id}`, { method: 'patch', data: payload }),
  submit:  (id)            => req(`/promotions/${id}/submit`,  { method: 'post' }),
  approve: (id)            => req(`/promotions/${id}/approve`, { method: 'post' }),
  reject:  (id, note)      => req(`/promotions/${id}/reject`,  { method: 'post', data: { note } }),
  archive: (id, note)      => req(`/promotions/${id}/archive`, { method: 'post', data: { note } }),
};
