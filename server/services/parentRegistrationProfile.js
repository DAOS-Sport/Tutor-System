'use strict';

const crypto = require('crypto');
const ragic = require('./ragic');
const { normalizePhone } = require('./identityNormalizer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TW_MOBILE_RE = /^09\d{8}$/;

const PROFILE_PATCH_ALLOWLIST = Object.freeze(new Set([
  ragic.FIELD.Z01.PARENT_NAME,
  ragic.FIELD.Z01.EMAIL,
  ragic.FIELD.Z01.PHONE,
  ragic.FIELD.Z01.HOME_PHONE,
  ragic.FIELD.Z01.HOME_ADDRESS,
  ragic.FIELD.Z01.LINE_ID,
  ragic.FIELD.Z01.LINE_UID,
]));

function _text(value, max = 500) {
  return String(value == null ? '' : value).normalize('NFKC').trim().slice(0, max);
}

function _hash(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function _validEmail(value) {
  const email = _text(value, 255);
  return email && EMAIL_RE.test(email) ? email : '';
}

function _validMobile(value) {
  const phone = normalizePhone(value);
  return TW_MOBILE_RE.test(phone) ? phone : '';
}

function _candidate({ oldValue, newValue, fieldId, ownershipVerified, contact = false }) {
  const oldText = _text(oldValue);
  const newText = _text(newValue);
  if (!newText || oldText === newText) return null;
  if (oldText && !(contact && ownershipVerified)) return null;
  return {
    field_id: fieldId,
    old_value: oldText,
    new_value: newText,
    change_reason: oldText ? 'VERIFIED_CONTACT_UPDATE' : 'FILL_BLANK',
    ownership_verified: Boolean(oldText && contact && ownershipVerified),
  };
}

/**
 * Build a numeric-Field-ID-only Z01 patch. Source values must already be read
 * from the immutable source record; LINE UID must come from field 1006846.
 */
function buildParentProfilePatch({
  sourceProfile = {},
  parentInput = {},
  lineUid,
  ownershipVerified = false,
  includeUid = true,
} = {}) {
  const patch = {};
  const changes = [];
  const add = (change) => {
    if (!change || !PROFILE_PATCH_ALLOWLIST.has(change.field_id)) return;
    patch[change.field_id] = change.new_value;
    changes.push(change);
  };

  add(_candidate({
    oldValue: sourceProfile.name,
    newValue: _text(parentInput.name, 120),
    fieldId: ragic.FIELD.Z01.PARENT_NAME,
    ownershipVerified,
  }));
  add(_candidate({
    oldValue: sourceProfile.email,
    newValue: _validEmail(parentInput.email),
    fieldId: ragic.FIELD.Z01.EMAIL,
    ownershipVerified,
    contact: true,
  }));
  add(_candidate({
    oldValue: _validMobile(sourceProfile.phone),
    newValue: _validMobile(parentInput.phone),
    fieldId: ragic.FIELD.Z01.PHONE,
    ownershipVerified,
    contact: true,
  }));
  for (const [inputKey, sourceKey, fieldId] of [
    ['home_phone', 'home_phone', ragic.FIELD.Z01.HOME_PHONE],
    ['home_address', 'home_address', ragic.FIELD.Z01.HOME_ADDRESS],
    ['line_id', 'line_id', ragic.FIELD.Z01.LINE_ID],
  ]) {
    add(_candidate({
      oldValue: sourceProfile[sourceKey],
      newValue: _text(parentInput[inputKey]),
      fieldId,
      ownershipVerified,
      contact: true,
    }));
  }

  const currentUid = _text(sourceProfile.line_uid, 200);
  const nextUid = _text(lineUid, 200);
  if (currentUid && nextUid && currentUid !== nextUid) {
    const err = new Error('Ragic source field 1006846 is already bound to another account');
    err.code = 'ACCOUNT_RECOVERY_REQUIRED';
    throw err;
  }
  if (includeUid && !currentUid && nextUid) {
    add({
      field_id: ragic.FIELD.Z01.LINE_UID,
      old_value: '',
      new_value: nextUid,
      change_reason: 'FILL_BLANK',
      ownership_verified: true,
    });
  }
  return { patch, changes };
}

function sanitizeAllowlistedProfilePatch(value) {
  const out = {};
  for (const [fieldId, fieldValue] of Object.entries(value || {})) {
    if (!PROFILE_PATCH_ALLOWLIST.has(String(fieldId))) continue;
    const clean = _text(fieldValue);
    if (clean) out[String(fieldId)] = clean;
  }
  return out;
}

async function insertProfilePatchAudit(client, {
  parentId,
  sourceRecordId,
  changes = [],
  correlationId,
  actor = 'parent-registration',
} = {}) {
  for (const change of changes) {
    // UID binding already has identity_claim_events + outbox audit. This table
    // is reserved for first-party profile/contact completion.
    if (String(change.field_id) === String(ragic.FIELD.Z01.LINE_UID)) continue;
    await client.query(
      `INSERT INTO parent_profile_patch_audit
         (canonical_parent_id,source_system,source_table,source_record_id,field_id,
          old_value_hash,new_value_hash,change_reason,ownership_verified,actor,correlation_id)
       VALUES ($1,'RAGIC','Z01',$2,$3,$4,$5,$6,$7,$8,$9)`,
      [parentId, String(sourceRecordId), String(change.field_id),
       change.old_value ? _hash(change.old_value) : null, _hash(change.new_value),
       change.change_reason, Boolean(change.ownership_verified), actor, correlationId]
    );
  }
}

module.exports = {
  PROFILE_PATCH_ALLOWLIST,
  buildParentProfilePatch,
  sanitizeAllowlistedProfilePatch,
  insertProfilePatchAudit,
  __test__: { validEmail: _validEmail, validMobile: _validMobile, hash: _hash },
};
