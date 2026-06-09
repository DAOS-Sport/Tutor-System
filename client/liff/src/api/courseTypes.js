import { callApi } from './client';

const FALLBACK = [
  { course_type: 1, label: '一對一', max_students: 1, is_active: true, sort_order: 1 },
  { course_type: 2, label: '一對二', max_students: 2, is_active: true, sort_order: 2 },
  { course_type: 3, label: '一對三', max_students: 3, is_active: true, sort_order: 3 },
  { course_type: 4, label: '1對4~6', max_students: 6, is_active: true, sort_order: 4 },
];

export const courseTypesApi = {
  listActive: () => callApi('/courses/types', {}, () => FALLBACK),
};
