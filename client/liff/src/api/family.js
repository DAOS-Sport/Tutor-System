import { callApi } from './client';
import { familyMock } from './familyMock';

// 家庭帳號（規格 docs/family_accounts_spec_2026-09-23.md §8、§14）：家長自助合併申請與退出。
// 家庭的資料（成員、家人的孩子、審核中的申請、重複學員）跟著 GET /parents/me 的 family 區塊回來。
export const RELATIONSHIP_OPTIONS = [
  { value: 'father', label: '爸爸' },
  { value: 'mother', label: '媽媽' },
  { value: 'grandfather', label: '爺爺' },
  { value: 'grandmother', label: '奶奶' },
  { value: 'maternal_grandfather', label: '外公' },
  { value: 'maternal_grandmother', label: '外婆' },
  { value: 'guardian', label: '其他照顧者' },
];

export const familyApi = {
  // { student_name, parent_phone, relationship, note? } → 201 等對方家長同意；資料不符一律 422 通用訊息
  createRequest: (data) =>
    callApi('/family/requests', { method: 'post', data }, () => familyMock.createRequest(data)),
  cancelRequest: (id) =>
    callApi(`/family/requests/${id}`, { method: 'delete' }, () => familyMock.cancelRequest(id)),
  // 別人申請加入我的家庭：我是孩子的家長（還沒有家庭）或家庭的擁有者時可以同意／拒絕
  approveRequest: (id) =>
    callApi(`/family/requests/${id}/approve`, { method: 'post' }, () => familyMock.approveRequest(id)),
  rejectRequest: (id, reason) =>
    callApi(`/family/requests/${id}/reject`, { method: 'post', data: { reason } }, () => familyMock.rejectRequest(id)),
  // 擁有者解綁加入的家人（擁有者本人不能被解綁）
  revokeMember: (parentId) =>
    callApi(`/family/members/${parentId}/revoke`, { method: 'post' }, () => familyMock.revokeMember(parentId)),
  leave: () =>
    callApi('/family/leave', { method: 'post' }, () => familyMock.leave()),
  // 家長自己邀請家人（只限擁有者；還沒有家庭的家長先放在準備中的家庭，有人加入才成立、他當擁有者）
  createInvite: () =>
    callApi('/family/invites', { method: 'post' }, () => familyMock.createInvite()),
  revokeInvite: (id) =>
    callApi(`/family/invites/${id}/revoke`, { method: 'post' }, () => familyMock.revokeInvite(id)),
  // 邀請連結（櫃台或擁有者產生）：預覽誰邀請、加入
  invitePreview: (token) =>
    callApi(`/family/invites/${encodeURIComponent(token)}`, {}, () => familyMock.invitePreview(token)),
  acceptInvite: (token, relationship) =>
    callApi(`/family/invites/${encodeURIComponent(token)}/accept`, { method: 'post', data: { relationship } },
      () => familyMock.acceptInvite(token, relationship)),
};
