import { callApi } from './client';
import { mockDb } from './mock';

export const promotionsApi = {
  list: () => callApi('/promotions', { method: 'get', skipAuthRedirect: true }, () => mockDb.promotions()),
  preview: (payload) =>
    callApi('/promotions/preview', { method: 'post', data: payload, skipAuthRedirect: true }, () => mockDb.previewPromotion(payload)),
};
