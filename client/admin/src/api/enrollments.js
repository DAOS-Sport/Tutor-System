import { callApi } from './client';
import { mockDb } from './mock';

export const enrollmentsApi = {
  list: (filters = {}) =>
    callApi('/enrollments', { params: filters }, () => mockDb.enrollments(filters)),

  // 櫃檯手動建檔：建立 pending_payment 報名（總堂數 > 6 後端自動拆期）。
  create: (payload) =>
    callApi('/enrollments', { method: 'post', data: payload }, () => ({
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

  refundPreview: (id) =>
    callApi(`/enrollments/${id}/refund-preview`, {}, () => mockDb.refundPreview(id)),

  refund: (id, reason, by) =>
    callApi(`/enrollments/${id}/refund`, { method: 'post', data: { reason, by } }, () => mockDb.refundEnrollment(id, reason, by)),

  cancel: (id, { reason, by } = {}) =>
    callApi(`/enrollments/${id}/cancel`, { method: 'post', data: { reason, by } }, () => mockDb.cancelEnrollment(id, reason, by)),
};
