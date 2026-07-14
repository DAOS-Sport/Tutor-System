import { callApi } from './client';

// U13 雙軌簽到 — 課程期簽到模式管理（/checkin-modes 頁）
export const periodsApi = {
  // 進行中課程期清單（含模式、堂數使用、學員名單）
  checkinModes: ({ venueId, mode, search } = {}) =>
    callApi('/periods/checkin-modes', {
      params: {
        ...(venueId ? { venueId } : {}),
        ...(mode ? { mode } : {}),
        ...(search ? { search } : {}),
      },
    }, () => []),
  // 單期切換：mode = 'booking' | 'self'
  setCheckinMode: (periodId, mode) =>
    callApi(`/periods/${periodId}/checkin-mode`, { method: 'patch', data: { mode } },
      () => ({ id: periodId, checkin_mode: mode, changed: true })),
  // 整館批次切換（僅 active 期別）
  bulkCheckinMode: (venueId, mode) =>
    callApi('/periods/checkin-mode/bulk', { method: 'post', data: { venue_id: venueId, mode } },
      () => ({ venue_id: venueId, checkin_mode: mode, changed: 0 })),
};
