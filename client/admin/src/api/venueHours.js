import { callApi } from './client';

// 模組 1：場館營業時間 + 特殊日期休館（自動時段產生的唯一時間來源）
export const venueHoursApi = {
  list: () => callApi('/venue-hours', {}, () => ({ hours: [], venues_without_hours: [] })),
  save: (venueId, hours) =>
    callApi(`/venue-hours/${venueId}`, { method: 'put', data: { hours } }, () => ({ ok: true, hours })),
  listClosed: (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, v); });
    const s = q.toString();
    return callApi(`/venue-hours/closed-dates${s ? `?${s}` : ''}`, {}, () => []);
  },
  addClosed: (body) =>
    callApi('/venue-hours/closed-dates', { method: 'post', data: body }, () => ({ ok: true })),
  removeClosed: (id) =>
    callApi(`/venue-hours/closed-dates/${id}`, { method: 'delete' }, () => ({ ok: true })),
};