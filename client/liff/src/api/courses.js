import { callApi } from './client';
import { mockDb } from './mock';

export const coursesApi = {
  basePrice: (courseType) =>
    callApi('/courses/base-price', { method: 'get', params: { courseType } }, () => ({
      course_type: courseType,
      original_price: mockDb.basePrice(courseType),
    })),

  myCourses: (parentId) =>
    callApi('/courses/mine', { method: 'get', params: { parentId } }, () => mockDb.myCourses(parentId)),
};
