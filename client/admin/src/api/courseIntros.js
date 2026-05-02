import { callApi } from './client';
import { mockDb } from './mock';

export const courseIntrosApi = {
  list: () => callApi('/course-intros', {}, () => mockDb.courseIntros()),
  update: (courseType, patch) =>
    callApi(`/course-intros/${courseType}`, { method: 'patch', data: patch }, () => mockDb.updateCourseIntro(courseType, patch)),
};
