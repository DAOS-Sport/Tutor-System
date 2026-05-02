import { callApi } from './client';
import { mockDb } from './mock';

// ── 教練端 ─────────────────────────────────
export const learnApi = {
  // 課前規劃
  getPlan: (periodId) =>
    callApi(`/learn/plans/${periodId}`, {}, () => mockDb.lessonPlan(periodId)),
  savePlan: (periodId, data) =>
    callApi(`/learn/plans/${periodId}`, { method: 'put', data }, () => mockDb.saveLessonPlan(periodId, data)),
  publishPlan: (periodId) =>
    callApi(`/learn/plans/${periodId}/publish`, { method: 'post' }, () => mockDb.publishLessonPlan(periodId)),

  // 授課記錄
  getRecord: (sessionId) =>
    callApi(`/learn/records/by-session/${sessionId}`, {}, () => mockDb.sessionRecord(sessionId)),
  saveRecord: (sessionId, data) =>
    callApi(`/learn/records/by-session/${sessionId}`, { method: 'put', data }, () => mockDb.saveSessionRecord(sessionId, data)),
  submitRecord: (sessionId) =>
    callApi(`/learn/records/by-session/${sessionId}/submit`, { method: 'post' }, () => mockDb.submitSessionRecord(sessionId)),
  copyPrev: (sessionId) =>
    callApi(`/learn/records/by-session/${sessionId}/copy-prev`, {}, () => mockDb.copyPrevRecord(sessionId)),
  versions: (sessionId) =>
    callApi(`/learn/records/by-session/${sessionId}/versions`, {}, () => []),

  // 標籤
  tags: () => callApi('/learn/tags', {}, () => mockDb.learnTags()),
  addPersonalTag: (data) =>
    callApi('/learn/personal-tags', { method: 'post', data }, () => ({ id: `pt_${Date.now()}`, ...data })),
  removePersonalTag: (id) =>
    callApi(`/learn/personal-tags/${id}`, { method: 'delete' }, () => ({ ok: true })),

  // 上傳（multipart）
  upload: (file) => {
    const fd = new FormData(); fd.append('file', file);
    return callApi('/learn/uploads', { method: 'post', data: fd, headers: { 'Content-Type': 'multipart/form-data' } },
      () => Promise.resolve({ url: URL.createObjectURL(file), mime: file.type, name: file.name, size: file.size }));
  },
};

// ── 家長端 ─────────────────────────────────
export const historyApi = {
  byPeriod: (periodId) =>
    callApi(`/learn/history/${periodId}`, {}, () => mockDb.learningHistory(periodId)),
};

// ── 期末評鑑 (家長端) ───────────────────────
export const evaluationsApi = {
  mine: () => callApi('/evaluations/mine', {}, () => mockDb.myEvaluations()),
  detail: (id) => callApi(`/evaluations/${id}`, {}, () => mockDb.evaluationDetail(id)),
  submit: (id, data) =>
    callApi(`/evaluations/${id}/submit`, { method: 'post', data }, () => mockDb.submitEvaluation(id, data)),
};
