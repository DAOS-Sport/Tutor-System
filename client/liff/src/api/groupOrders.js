import { callApi } from './client';

// U7 團購（group buy）家長端 API。團購為全新流程，沒有 mock 資料，
// 統一在真實模式（VITE_USE_MOCK=false）使用；mock 模式下回傳空集合避免崩潰。
export const groupOrdersApi = {
  create: (payload) =>
    callApi('/group-orders', { method: 'post', data: payload }, () => {
      throw new Error('團購功能需在真實 API 模式下使用');
    }),

  mine: () =>
    callApi('/group-orders/mine', { method: 'get' }, () => []),

  get: (id) =>
    callApi(`/group-orders/${id}`, { method: 'get' }, () => null),

  preview: (token) =>
    callApi(`/group-orders/by-token/${token}`, { method: 'get' }, () => null),

  join: (token, payload) =>
    callApi(`/group-orders/by-token/${token}/join`, { method: 'post', data: payload }, () => {
      throw new Error('團購功能需在真實 API 模式下使用');
    }),

  submit: (id) =>
    callApi(`/group-orders/${id}/submit`, { method: 'post' }, () => {
      throw new Error('團購功能需在真實 API 模式下使用');
    }),

  cancel: (id) =>
    callApi(`/group-orders/${id}/cancel`, { method: 'post' }, () => {
      throw new Error('團購功能需在真實 API 模式下使用');
    }),
};
