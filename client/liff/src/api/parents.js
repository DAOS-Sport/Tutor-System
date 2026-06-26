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
  // 家長端不提供停用/刪除（移除/轉出請洽櫃台，由 Ragic 端處理）。
  // 開啟 webApp / 進個資頁時主動向 Ragic 同步（後端節流；失敗保留既有鏡像）。
  sync: () =>
    callApi('/parents/me/sync', { method: 'post' }, () => mockDb.me()),
};
