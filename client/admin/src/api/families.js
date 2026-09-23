import { callApi } from './client';
import { familyMock } from './familyMock';

// 家庭帳號（規格 docs/family_accounts_spec_2026-09-23.md §7、§14）：Z01 頁的家庭區塊與申請審核。
// 後端 /api/admin/families；權限沿用 Z01 頁（customer-parents），轉移擁有者與凍結限 admin。
export const RELATIONSHIP_OPTIONS = [
  { value: 'father', label: '爸爸' },
  { value: 'mother', label: '媽媽' },
  { value: 'grandfather', label: '爺爺' },
  { value: 'grandmother', label: '奶奶' },
  { value: 'maternal_grandfather', label: '外公' },
  { value: 'maternal_grandmother', label: '外婆' },
  { value: 'guardian', label: '其他照顧者' },
];

export const familiesApi = {
  byParent: (parentId) =>
    callApi(`/families/by-parent/${parentId}`, {}, () => familyMock.byParent(parentId)),
  create: (ownerParentId, ownerRelationship) =>
    callApi('/families', { method: 'post', data: { owner_parent_id: ownerParentId, owner_relationship: ownerRelationship || null } },
      () => familyMock.create(ownerParentId, ownerRelationship)),
  // 櫃台添加成員前查帳號：手機＋姓名；姓名對得上才回 LINE UID
  lookup: (phone, name) =>
    callApi(`/families/lookup?phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}`, {},
      () => familyMock.lookup(phone, name)),
  // 邀請連結：只能用一次、7 天有效。這位家長還沒有家庭時，後端會先以他為擁有者建立
  createInvite: (parentId, relationship = null) =>
    callApi(`/families/by-parent/${parentId}/invites`, { method: 'post', data: { relationship } },
      () => familyMock.createInvite(parentId, relationship)),
  revokeInvite: (familyId, inviteId) =>
    callApi(`/families/${familyId}/invites/${inviteId}/revoke`, { method: 'post' },
      () => familyMock.revokeInvite(familyId, inviteId)),
  // Z01 視窗的「添加成員」：這位家長還沒有家庭時，後端會先以他為擁有者建立（同一個交易）
  addMemberForParent: (parentId, { phone, name }) =>
    callApi(`/families/by-parent/${parentId}/members`, { method: 'post', data: { phone, name } },
      () => familyMock.addMemberForParent(parentId, { phone, name })),
  // phone 或 parent_id 擇一；已是成員但 LINE 換過 → 後端視為重新綁定
  addMember: (familyId, { phone, parentId, relationship }) =>
    callApi(`/families/${familyId}/members`, { method: 'post', data: { phone, parent_id: parentId, relationship } },
      () => familyMock.addMember(familyId, { phone, parentId, relationship })),
  setRelationship: (familyId, parentId, relationship) =>
    callApi(`/families/${familyId}/members/${parentId}`, { method: 'patch', data: { relationship } },
      () => familyMock.setRelationship(familyId, parentId, relationship)),
  // 解綁：清掉這位成員在家庭裡的 LINE userId（孩子、訂單不動）
  revokeMember: (familyId, parentId, reason) =>
    callApi(`/families/${familyId}/members/${parentId}/revoke`, { method: 'post', data: { reason } },
      () => familyMock.revoke(familyId, parentId)),
  transferOwner: (familyId, parentId) =>
    callApi(`/families/${familyId}/transfer-owner`, { method: 'post', data: { parent_id: parentId } },
      () => familyMock.transferOwner(familyId, parentId)),
  freeze: (familyId, frozen, reason) =>
    callApi(`/families/${familyId}/freeze`, { method: 'post', data: { frozen, reason } },
      () => familyMock.freeze(familyId, frozen)),
  addPending: (familyId, phone, relationship) =>
    callApi(`/families/${familyId}/pending-members`, { method: 'post', data: { phone, relationship } },
      () => familyMock.addPending(familyId, phone, relationship)),
  removePending: (familyId, pendingId) =>
    callApi(`/families/${familyId}/pending-members/${pendingId}/remove`, { method: 'post' },
      () => familyMock.removePending(familyId, pendingId)),
  suggestions: () =>
    callApi('/families/suggestions', {}, () => familyMock.suggestions()),
  applySuggestion: (body) =>
    callApi('/families/suggestions/apply', { method: 'post', data: body }, () => familyMock.applySuggestion(body)),
  requests: (status = 'pending') =>
    callApi(`/families/requests?status=${encodeURIComponent(status)}`, {}, () => familyMock.requests(status)),
  approveRequest: (id) =>
    callApi(`/families/requests/${id}/approve`, { method: 'post' }, () => familyMock.approve(id)),
  rejectRequest: (id, reason) =>
    callApi(`/families/requests/${id}/reject`, { method: 'post', data: { reason } }, () => familyMock.reject(id)),
};

// §9 重複學員處理計畫 → 櫃台看得懂的一句話。copies：{ [studentId]: '誰名下的那份' }
export function duplicatePlanText(plan, copies = {}) {
  if (!plan) return '沒有重複的學員資料';
  if (plan.action === 'deactivate') {
    return `核准後停用 ${copies[plan.studentId] || '重複的那份'}（沒有課程、也不是 Ragic 上的那份），保留 ${copies[plan.keepId] || '另一份'}`;
  }
  if (plan.action === 'keep_both') return '兩份都有課程或未對帳訂單：先都保留，不會搬課程，課程結束後再處理';
  if (plan.action === 'none') return '重複的那份已經停用';
  const reasons = {
    courses_on_non_ragic_copy: '課程掛在不是 Ragic 的那份，系統不自動停用，請人工確認',
    both_in_ragic: '兩份都在 Ragic 上，系統不自動停用，請人工確認',
    neither_in_ragic: '兩份都不在 Ragic 上，系統不自動停用，請人工確認',
  };
  return reasons[plan.reason] || '需要人工確認';
}
