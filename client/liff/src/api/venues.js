import { callApi } from './client';
import { mockDb } from './mock';

export const venuesApi = {
  list: () => callApi('/venues', { method: 'get', skipAuthRedirect: true }, () => mockDb.venues()),
  detail: (id) => callApi(`/venues/${id}`, { method: 'get', skipAuthRedirect: true }, () => mockDb.venue(id)),
};
