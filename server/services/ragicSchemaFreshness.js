'use strict';

const crypto = require('crypto');
const { pool } = require('../models/db');
const ragic = require('./ragic');
const {
  RAGIC_Z01_FIELDS,
  RAGIC_Z01_FIELD_NAMES,
} = require('../config/ragicSchema');

const UID_FIELD_ID = RAGIC_Z01_FIELDS.PARENT_SYSTEM_LINE_UID;
const UID_FIELD_NAME = RAGIC_Z01_FIELD_NAMES.PARENT_SYSTEM_LINE_UID;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function schemaTtlMs() {
  const configured = Number(process.env.RAGIC_Z01_UID_SCHEMA_TTL_MS);
  return Number.isFinite(configured) && configured >= 60_000 ? configured : DEFAULT_TTL_MS;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function responseHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function optionalBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  return null;
}

function pickAttr(field, names) {
  const containers = [field, field?.attr, field?.attrs, field?.attributes].filter(Boolean);
  for (const container of containers) {
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(container, name)) return optionalBoolean(container[name]);
    }
  }
  return null;
}

function collectFields(definition) {
  const found = [];
  const root = definition && typeof definition === 'object' ? definition.fields : null;
  if (!root || typeof root !== 'object') return found;
  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith('fid') && value && typeof value === 'object') {
      found.push({ id: key.slice(3), value });
      continue;
    }
    if (key.startsWith('stid') && value && typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subKey.startsWith('fid') && subValue && typeof subValue === 'object') {
          found.push({ id: subKey.slice(3), value: subValue });
        }
      }
    }
  }
  return found;
}

function extractSchemaEvidence(definition) {
  const fields = collectFields(definition);
  const matches = fields.filter((entry) => String(entry.id) === UID_FIELD_ID);
  const field = matches.length === 1 ? matches[0].value : null;
  const fieldName = field ? String(field.name || '') : null;
  const attrNoDupRaw = field ? pickAttr(field, ['attr_noDup', 'listattr_noDup', 'noDup', 'no_dup', 'nodup', 'unique']) : null;
  const attrMustRaw = field ? pickAttr(field, ['attr_must', 'must', 'required', 'notNull']) : null;
  const attrRoRaw = field ? pickAttr(field, ['attr_ro', 'ro', 'readOnly', 'readonly']) : null;
  // Ragic boolean attributes are sparse: an absent attr_must/attr_ro means the
  // field is optional/editable. Preserve this normalized interpretation while
  // also retaining the exact field definition in schema_metadata below.
  const attrNoDup = attrNoDupRaw == null ? false : attrNoDupRaw;
  const attrMust = attrMustRaw == null ? false : attrMustRaw;
  const attrRo = attrRoRaw == null ? false : attrRoRaw;
  let failureCode = null;
  if (matches.length !== 1) failureCode = 'RAGIC_UID_FIELD_SCHEMA_MISMATCH';
  else if (fieldName !== UID_FIELD_NAME) failureCode = 'RAGIC_UID_FIELD_SCHEMA_MISMATCH';
  else if (attrNoDup !== true) failureCode = 'RAGIC_UID_FIELD_NOT_UNIQUE';
  else if (attrRo === true) failureCode = 'RAGIC_UID_FIELD_READ_ONLY';
  return {
    fieldId: UID_FIELD_ID,
    fieldName,
    attrNoDup,
    attrMust,
    attrRo,
    verified: !failureCode,
    failureCode,
    matchingFieldCount: matches.length,
  };
}

