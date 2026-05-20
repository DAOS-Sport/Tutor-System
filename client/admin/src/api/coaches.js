/**
 * Task #91：F-C-Admin 教練資料已合併進員工帳號管理。
 * 此檔保留 thin shim，讓尚未升級的呼叫端能透過 staffApi 拿到等效資料；
 * 後端 /api/admin/coaches/* 已一律回 410 Gone。
 * 新功能請改用 staffApi（list/get/coachesByVenue/update）。
 */
import { staffApi } from './staff';

export const coachesApi = {
  list: (params = {}) =>
    staffApi.coachesByVenue(params.venueId, params.status || 'active'),
  get: (id) => staffApi.get(id),
  // 不再支援直接 update coaches；前端應呼叫 staffApi.update + coach_profile 區塊
  update: () => Promise.reject(new Error('coachesApi.update 已下架，請改用 staffApi.update + coach_profile')),
  syncRagic: () => Promise.resolve({ synced: 0, skipped: true, deprecated: true }),
};
