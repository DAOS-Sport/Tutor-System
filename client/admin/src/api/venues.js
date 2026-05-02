import { callApi } from './client';
import { mockDb } from './mock';

export const venuesApi = {
  list: () => callApi('/venues', {}, () => mockDb.venues()),
  update: (id, patch) =>
    callApi(`/venues/${id}`, { method: 'patch', data: patch }, () => mockDb.updateVenue(id, patch)),
};
