import { callApi } from './client';

const FALLBACK = [
  { course_type: 1, label: '一對一', max_students: 1, is_active: true, sort_order: 1 },
  { course_type: 2, label: '一對二', max_students: 2, is_active: true, sort_order: 2 },
  { course_type: 3, label: '一對三', max_students: 3, is_active: true, sort_order: 3 },
];

export const courseTypesApi = {
  listActive: () => callApi('/courses/types', {}, () => FALLBACK),
};
