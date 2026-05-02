import { callApi } from './client';
import { mockDb } from './mock';

export const settingsApi = {
  get: () => callApi('/settings', {}, () => mockDb.settings()),
  update: (patch) =>
    callApi('/settings', { method: 'patch', data: patch }, () => mockDb.updateSettings(patch)),
};
