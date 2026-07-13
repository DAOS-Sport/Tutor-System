import { callApi } from './client';

export const manualDeductionsApi = {
  search: (search) => callApi('/manual-deductions', { params: { search } }, () => []),
  create: (payload) => callApi('/manual-deductions', {
    method: 'post',
    data: payload,
    headers: payload?.request_id ? { 'Idempotency-Key': payload.request_id } : undefined,
  }, () => ({
    ok: true,
    idempotent: false,
    deduction: {
      id: 'mock-manual-deduction',
      course_period_id: payload.course_period_id,
      student_id: payload.student_id,
      remaining_before: 1,
      remaining_after: 0,
      reason: payload.reason,
    },
  })),
};
