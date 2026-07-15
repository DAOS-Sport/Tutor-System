import { callApi } from './client';

export const checkoutsApi = {
  list: (filters = {}) =>
    callApi('/checkouts', { params: filters }, () => []),

  get: (checkoutId) =>
    callApi(`/checkouts/${checkoutId}`, {}, () => null),

  reconcile: (checkoutId, {
    invoice_number,
    invoice_image_url,
    invoice_url,
    buyer_name,
    tax_id,
    carrier,
    family_invoices,
  } = {}) =>
    callApi(
      `/checkouts/${checkoutId}/reconcile`,
      {
        method: 'post',
        data: {
          invoice_number,
          invoice_image_url,
          invoice_url,
          buyer_name,
          tax_id,
          carrier,
          family_invoices,
        },
      },
      () => ({ ok: true }),
    ),

  // 操作者由後端從已驗證 JWT 寫入 audit，不接受前端 by 欄位。
  cancel: (checkoutId, { reason } = {}) =>
    callApi(`/checkouts/${checkoutId}/cancel`, { method: 'post', data: { reason } }, () => ({ ok: true })),
};
