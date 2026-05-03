import { callApi } from './client';

export const lessonsApi = {
  mine: (params = {}) => callApi('/courses/lessons', { params }, () => []),
};
