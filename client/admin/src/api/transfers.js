import { callApi } from './client';

export const adminTransfersApi = {
  list: (params = {}) =>
    callApi('/transfers', { params }, () => []),
  approve: (id, note) =>
    callApi(`/transfers/${id}/approve`, { method: 'post', data: { note } },
      () => ({ id, status: 'approved' })),
  reject: (id, note) =>
    callApi(`/transfers/${id}/reject`, { method: 'post', data: { note } },
      () => ({ id, status: 'rejected' })),
};
