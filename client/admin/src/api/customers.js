import { callApi } from './client';
import { mockDb } from './mock';

function qs(params) {
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== '' && v != null) q.set(k, v);
  });
  const s = q.toString();
  return s ? `?${s}` : '';
}

// reveal：是否帶 ?reveal=1（後端據此回原值或遮罩，並寫稽核）
const rev = (reveal) => (reveal ? '?reveal=1' : '');

// Z01 家長 & 學員關係
export const customerParentsApi = {
  list: (params = {}) =>
    callApi(`/customer-parents${qs(params)}`, {}, () => mockDb.customerParents(params)),
  get: (id, reveal = false) =>
    callApi(`/customer-parents/${id}${rev(reveal)}`, {}, () => mockDb.customerParentDetail(id)),
  create: (body) =>
    callApi('/customer-parents', { method: 'post', data: body }, () => mockDb.createCustomerParent(body)),
  update: (id, patch) =>
    callApi(`/customer-parents/${id}`, { method: 'patch', data: patch }, () => mockDb.updateCustomerParent(id, patch)),
};

// Z02 學員資料（含購買紀錄）
export const customerStudentsApi = {
  list: (params = {}) =>
    callApi(`/customer-students${qs(params)}`, {}, () => mockDb.customerStudents(params)),
  get: (id, reveal = false) =>
    callApi(`/customer-students/${id}${rev(reveal)}`, {}, () => mockDb.customerStudentDetail(id)),
  update: (id, patch) =>
    callApi(`/customer-students/${id}`, { method: 'patch', data: patch }, () => mockDb.updateCustomerStudent(id, patch)),
  auditLogs: (id) =>
    callApi(`/customer-students/${id}/audit-logs`, {}, () => []),
};
