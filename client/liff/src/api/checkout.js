import { callApi } from './client';
import { mockDb } from './mock';

export const checkoutApi = {
  route: (payload) => {
    const input = payload || {};
    const batchId = input.enrollment_batch_id || input.batch_id || '';
    // success page / My Courses refresh 對同一 batch 使用同一 key；後端仍以
    // actor + operation + fingerprint 驗證，重試只會回原 checkout。
    const requestId = input.request_id || `checkout-route:${batchId}`;
    const data = { ...input, request_id: requestId };
    return callApi('/checkout/route', {
      method: 'post',
      data,
      headers: { 'Idempotency-Key': requestId },
    }, () => mockDb.routeCheckout?.(data) || { ok: false });
  },

  get: (checkoutId) =>
    callApi(`/checkout/${checkoutId}`, { method: 'get' }, () => mockDb.checkout?.(checkoutId)),

  uploadProof: (checkoutId, payload) =>
    callApi(`/checkout/${checkoutId}/payment-proof`, { method: 'post', data: payload || {} }, () => ({ ok: true })),

  cancel: (checkoutId) =>
    callApi(`/checkout/${checkoutId}/cancel`, { method: 'post' }, () => ({ ok: true })),
};
