import { callApi } from './client';
import { mockDb } from './mock';

export const enrollmentsApi = {
  create: (payload) =>
    callApi('/enrollments', {
      method: 'post',
      data: payload,
      headers: payload?.request_id ? { 'Idempotency-Key': payload.request_id } : undefined,
    }, () => mockDb.createEnrollment(payload)),

  // U3：匯款／轉帳證明上傳（家長端，限 JPG/PNG ≤5MB；回傳 { url }）
  uploadPaymentProof: (file) => {
    const form = new FormData();
    form.append('file', file);
    return callApi(
      '/uploads/payment-proof',
      { method: 'post', data: form, headers: { 'Content-Type': 'multipart/form-data' } },
      () => ({ url: `/uploads/mock-proof-${Date.now()}.jpg` }),
    );
  },
};
