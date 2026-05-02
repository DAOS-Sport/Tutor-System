import { callApi } from './client';
import { mockDb } from './mock';

export const coachesApi = {
  list: ({ venueId } = {}) =>
    callApi('/coaches', { method: 'get', params: { venueId } }, () => mockDb.coaches({ venueId })),
  detail: (id) => callApi(`/coaches/${id}`, { method: 'get' }, () => mockDb.coach(id)),
};
