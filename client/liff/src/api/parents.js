import { callApi } from './client';
import { mockDb } from './mock';

export const parentsApi = {
  create: (data) =>
    callApi('/parents', { method: 'post', data }, () => mockDb.createParent(data)),
};
