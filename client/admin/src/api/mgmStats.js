import { callApi } from './client';

export const mgmStatsApi = {
  query: (params = {}) =>
    callApi('/admin/mgm-stats', { params }, () => ({
      total: 0,
      byStatus: { pending: 0, registered: 0, trial_paid: 0, checked_in: 0, reward_issued: 0 },
      conversionRate: 0,
      coachRanking: [],
    })),
};
