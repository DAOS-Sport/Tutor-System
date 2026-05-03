import { callApi } from './client';
import { mockDb } from './mock';

export const coachesApi = {
  list: () => callApi('/coaches', {}, () => mockDb.coaches()),
  get:  (id) => callApi(`/coaches/${id}`, {}, () => mockDb.coachDetail(id)),
  update: (id, patch) =>
    callApi(`/coaches/${id}`, { method: 'patch', data: patch },
      () => mockDb.updateCoach(id, patch)),
};
