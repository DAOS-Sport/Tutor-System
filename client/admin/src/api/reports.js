import { callApi } from './client';

const empty = (extra = {}) => ({ from: '', to: '', rows: [], ...extra });

export const adminReportsApi = {
  revenue: (params) =>
    callApi('/reports/revenue', { params }, () => empty()),
  sessions: (params) =>
    callApi('/reports/sessions', { params }, () => empty()),
  discounts: (params) =>
    callApi('/reports/discounts', { params }, () => empty()),
  mgmConversion: (params) =>
    callApi('/reports/mgm-conversion', { params }, () => ({
      from: '', to: '',
      kpis: { total_links: 0, registered: 0, trial_paid: 0, checked_in: 0, rewarded: 0 },
      conversion: { register_rate: 0, trial_rate: 0, checkin_rate: 0, reward_rate: 0 },
    })),
  learningCompletion: (params) =>
    callApi('/reports/learning-completion', { params }, () => empty()),
};
