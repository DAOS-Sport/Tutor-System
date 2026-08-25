import { callApi } from './client';

// F-A08 定價區（課程需求管理的分頁）。
// 場館互斥由後端的單一外鍵保證：勾選＝從原本那一頁搬過來，不會兩頁都有。
export const pricingZonesApi = {
  list:   ()            => callApi('/pricing-zones', {}, () => ({ zones: [], all_venues: [], unassigned_with_courses: [] })),
  create: (data)        => callApi('/pricing-zones', { method: 'post', data }, () => ({ id: 0, ...data })),
  update: (id, patch)   => callApi(`/pricing-zones/${id}`, { method: 'patch', data: patch }, () => ({ id, ...patch })),
  remove: (id)          => callApi(`/pricing-zones/${id}`, { method: 'delete' }, () => ({ ok: true })),
  setVenues: (id, venueIds) =>
    callApi(`/pricing-zones/${id}/venues`, { method: 'put', data: { venue_ids: venueIds } }, () => ({ ok: true })),
};
