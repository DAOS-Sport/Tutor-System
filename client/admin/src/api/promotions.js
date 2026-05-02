import { callApi } from './client';

// 後台優惠活動 API（無 mock；本模組需要真實後端）
export const promotionsApi = {
  list:    (params)        => callApi('/promotions', { params }, () => []),
  active:  ()              => callApi('/promotions/active', {}, () => []),
  detail:  (id)            => callApi(`/promotions/${id}`, {}, () => null),
  create:  (payload)       => callApi('/promotions', { method: 'post', data: payload }, () => payload),
  update:  (id, payload)   => callApi(`/promotions/${id}`, { method: 'patch', data: payload }, () => payload),
  submit:  (id)            => callApi(`/promotions/${id}/submit`,  { method: 'post' }, () => ({ ok: true })),
  approve: (id)            => callApi(`/promotions/${id}/approve`, { method: 'post' }, () => ({ ok: true })),
  reject:  (id, note)      => callApi(`/promotions/${id}/reject`,  { method: 'post', data: { note } }, () => ({ ok: true })),
  archive: (id, note)      => callApi(`/promotions/${id}/archive`, { method: 'post', data: { note } }, () => ({ ok: true })),
};
