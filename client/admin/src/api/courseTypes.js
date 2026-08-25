import { callApi } from './client';
import { mockDb } from './mock';

// F-A08：每一支都要帶 zone（定價區）。分區之後「一對三的設定」這句話不完整，
// 少了區後端會回 400 ZONE_REQUIRED —— 那是刻意的，寧可壞得大聲也不要讀寫到別區。
export const courseTypesApi = {
  list:   (zone)       => callApi('/course-types', { params: { zone } }, () => mockDb.courseTypes()),
  create: (zone, data) => callApi('/course-types', { method: 'post', data: { ...data, pricing_zone_id: zone } }, () => mockDb.createCourseType(data)),
  update: (zone, type, patch) => callApi(`/course-types/${type}`, { method: 'patch', data: { ...patch, pricing_zone_id: zone } }, () => mockDb.updateCourseType(type, patch)),
  remove: (zone, type) => callApi(`/course-types/${type}`, { method: 'delete', params: { zone } }, () => mockDb.deleteCourseType(type)),
  auditLogs: (zone, type) => callApi(`/course-types/${type}/audit-logs`, { params: { zone } }, () => []),
  // 加成級距清單（＝目前 active 教練的相異 pricing_multiplier），與促銷表單同源。
  coachMultipliers: () => callApi('/promotions/coach-multipliers', {}, () => []),
};
