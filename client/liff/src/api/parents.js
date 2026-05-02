import { callApi } from './client';
import { mockDb } from './mock';

export const parentsApi = {
  findByPhone: (phone) =>
    callApi('/parents/by-phone', { method: 'get', params: { phone } }, () => mockDb.parentByPhone(phone)),

  create: (data) =>
    callApi('/parents', { method: 'post', data }, () => mockDb.createParent(data)),
};
