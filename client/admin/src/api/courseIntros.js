import { callApi } from './client';
import { mockDb } from './mock';

export const courseIntrosApi = {
  list: () => callApi('/course-intros', {}, () => mockDb.courseIntros()),
  update: (courseType, patch) =>
    callApi(`/course-intros/${courseType}`, { method: 'patch', data: patch }, () => mockDb.updateCourseIntro(courseType, patch)),

  uploadImage: (file) => {
    const form = new FormData();
    form.append('file', file);
    return callApi('/uploads/image', { method: 'post', data: form }, () => ({
      url: `/uploads/mock-intro-${Date.now()}.jpg`,
    }));
  },
};
