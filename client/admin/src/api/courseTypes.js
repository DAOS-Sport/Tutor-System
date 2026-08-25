import { callApi } from './client';
import { mockDb } from './mock';

// F-A08：每一支都要帶 zone（定價區）。分區之後「一對三的設定」這句話不完整，
// 少了區後端會回 400 ZONE_REQUIRED —— 那是刻意的，寧可壞得大聲也不要讀寫到別區。
export const courseTypesApi = {
  // 可以給 zone，也可以給 { venue }：呼叫端手上有的常常是場館而不是定價區編號。
  list:   (zoneOrOpts) => callApi('/course-types', {
    params: (zoneOrOpts && typeof zoneOrOpts === 'object') ? zoneOrOpts : { zone: zoneOrOpts },
  }, () => mockDb.courseTypes()),
  // 純選單用：跨定價區的課別清單，**不含價格**。促銷之類適用於全公司的設定用這支
  // —— 要它指定某一個定價區沒有意義，而拿到某一區的價格更是錯的。
  options: ()          => callApi('/course-types/options', {}, () => mockDb.courseTypes()),
  create: (zone, data) => callApi('/course-types', { method: 'post', data: { ...data, pricing_zone_id: zone } }, () => mockDb.createCourseType(data)),
  update: (zone, type, patch) => callApi(`/course-types/${type}`, { method: 'patch', data: { ...patch, pricing_zone_id: zone } }, () => mockDb.updateCourseType(type, patch)),
  remove: (zone, type) => callApi(`/course-types/${type}`, { method: 'delete', params: { zone } }, () => mockDb.deleteCourseType(type)),
  auditLogs: (zone, type) => callApi(`/course-types/${type}/audit-logs`, { params: { zone } }, () => []),
  // 加成級距清單（＝目前 active 教練的相異 pricing_multiplier），與促銷表單同源。
  coachMultipliers: () => callApi('/promotions/coach-multipliers', {}, () => []),
};
