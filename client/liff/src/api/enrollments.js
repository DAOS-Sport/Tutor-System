import { callApi } from './client';
import { mockDb } from './mock';

export const enrollmentsApi = {
  create: (payload) =>
    callApi('/enrollments', { method: 'post', data: payload }, () => mockDb.createEnrollment(payload)),
};
