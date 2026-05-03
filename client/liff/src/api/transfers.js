import { callApi } from './client';

export const transfersApi = {
  mine: () => callApi('/transfers/mine', {}, () => []),
  create: (data) =>
    callApi('/transfers', { method: 'post', data }, () => ({ id: 'tr_mock', status: 'pending_review', ...data })),
};
