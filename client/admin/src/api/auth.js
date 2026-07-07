import { callApi } from './client';
import { mockDb } from './mock';

export const authApi = {
  login: ({ username, password }) =>
    callApi('/auth/login', { method: 'post', data: { username, password } }, () => mockDb.login(username, password)),
  changePassword: ({ oldPassword, newPassword, newUsername }) =>
    callApi('/auth/change-password', { method: 'post', data: { oldPassword, newPassword, newUsername } }, () => ({ ok: true, username: newUsername })),
};