function sheetIdFromPath(sheetPath) {
  const clean = String(sheetPath || '').replace(/\/+$/, '');
  const match = clean.match(/\/([^/?#]+)$/);
  return match ? match[1] : null;
}

async function persistEvidence(db, evidence) {
  await db.query(
    `INSERT INTO ragic_z01_uid_schema_verifications
       (fetched_at,endpoint,sheet_path,sheet_id,http_status,response_hash,
        field_id,field_name,attr_no_dup,attr_must,attr_ro,schema_version,
        schema_metadata,correlation_id,verified,failure_code,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17)`,
    [evidence.fetched_at, evidence.endpoint, evidence.sheet_path, evidence.sheet_id,
     evidence.http_status, evidence.response_hash, evidence.field_id, evidence.field_name,
     evidence.attr_noDup, evidence.attr_must, evidence.attr_ro, evidence.schema_version,
     JSON.stringify(evidence.schema_metadata), evidence.correlation_id, evidence.verified,
     evidence.failure_code, evidence.expires_at]
  );
}

async function verifyRagicZ01UidSchemaFreshness({
  fetchDefinition = ragic.fetchZ01DefinitionFresh,
  db = pool,
  ttlMs = schemaTtlMs(),
  correlationId = crypto.randomUUID(),
  now = new Date(),
} = {}) {
  let fetched;
  try {
    fetched = await fetchDefinition({ correlationId });
  } catch (err) {
    const blocked = new Error('Ragic Z01 UID schema could not be freshly verified');
    blocked.code = 'RAGIC_SCHEMA_NOT_VERIFIED';
    blocked.cause = err;
    throw blocked;
  }
  const fetchedAt = new Date(fetched.fetchedAt || now);
  const definition = fetched.data;
  const extracted = extractSchemaEvidence(definition);
  const uidFieldDefinition = collectFields(definition)
    .find((entry) => String(entry.id) === UID_FIELD_ID)?.value || null;
  const responseMetadata = fetched.responseMetadata || {};
  const schemaVersion = definition?.version || definition?.schemaVersion
    || responseMetadata.ragic_version || null;
  const evidence = {
    fetched_at: fetchedAt,
    endpoint: String(fetched.endpoint || ''),
    sheet_path: String(fetched.sheetPath || process.env.RAGIC_FORM_Z01 || '').split('?')[0],
    sheet_id: sheetIdFromPath(fetched.sheetPath || process.env.RAGIC_FORM_Z01),
    http_status: Number(fetched.httpStatus || 0),
    response_hash: responseHash(definition),
    field_id: extracted.fieldId,
    field_name: extracted.fieldName,
    attr_noDup: extracted.attrNoDup,
    attr_must: extracted.attrMust,
    attr_ro: extracted.attrRo,
    schema_version: schemaVersion == null ? null : String(schemaVersion),
    schema_metadata: {
      ...responseMetadata,
      matching_field_count: extracted.matchingFieldCount,
      response_obtained_this_request: true,
      uid_field_definition: uidFieldDefinition,
    },
    correlation_id: correlationId,
    verified: extracted.verified && Number(fetched.httpStatus) >= 200 && Number(fetched.httpStatus) < 300,
    failure_code: extracted.failureCode,
    expires_at: new Date(fetchedAt.getTime() + ttlMs),
  };
  if (!evidence.verified && !evidence.failure_code) evidence.failure_code = 'RAGIC_SCHEMA_NOT_VERIFIED';
  try {
    await persistEvidence(db, evidence);
  } catch (err) {
    const blocked = new Error('Ragic schema evidence could not be persisted');
    blocked.code = 'RAGIC_SCHEMA_NOT_VERIFIED';
    blocked.cause = err;
    throw blocked;
  }
  return evidence;
}

async function getLatestRagicZ01UidSchemaEvidence({ db = pool } = {}) {
  const result = await db.query(
    `SELECT * FROM ragic_z01_uid_schema_verifications ORDER BY fetched_at DESC, created_at DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function assertRagicZ01UidSchemaFresh({ db = pool, now = new Date() } = {}) {
  const evidence = await getLatestRagicZ01UidSchemaEvidence({ db });
  const isFresh = evidence
    && evidence.verified === true
    && String(evidence.field_id) === UID_FIELD_ID
    && evidence.field_name === UID_FIELD_NAME
    && evidence.attr_no_dup === true
    && evidence.attr_ro === false
    && new Date(evidence.expires_at).getTime() > now.getTime();
  if (!isFresh) {
    const err = new Error('Ragic Z01 UID schema is missing, stale, or mismatched');
    err.code = 'RAGIC_SCHEMA_NOT_VERIFIED';
    err.evidence = evidence ? {
      fetched_at: evidence.fetched_at,
      expires_at: evidence.expires_at,
      failure_code: evidence.failure_code,
      response_hash: evidence.response_hash,
      correlation_id: evidence.correlation_id,
    } : null;
    throw err;
  }
  return evidence;
}

module.exports = {
  UID_FIELD_ID,
  UID_FIELD_NAME,
  schemaTtlMs,
  responseHash,
  extractSchemaEvidence,
  verifyRagicZ01UidSchemaFreshness,
  getLatestRagicZ01UidSchemaEvidence,
  assertRagicZ01UidSchemaFresh,
};
