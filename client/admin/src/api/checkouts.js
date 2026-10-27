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
    note,
    legacy,
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
          note,
          legacy,
        },
      },
      () => ({ ok: true }),
    ),

  // 雅正轉：待對帳打舊發票（或舊單號）時預覽比對結果（只讀）。
  legacyMatch: (checkoutId, { invoice, seqs } = {}) =>
    callApi(`/checkouts/${checkoutId}/legacy-match`, { params: seqs ? { seqs } : { invoice } }, () => ({ status: 'NOT_FOUND', packages: [], selectable: [], ok: false })),

  // 操作者由後端從已驗證 JWT 寫入 audit，不接受前端 by 欄位。
  cancel: (checkoutId, { reason } = {}) =>
    callApi(`/checkouts/${checkoutId}/cancel`, { method: 'post', data: { reason } }, () => ({ ok: true })),
};
