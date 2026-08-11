import { callApi } from './client';
import { mockDb } from './mock';

export const enrollmentsApi = {
  list: (filters = {}) =>
    callApi('/enrollments', { params: filters }, () => mockDb.enrollments(filters)),

  detail: (id) =>
    callApi(`/enrollments/${id}`, {}, () => mockDb.enrollmentDetail(id)),

  // 櫃檯手動建檔：建立 pending_payment 報名（總堂數 > 6 後端自動拆期）。
  create: (payload) =>
    callApi('/enrollments', {
      method: 'post',
      data: payload,
      headers: payload?.request_id ? { 'Idempotency-Key': payload.request_id } : undefined,
    }, () => ({
      id: `E-MOCK-${Date.now().toString(36).toUpperCase()}`,
      status: 'pending_payment',
      count: Math.max(1, Math.ceil((Number(payload?.total_sessions) || 6) / 6)),
    })),

  update: (id, payload) =>
    callApi(`/enrollments/${id}`, { method: 'patch', data: payload }, () => mockDb.updateEnrollment(id, payload)),

  uploadInvoice: (file) => {
    const form = new FormData();
    form.append('file', file);
    return callApi('/uploads/invoice', { method: 'post', data: form }, () => ({
      url: `/uploads/mock-invoice-${Date.now()}.jpg`,
    }));
  },

  reconcile: (id, { by, invoice_number, invoice_image_url, invoice_url } = {}) =>
    callApi(
      `/enrollments/${id}/reconcile`,
      { method: 'post', data: { by, invoice_number, invoice_image_url, invoice_url } },
      () => mockDb.reconcile(id, by),
    ),

  // feeRate（0–1）給了就用它重算金額；不給則用全域設定的手續費率。
  refundPreview: (id, feeRate) =>
    callApi(
      `/enrollments/${id}/refund-preview`,
      { params: feeRate === null || feeRate === undefined ? undefined : { fee_rate: feeRate } },
      () => mockDb.refundPreview(id),
    ),

  // payload：{ reason_category, reason_detail, fee_rate, by }
  // 後端仍接受舊的單一 reason 字串（部署期間新舊前端交錯時不會全部退不了）。
  refund: (id, payload) =>
    callApi(
      `/enrollments/${id}/refund`,
      { method: 'post', data: payload },
      () => mockDb.refundEnrollment(id, payload.reason_detail || payload.reason, payload.by),
    ),

  cancel: (id, { reason, by } = {}) =>
    callApi(`/enrollments/${id}/cancel`, { method: 'post', data: { reason, by } }, () => mockDb.cancelEnrollment(id, reason, by)),

  // U14 退回補件：與 cancel（終態）並存。把單退回 pending_payment 並清空付款欄位，
  // 家長可重新填末 5 碼／重傳證明後繼續完成，不需要重新報名。
  // 有 checkout_id 時後端會一併把整張 checkout 的付款欄位與狀態退回。
  returnForFix: (id, reason) =>
    callApi(`/enrollments/${id}/return-for-fix`, { method: 'post', data: { reason } }, () => {
      throw new Error('退回補件需在真實 API 模式下使用');
    }),
};
