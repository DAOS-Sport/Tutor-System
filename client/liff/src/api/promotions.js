import { callApi } from './client';
import { mockDb } from './mock';

export const promotionsApi = {
  list: () => callApi('/promotions', { method: 'get' }, () => mockDb.promotions()),
  preview: (payload) =>
    callApi('/promotions/preview', { method: 'post', data: payload }, () => mockDb.previewPromotion(payload)),
};
