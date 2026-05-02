import { callApi } from './client';
import { mockDb } from './mock';

export const staffApi = {
  list: () => callApi('/staff', {}, () => mockDb.staff()),
  update: (id, patch) =>
    callApi(`/staff/${id}`, { method: 'patch', data: patch }, () => mockDb.updateStaff(id, patch)),
};
