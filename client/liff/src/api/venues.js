import { callApi } from './client';
import { mockDb } from './mock';

export const venuesApi = {
  list: () => callApi('/venues', { method: 'get' }, () => mockDb.venues()),
  detail: (id) => callApi(`/venues/${id}`, { method: 'get' }, () => mockDb.venue(id)),
};
