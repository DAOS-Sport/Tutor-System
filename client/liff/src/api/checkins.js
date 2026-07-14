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

  // U13 免預約自助簽到：POST /api/checkins/self { course_period_id, student_ids[] }
  //   限 checkin_mode='self' 的課程期；同一期每日限一次（伺服器硬保證，可安心重試）。
  //   回傳 { ok, session_id, checked_in_students, total_sessions, used_sessions, remaining_sessions }。
  selfCheckin: ({ coursePeriodId, studentIds }) =>
    callApi('/checkins/self', {
      method: 'post',
      data: { course_period_id: coursePeriodId, student_ids: studentIds },
    }, () => ({
      ok: true,
      session_id: `sess_${Date.now()}`,
      checked_in_students: [],
      total_sessions: 6,
      used_sessions: 1,
      remaining_sessions: 5,
    })),
};
