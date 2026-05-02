import { callApi } from './client';
import { mockDb } from './mock';

export const parentsApi = {
  /**
   * 家長登入 — 走 /api/auth/parent-login 取得 JWT（chat WebSocket / HTTP 必需）。
   * Backend 找不到家長時回傳 null，與 mock parentByPhone 對齊。
   */
  findByPhone: (phone) =>
    callApi(
      '/auth/parent-login',
      { method: 'post', data: { phone } },
      () => mockDb.parentByPhone(phone),
    ),

  create: (data) =>
    callApi('/parents', { method: 'post', data }, () => mockDb.createParent(data)),
};
