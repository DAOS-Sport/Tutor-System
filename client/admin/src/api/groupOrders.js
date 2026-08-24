import { callApi } from './client';

// U7 團購審核 API（後台）。團購為全新流程，無 mock 資料；真實模式使用。
export const groupOrdersApi = {
  list:    (status)        => callApi('/group-orders', { params: status ? { status } : {} }, () => []),
  get:     (id)            => callApi(`/group-orders/${id}`, {}, () => null),
  // U15 櫃檯代為送審：團主漏按送審時，把「已收齊款、人數到位」的團推進待審核。
  // 條件由後端守門（與家長端送審同一份），前端不重算。
  submit:  (id)            => callApi(`/group-orders/${id}/submit`, { method: 'post' }, () => ({ ok: true })),
  approve: (id)            => {
    const requestId = `group-approve:${id}`;
    return callApi(`/group-orders/${id}/approve`, {
      method: 'post',
      data: { request_id: requestId },
      headers: { 'Idempotency-Key': requestId },
    }, () => ({ ok: true }));
  },
  reject:  (id, reason)    => callApi(`/group-orders/${id}/reject`, { method: 'post', data: { reason } }, () => ({ ok: true })),
  // U14 退回補件：與 reject（終態）並存。退回 forming 讓家長補齊後重新送審。
  // resetMemberIds：要清空付款資料供重填的成員（家長端末 5 碼是鎖死的，不由櫃檯清就改不了）。
  returnForFix: (id, reason, resetMemberIds = []) =>
    callApi(`/group-orders/${id}/return-for-fix`, {
      method: 'post',
      data: { reason, reset_member_ids: resetMemberIds },
    }, () => ({ ok: true })),
};
