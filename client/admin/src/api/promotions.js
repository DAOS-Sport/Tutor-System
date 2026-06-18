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
  create:  (payload)       => callApi('/promotions', { method: 'post', data: payload }, () => mockDb.createPromotion(payload)),
  update:  (id, payload)   => callApi(`/promotions/${id}`, { method: 'patch', data: payload }, () => mockDb.updatePromotion(id, payload)),
  // 改版：直接上架（draft→active），取代原送審流程
  activate:(id)            => callApi(`/promotions/${id}/activate`, { method: 'post' }, () => mockDb.transitionPromotion(id, 'active')),
  archive: (id, note)      => callApi(`/promotions/${id}/archive`, { method: 'post', data: { note } }, () => mockDb.transitionPromotion(id, 'archived')),
  // 刪除（無使用紀錄才可硬刪；有紀錄請改用停用）
  remove:  (id)            => callApi(`/promotions/${id}`, { method: 'delete' }, () => mockDb.deletePromotion(id)),
  // 以下三個為舊送審流程，保留以相容但 UI 已不使用
  submit:  (id)            => req(`/promotions/${id}/submit`,  { method: 'post' }),
  approve: (id)            => req(`/promotions/${id}/approve`, { method: 'post' }),
  reject:  (id, note)      => req(`/promotions/${id}/reject`,  { method: 'post', data: { note } }),
};
