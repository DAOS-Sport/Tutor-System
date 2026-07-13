const crypto = require('crypto');

const REQUEST_ID_MAX_LENGTH = 128;

function normalizeRequestId(value) {
  const normalized = String(value == null ? '' : value).trim();
  return normalized ? normalized.normalize('NFC') : '';
}

function validateRequestId(value) {
  const requestId = normalizeRequestId(value);
  if (!requestId) {
    return {
      error: '每次建單都必須提供 Idempotency-Key 或 request_id',
      code: 'REQUEST_ID_REQUIRED',
      status: 400,
    };
  }
  if (requestId.length > REQUEST_ID_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(requestId)) {
    return {
      error: `request ID 格式不正確（上限 ${REQUEST_ID_MAX_LENGTH} 字元）`,
      code: 'REQUEST_ID_INVALID',
      status: 400,
    };
  }
  return { requestId };
}

function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
}

function payloadFingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

async function acquireRequestLock(client, { actorId, operation, requestId }) {
  // PostgreSQL 的 two-int advisory lock 讓同 actor + operation + request ID 的
  // 請求序列化。lock 是 transaction scoped，不會因 error 遺留到下一個請求。
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [`${operation}:${actorId}`, requestId],
  );
}

module.exports = {
  REQUEST_ID_MAX_LENGTH,
  normalizeRequestId,
  validateRequestId,
  payloadFingerprint,
  acquireRequestLock,
};
