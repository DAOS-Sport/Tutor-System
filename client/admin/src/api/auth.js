import { callApi } from './client';
import { mockDb } from './mock';

export const authApi = {
  login: ({ username, password }) =>
    callApi('/auth/login', { method: 'post', data: { username, password } }, () => mockDb.login(username, password)),
};
