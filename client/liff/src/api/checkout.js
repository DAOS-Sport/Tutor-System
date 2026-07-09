import { callApi } from './client';
import { mockDb } from './mock';

export const checkoutApi = {
  route: (payload) =>
    callApi('/checkout/route', { method: 'post', data: payload || {} }, () => mockDb.routeCheckout?.(payload || {}) || { ok: false }),

  get: (checkoutId) =>
    callApi(`/checkout/${checkoutId}`, { method: 'get' }, () => mockDb.checkout?.(checkoutId)),

  uploadProof: (checkoutId, payload) =>
    callApi(`/checkout/${checkoutId}/payment-proof`, { method: 'post', data: payload || {} }, () => ({ ok: true })),

  cancel: (checkoutId) =>
    callApi(`/checkout/${checkoutId}/cancel`, { method: 'post' }, () => ({ ok: true })),
};
