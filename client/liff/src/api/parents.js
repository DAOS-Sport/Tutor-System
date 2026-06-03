import { callApi } from './client';
import { mockDb } from './mock';

export const parentsApi = {
  create: (data) =>
    callApi('/parents', { method: 'post', data }, () => mockDb.createParent(data)),
  me: () =>
    callApi('/parents/me', {}, () => mockDb.me()),
  updateMe: (data) =>
    callApi('/parents/me', { method: 'patch', data }, () => mockDb.updateMe(data)),
  createStudent: (data) =>
    callApi('/parents/me/students', { method: 'post', data }, () => mockDb.createStudent(data)),
  updateStudent: (id, data) =>
    callApi(`/parents/me/students/${id}`, { method: 'patch', data }, () => mockDb.updateStudent(id, data)),
  deleteStudent: (id) =>
    callApi(`/parents/me/students/${id}`, { method: 'delete' }, () => mockDb.deleteStudent(id)),
};
