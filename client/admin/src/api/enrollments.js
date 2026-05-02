import { callApi } from './client';
import { mockDb } from './mock';

export const enrollmentsApi = {
  list: (filters = {}) =>
    callApi('/enrollments', { params: filters }, () => mockDb.enrollments(filters)),
  reconcile: (id, by) =>
    callApi(`/enrollments/${id}/reconcile`, { method: 'post', data: { by } }, () => mockDb.reconcile(id, by)),
  refundPreview: (id) =>
    callApi(`/enrollments/${id}/refund-preview`, {}, () => mockDb.refundPreview(id)),
  refund: (id, reason, by) =>
    callApi(`/enrollments/${id}/refund`, { method: 'post', data: { reason, by } }, () => mockDb.refundEnrollment(id, reason, by)),
};
