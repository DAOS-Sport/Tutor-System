import { callApi } from './client';

// U7 團購審核 API（後台）。團購為全新流程，無 mock 資料；真實模式使用。
export const groupOrdersApi = {
  list:    (status)        => callApi('/group-orders', { params: status ? { status } : {} }, () => []),
  get:     (id)            => callApi(`/group-orders/${id}`, {}, () => null),
  approve: (id)            => callApi(`/group-orders/${id}/approve`, { method: 'post' }, () => ({ ok: true })),
  reject:  (id, reason)    => callApi(`/group-orders/${id}/reject`, { method: 'post', data: { reason } }, () => ({ ok: true })),
};
