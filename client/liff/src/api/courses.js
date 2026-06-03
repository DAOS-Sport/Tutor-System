import { callApi } from './client';
import { mockDb } from './mock';

export const coursesApi = {
  basePrice: (courseType) =>
    callApi('/courses/base-price', { method: 'get', params: { courseType } }, () => ({
      course_type: courseType,
      original_price: mockDb.basePrice(courseType),
    })),

  myCourses: (parentId) =>
    callApi('/courses/mine', { method: 'get', params: { parentId } }, () => mockDb.myCourses(parentId)),

  // U10：單筆報名狀態（報名狀態頁）
  get: (id) =>
    callApi(`/courses/${id}`, { method: 'get' }, () => null),

  // U10：事後上傳匯款證明到某筆 pending 報名
  uploadProof: (id, payment_proof_url) =>
    callApi(`/courses/${id}/payment-proof`, { method: 'post', data: { payment_proof_url } }, () => ({ ok: true })),
};
