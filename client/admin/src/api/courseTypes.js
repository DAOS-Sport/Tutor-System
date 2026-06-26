import { callApi } from './client';
import { mockDb } from './mock';

export const courseTypesApi = {
  list:   ()           => callApi('/course-types', {}, () => mockDb.courseTypes()),
  create: (data)       => callApi('/course-types', { method: 'post', data }, () => mockDb.createCourseType(data)),
  update: (type, patch) => callApi(`/course-types/${type}`, { method: 'patch', data: patch }, () => mockDb.updateCourseType(type, patch)),
  remove: (type)       => callApi(`/course-types/${type}`, { method: 'delete' }, () => mockDb.deleteCourseType(type)),
  auditLogs: (type)    => callApi(`/course-types/${type}/audit-logs`, {}, () => []),
};
