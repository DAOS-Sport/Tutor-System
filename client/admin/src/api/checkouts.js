import { callApi } from './client';

export const checkoutsApi = {
  list: (filters = {}) =>
    callApi('/checkouts', { params: filters }, () => []),

  get: (checkoutId) =>
    callApi(`/checkouts/${checkoutId}`, {}, () => null),

  reconcile: (checkoutId, { by, invoice_number, invoice_image_url, invoice_url, buyer_name, tax_id } = {}) =>
    callApi(
      `/checkouts/${checkoutId}/reconcile`,
      { method: 'post', data: { by, invoice_number, invoice_image_url, invoice_url, buyer_name, tax_id } },
      () => ({ ok: true }),
    ),

  cancel: (checkoutId, { reason, by } = {}) =>
    callApi(`/checkouts/${checkoutId}/cancel`, { method: 'post', data: { reason, by } }, () => ({ ok: true })),
};
