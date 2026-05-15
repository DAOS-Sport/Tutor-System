import { callApi } from './client';
import { mockDb } from './mock';

export const checkinsApi = {
  // Task #60：今日（或指定日期）已簽到名單
  list: ({ venueId, date } = {}) =>
    callApi('/checkins', { params: { venueId, date } }, () => mockDb.checkins({ venueId, date })),
};
