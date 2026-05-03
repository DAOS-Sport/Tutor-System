import { callApi } from './client';

export const lessonsApi = {
  mine: () => callApi('/courses/lessons', {}, () => []),
};
