'use strict';

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addMonths(value, count) {
  const [year, month, day] = value.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + count, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function normalizeSessionDateRange(selectedFrom, selectedTo) {
  if (!validDate(selectedFrom) || !validDate(selectedTo)) return null;
  if (selectedTo < addMonths(selectedFrom, -3) || selectedTo > addMonths(selectedFrom, 3)) return null;
  const [from, to] = [selectedFrom, selectedTo].sort();
  return { from, to };
}

module.exports = { normalizeSessionDateRange };
