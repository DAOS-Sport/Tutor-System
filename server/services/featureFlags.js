const { pool } = require('../models/db');

const ENV_ALL = new Set(['1', 'true', 'all', '*']);

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

async function getFeatureFlag(key, db = pool) {
  const env = String(process.env[key] || '').trim();
  if (env) {
    if (ENV_ALL.has(env.toLowerCase())) return { key, enabled: true, allowedPhones: [] };
    if (['0', 'false', 'off'].includes(env.toLowerCase())) return { key, enabled: false, allowedPhones: [] };
    return {
      key,
      enabled: true,
      allowedPhones: env.split(',').map(normalizePhone).filter(Boolean),
    };
  }
  const r = await db.query(
    `SELECT enabled, allowed_phones FROM application_feature_flags WHERE key = $1`,
    [key]
  );
  const row = r.rows[0];
  return {
    key,
    enabled: !!row?.enabled,
    allowedPhones: (row?.allowed_phones || []).map(normalizePhone).filter(Boolean),
  };
}

function flagAllowsPhone(flag, phone) {
  if (!flag?.enabled) return false;
  if (!flag.allowedPhones?.length) return true;
  return flag.allowedPhones.includes(normalizePhone(phone));
}

module.exports = { getFeatureFlag, flagAllowsPhone, normalizePhone };
