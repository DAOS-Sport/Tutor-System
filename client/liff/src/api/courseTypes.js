import { callApi } from './client';

const FALLBACK = [
  { course_type: 1, label: '一對一', max_students: 1, is_active: true, sort_order: 1, base_price: 9000, title: '1 對 1 個別教學', body: '完全客製化進度，最高效率提升技術。', image_url: '' },
  { course_type: 2, label: '一對二', max_students: 2, is_active: true, sort_order: 2, base_price: 6000, title: '1 對 2 雙人班', body: '兩位學員共享教練，互相切磋學習。', image_url: '' },
  { course_type: 3, label: '一對三', max_students: 3, is_active: true, sort_order: 3, base_price: 4500, title: '1 對 3 小團班', body: '三位學員精緻小班，氣氛輕鬆活潑。', image_url: '' },
  { course_type: 4, label: '1對4~6', max_students: 6, is_active: true, sort_order: 4, base_price: 3000, title: '1 對 4-6 團體班', body: '多人團體課，依單人價計費、人數越多越划算。', image_url: '' },
];

export const courseTypesApi = {
  listActive: () => callApi('/courses/types', {}, () => FALLBACK),
};
