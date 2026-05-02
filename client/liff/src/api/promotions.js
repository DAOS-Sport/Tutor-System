import { callApi } from './client';
import { mockDb } from './mock';

export const promotionsApi = {
  list: () => callApi('/promotions', { method: 'get' }, () => mockDb.promotions()),
};
