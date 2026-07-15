const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatPlainDate,
  formatRagicDate,
  taipeiToday,
  addCalendarDays,
  taipeiWeekStart,
  formatTaipeiDateTime,
} = require('../utils/dateTime');

test('plain DATE strings never cross a UTC boundary', () => {
  assert.equal(formatPlainDate('2016-12-25'), '2016-12-25');
  assert.equal(formatPlainDate('2016/12/16'), '2016-12-16');
  assert.equal(formatRagicDate('2016-12-25'), '2016/12/25');
});

test('Date representing Taipei midnight keeps the Taipei calendar date', () => {
  const taipeiMidnight = new Date('2016-12-24T16:00:00.000Z');
  assert.equal(formatPlainDate(taipeiMidnight), '2016-12-25');
  assert.equal(formatRagicDate(taipeiMidnight), '2016/12/25');
});

test('Taipei business date boundaries are stable', () => {
  assert.equal(taipeiToday(new Date('2026-07-15T15:59:59Z')), '2026-07-15');
  assert.equal(taipeiToday(new Date('2026-07-15T16:00:00Z')), '2026-07-16');
  assert.equal(taipeiToday(new Date('2026-07-15T16:01:00Z')), '2026-07-16');
  assert.equal(formatTaipeiDateTime(new Date('2026-07-15T16:01:00Z')), '2026/07/16 00:01');
});

test('Taipei calendar arithmetic ignores host timezone and month boundaries', () => {
  assert.equal(addCalendarDays('2026-07-31', 1), '2026-08-01');
  assert.equal(addCalendarDays('2026-03-01', -1), '2026-02-28');
  assert.equal(taipeiWeekStart(new Date('2026-07-15T16:01:00Z')), '2026-07-12');
});
