'use strict';

/**
 * Canonical identity normalization shared by Ragic ingestion and Z03 claims.
 *
 * These helpers only normalize exact-match keys. They deliberately do not do
 * fuzzy matching, transliteration, surname guessing, or national-id matching.
 */
function normalizePhone(value) {
  const raw = String(value || '').normalize('NFKC').trim();
  if (!raw) return '';

  const compact = raw.replace(/[\s\-()]/g, '');
  const digits = compact.replace(/\D/g, '');
  if (compact.startsWith('+886')) return `0${digits.slice(3)}`;
  if (digits.startsWith('886') && digits.length >= 11) return `0${digits.slice(3)}`;
  return digits;
}

function normalizeStudentName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

module.exports = {
  normalizePhone,
  normalizeStudentName,
};
