import { callApi } from './client';
import { mockDb } from './mock';

export const coursesApi = {
  // venue 是必填：價格依場館所屬定價區而定，少了它後端會回 400（而不是猜一個區）。
  basePrice: (courseType, venue) =>
    callApi('/courses/base-price', { method: 'get', params: { courseType, venue } }, () => ({
      course_type: courseType,
      original_price: mockDb.basePrice(courseType),
    })),

  myCourses: (parentId) =>
    callApi('/courses/mine', { method: 'get', params: { parentId } }, () => mockDb.myCourses(parentId)),

  // U10：單筆報名狀態（報名狀態頁）
  get: (id) =>
    callApi(`/courses/${id}`, { method: 'get' }, () => mockDb.course(id)),

  // 訂單成立後填寫付款資料到某筆 pending 報名
  uploadProof: (id, payload) => {
    const data = typeof payload === 'string' ? { payment_proof_url: payload } : (payload || {});
    return callApi(`/courses/${id}/payment-proof`, { method: 'post', data }, () => mockDb.uploadPaymentProofForCourse(id, data));
  },

  cancelPending: (id) =>
    callApi(`/courses/${id}/cancel`, { method: 'post' }, () => mockDb.cancelPendingCourse(id)),
};
