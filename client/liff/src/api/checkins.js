import { callApi } from './client';

export const checkinsApi = {
  // 家長自助簽到：POST /api/checkins { sessionId, studentId }
  //   後端驗證學員屬於本家長、在課程名單中、且課程為 confirmed/completed。
  //   回傳 { ok, checkin_id, checked_in_at, source }；重複簽到回傳既有記錄（不報錯）。
  create: ({ sessionId, studentId }) =>
    callApi('/checkins', { method: 'post', data: { sessionId, studentId } }, () => ({
      ok: true,
      checkin_id: `ck_${Date.now()}`,
      checked_in_at: new Date().toISOString(),
      source: 'parent',
    })),
};
