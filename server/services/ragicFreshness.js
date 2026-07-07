const DEFAULT_CANARY_ID = 'ZZ-CANARY';

function _env(env, key, fallback = '') {
  const v = env[key];
  return v == null ? fallback : String(v).trim();
}

function _num(env, key, fallback) {
  const n = Number(env[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function _bool(env, key, fallback = false) {
  const v = env[key];
  if (v == null || v === '') return fallback;
  return !/^(0|false|no)$/i.test(String(v).trim());
}

function getCanaryConfig(sheetCode, env = process.env) {
  const code = String(sheetCode || '').trim().toUpperCase();
  if (!code) throw new Error('sheetCode is required for Ragic canary');
  const prefix = `RAGIC_CANARY_${code}`;
  const recordId = _env(env, `${prefix}_RECORD_ID`);
  const nonceField =
    _env(env, `${prefix}_NONCE_FIELD_ID`) ||
    _env(env, `${prefix}_FIELD_ID`) ||
    _env(env, 'RAGIC_CANARY_NONCE_FIELD_ID') ||
    _env(env, 'RAGIC_CANARY_FIELD_ID');
  const nonceFieldName =
    _env(env, `${prefix}_NONCE_FIELD_NAME`) ||
    _env(env, 'RAGIC_CANARY_NONCE_FIELD_NAME') ||
    'canary_nonce';
  const identifierField =
    _env(env, `${prefix}_IDENTIFIER_FIELD_ID`) ||
    _env(env, `${prefix}_IDENT_FIELD_ID`) ||
    _env(env, 'RAGIC_CANARY_IDENTIFIER_FIELD_ID') ||
    _env(env, 'RAGIC_CANARY_IDENT_FIELD_ID');
  const identifierFieldName =
    _env(env, `${prefix}_IDENTIFIER_FIELD_NAME`) ||
    _env(env, `${prefix}_IDENT_FIELD_NAME`) ||
    _env(env, 'RAGIC_CANARY_IDENTIFIER_FIELD_NAME') ||
    _env(env, 'RAGIC_CANARY_IDENT_FIELD_NAME');
  const identifierValue =
    _env(env, `${prefix}_IDENTIFIER_VALUE`) ||
    _env(env, `${prefix}_IDENT_VALUE`) ||
    _env(env, 'RAGIC_CANARY_IDENTIFIER_VALUE') ||
    _env(env, 'RAGIC_CANARY_IDENT_VALUE') ||
    DEFAULT_CANARY_ID;

  return {
    sheetCode: code,
    recordId,
    nonceField,
    nonceFieldName,
    identifierField,
    identifierFieldName,
    identifierValue,
    maxRetries: _num(env, 'RAGIC_FRESHNESS_RETRIES', 5),
    backoffMs: _num(env, 'RAGIC_FRESHNESS_BACKOFF_MS', 1000),
    // 預設 false：canary 未設定時退化為直接 fetch，不硬擋 sync；
    // 正式啟用 canary 防護請設 RAGIC_FRESHNESS_REQUIRE_CANARY=1。
    requireConfigured: _bool(env, 'RAGIC_FRESHNESS_REQUIRE_CANARY', false),
  };
}

function assertCanaryConfigured(config) {
  if (!config.recordId || !config.nonceField) {
    const err = new Error(
      `Ragic ${config.sheetCode} canary 未設定完整：需要 RAGIC_CANARY_${config.sheetCode}_RECORD_ID 與 RAGIC_CANARY_${config.sheetCode}_NONCE_FIELD_ID`
    );
    err.code = 'RAGIC_CANARY_NOT_CONFIGURED';
    throw err;
  }
}

function makeRunId(prefix = 'ragic') {
  return `${prefix}-${new Date().toISOString()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeNonce({ runId, sheetCode, now = new Date() }) {
  return `${runId}:${String(sheetCode || '').toUpperCase()}:${now.toISOString()}`;
}

function _readField(record, keys) {
  if (!record || typeof record !== 'object') return '';
  for (const key of keys.filter(Boolean)) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function getRecordId(record) {
  if (!record || typeof record !== 'object') return '';
  return String(record._ragicId || record.ragicId || record._id || '').trim();
}

function getCanaryNonce(record, config) {
  return _readField(record, [
    config.nonceField,
    config.nonceFieldName,
    'canary_nonce',
    'Canary Nonce',
    'CANARY_NONCE',
  ]);
}

function isCanaryRecord(record, sheetCode, env = process.env) {
  const config = typeof sheetCode === 'object' ? sheetCode : getCanaryConfig(sheetCode, env);
  if (!record || typeof record !== 'object') return false;
  const recordId = getRecordId(record);
  if (config.recordId && recordId && String(recordId) === String(config.recordId)) return true;
  const ident = _readField(record, [
    config.identifierField,
    config.identifierFieldName,
    'canary_id',
    'Canary ID',
    '編號',
    '員工編號',
    '學員編號',
    '部門編號',
    '場館代號',
  ]);
  return Boolean(ident && config.identifierValue && ident === config.identifierValue);
}

function filterCanaryRecords(records, sheetCode, env = process.env) {
  const config = typeof sheetCode === 'object' ? sheetCode : getCanaryConfig(sheetCode, env);
  return (records || []).filter((record) => !isCanaryRecord(record, config));
}

function _recordsFromSnapshot(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (snapshot && Array.isArray(snapshot.records)) return snapshot.records;
  if (snapshot && Array.isArray(snapshot.items)) return snapshot.items;
  return [];
}

function verifySnapshotNonce(snapshot, config, expectedNonce) {
  const records = _recordsFromSnapshot(snapshot);
  const canary = records.find((record) => isCanaryRecord(record, config));
  const observed = canary ? getCanaryNonce(canary, config) : '';
  return {
    ok: Boolean(canary && observed === expectedNonce),
    found: Boolean(canary),
    expected: expectedNonce,
    observed,
    canaryRecordId: canary ? getRecordId(canary) : '',
  };
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCanaryWriteReadProof({
  sheetCode,
  runId = makeRunId('ragic'),
  config = getCanaryConfig(sheetCode),
  writeNonce,
  fetchSnapshot,
  fetchCanary,
  sleep = _sleep,
  now = () => new Date(),
  nowMs = () => Date.now(),
}) {
  // canary 未設定且不強制要求時，退化為直接 fetch（不做 write-read proof）。
  if (!config.recordId || !config.nonceField) {
    if (config.requireConfigured) {
      assertCanaryConfigured(config); // 仍會 throw，語意不變
    }
    console.warn(
      `[ragicFreshness] ${config.sheetCode} canary 未設定，略過 write-read proof，直接 fetch snapshot。` +
      `如需 freshness 保護請設 RAGIC_CANARY_${config.sheetCode}_RECORD_ID / _NONCE_FIELD_ID 與 RAGIC_FRESHNESS_REQUIRE_CANARY=1`
    );
    const snapshot = await fetchSnapshot({ attempt: 0, noCache: true });
    const records = _recordsFromSnapshot(snapshot);
    return {
      stale_read: false,
      snapshot,
      raw_records: records,
      records,
      freshness: {
        freshness_verified: false,
        freshness_latency_ms: 0,
        stale_retries: 0,
        canary_nonce: '',
        canary_record_id: '',
        observed_nonce: '',
        canary_found_in_snapshot: false,
        canary_found_by_single_get: null,
        canary_skipped: true,
      },
    };
  }
  if (typeof writeNonce !== 'function') throw new Error('writeNonce function is required');
  if (typeof fetchSnapshot !== 'function') throw new Error('fetchSnapshot function is required');
  if (typeof fetchCanary !== 'function') throw new Error('fetchCanary function is required');

  const nonce = makeNonce({ runId, sheetCode: config.sheetCode, now: now() });
  const started = nowMs();
  await writeNonce(nonce, config);

  let retries = 0;
  let snapshot = await fetchSnapshot({ attempt: 0, noCache: false, nonce });
  let check = verifySnapshotNonce(snapshot, config, nonce);
  let singleCheck = null;

  while (!check.ok && retries < config.maxRetries) {
    retries += 1;
    const canaryRecord = await fetchCanary({
      attempt: retries,
      noCache: true,
      nonce,
      cacheBuster: `${nowMs()}-${retries}`,
    });
    singleCheck = verifySnapshotNonce([canaryRecord].filter(Boolean), config, nonce);
    const waitMs = config.backoffMs * Math.max(1, 2 ** (retries - 1));
    if (waitMs > 0) await sleep(waitMs);
    snapshot = await fetchSnapshot({
      attempt: retries,
      noCache: true,
      nonce,
      cacheBuster: `${nowMs()}-${retries}`,
      singleCanaryMatched: singleCheck.ok,
    });
    check = verifySnapshotNonce(snapshot, config, nonce);
  }

  const latencyMs = Math.max(0, nowMs() - started);
  const baseFreshness = {
    freshness_verified: check.ok,
    freshness_latency_ms: latencyMs,
    stale_retries: retries,
    canary_nonce: nonce,
    canary_record_id: config.recordId,
    observed_nonce: check.observed || '',
    canary_found_in_snapshot: check.found,
    canary_found_by_single_get: singleCheck ? singleCheck.ok : null,
  };

  if (!check.ok) {
    const rawRecords = _recordsFromSnapshot(snapshot);
    return {
      stale_read: true,
      snapshot,
      raw_records: rawRecords,
      records: [],
      freshness: baseFreshness,
      error: `stale_read: ${config.sheetCode} canary nonce 不一致（expected=${nonce}, observed=${check.observed || '(missing)'}, retries=${retries}）`,
    };
  }

  const rawRecords = _recordsFromSnapshot(snapshot);
  return {
    stale_read: false,
    snapshot,
    raw_records: rawRecords,
    records: filterCanaryRecords(rawRecords, config),
    freshness: baseFreshness,
  };
}

module.exports = {
  DEFAULT_CANARY_ID,
  getCanaryConfig,
  assertCanaryConfigured,
  makeRunId,
  makeNonce,
  getRecordId,
  getCanaryNonce,
  isCanaryRecord,
  filterCanaryRecords,
  verifySnapshotNonce,
  runCanaryWriteReadProof,
};
