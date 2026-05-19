import { callApi } from './client';
import { mockDb } from './mock';

export const venuesApi = {
  list: () => callApi('/venues', {}, () => mockDb.venues()),
  update: (id, patch) =>
    callApi(`/venues/${id}`, { method: 'patch', data: patch }, () => mockDb.updateVenue(id, patch)),
  // Task #84：場館啟用 / 停用（admin only；同步寫 admin_venues + venues）
  toggleActive: (id, isActive) =>
    callApi(`/venues/${id}/active`, { method: 'patch', data: { is_active: !!isActive } },
      () => mockDb.updateVenue(id, { is_active: !!isActive })),
  // Task #54：兩階段同步
  syncDryRun: () =>
    callApi('/venues/sync-ragic', { method: 'post', data: {} }, () => ({
      skipped: true,
      reason: 'Mock 模式：無 Ragic 連線，目前所有場館已同步。',
      added: [], updated: [], removed: [],
    })),
  syncConfirm: (selections) =>
    callApi('/venues/sync-ragic', { method: 'post', data: { confirm: true, selections } }, () => ({
      confirmed: true, added: 0, updated: 0, removed: 0,
    })),
};
