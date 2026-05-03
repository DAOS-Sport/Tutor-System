import { callApi } from './client';
import { mockDb } from './mock';

export const enrollmentsApi = {
  list: (filters = {}) =>
    callApi('/enrollments', { params: filters }, () => mockDb.enrollments(filters)),

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
};
