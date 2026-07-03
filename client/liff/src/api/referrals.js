import { callApi } from './client';

// MGM 推薦連結 — mock 模式直接回 stub（純前端開發時不會真的串）
const _mockToken = () => Math.random().toString(36).slice(2, 12);

export const referralsApi = {
  create: (coachId) =>
    callApi('/referrals', { method: 'post', data: { coach_id: coachId } }, () => {
      const tk = _mockToken();
      return { id: `mock-${tk}`, token: tk, url: `${location.origin}/r/${tk}` };
    }),
  byToken: (token) =>
    callApi(`/referrals/by-token/${encodeURIComponent(token)}`, { skipAuthRedirect: true }, () => null),
  mine: () =>
    callApi('/referrals/mine', {}, () => []),
};
