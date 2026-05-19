import { callApi } from './client';
import { mockDb } from './mock';

export const authApi = {
  login: ({ username, password }) =>
    callApi('/auth/login', { method: 'post', data: { username, password } }, () => mockDb.login(username, password)),
  changePassword: ({ oldPassword, newPassword }) =>
    callApi('/auth/change-password', { method: 'post', data: { oldPassword, newPassword } }, () => ({ ok: true })),
};
