'use strict';

const crypto = require('crypto');
const { normalizePhone } = require('./identityNormalizer');
const { STABILITY_FLAGS } = require('../config/ragicSchema');

const INTERNAL_SOURCE_ALLOWLIST = Object.freeze(['149', '6504', '6786']);

function csv(name) {
  return String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function bucket(value) {
  return parseInt(sha256(value).slice(0, 8), 16) % 100;
}

function getParentIdentityCanaryConfig() {
  const phase = String(process.env.PARENT_IDENTITY_CANARY_PHASE || 'off').trim().toLowerCase();
  const percent = Math.max(0, Math.min(100, Number(process.env.PARENT_IDENTITY_CANARY_PERCENT) || 0));
  return {
    enabled: STABILITY_FLAGS.PARENT_IDENTITY_RESOLVER_V2 && phase !== 'off',
    phase,
    percent,
    lineUidHashes: new Set(csv('PARENT_IDENTITY_CANARY_LINE_UID_HASHES')),
    phones: new Set(csv('PARENT_IDENTITY_CANARY_PHONES').map(normalizePhone)),
    sourceRecordIds: new Set([...INTERNAL_SOURCE_ALLOWLIST, ...csv('PARENT_IDENTITY_CANARY_SOURCE_RECORD_IDS')]),
  };
}

function evaluateParentIdentityCanary({ lineUid, phone, sourceRecordIds = [], existingLocalLineUidFound = false } = {}) {
  if (existingLocalLineUidFound) {
    return { allowed: false, reason: 'EXISTING_USER_FAST_PATH_EXCLUDED', phase: 'fastpath' };
  }
  const config = getParentIdentityCanaryConfig();
  if (!config.enabled) return { allowed: false, reason: 'RESOLVER_V2_DISABLED', phase: config.phase };
  const uidHash = sha256(lineUid);
  const canonicalPhone = normalizePhone(phone);
  const sourceMatch = sourceRecordIds.some((id) => config.sourceRecordIds.has(String(id)));
  if (config.phase === 'allowlist') {
    const allowed = config.lineUidHashes.has(uidHash) || config.phones.has(canonicalPhone) || sourceMatch;
    return { allowed, reason: allowed ? 'ALLOWLIST_MATCH' : 'ALLOWLIST_MISS', phase: config.phase };
  }
  if (config.phase === 'percentage') {
    const userBucket = bucket(lineUid || canonicalPhone);
    return {
      allowed: userBucket < config.percent,
      reason: userBucket < config.percent ? 'PERCENTAGE_MATCH' : 'PERCENTAGE_MISS',
      phase: config.phase,
      bucket: userBucket,
      percent: config.percent,
    };
  }
  return { allowed: false, reason: 'INVALID_CANARY_PHASE', phase: config.phase };
}

module.exports = {
  INTERNAL_SOURCE_ALLOWLIST,
  getParentIdentityCanaryConfig,
  evaluateParentIdentityCanary,
  __test__: { sha256, bucket },
};
