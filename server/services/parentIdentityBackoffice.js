'use strict';

const crypto = require('crypto');
const { pool } = require('../models/db');
const { maskName, maskPhone } = require('../utils/piiMask');

async function createParentIdentityBackofficeTask({
  client = pool,
  parent = null,
  phone = '',
  sourceRecordIds = [],
  reasonCode,
  suggestedAction,
  correlationId = crypto.randomUUID(),
  rightsProtectionStatus = 'NO_RIGHTS_MUTATION',
} = {}) {
  if (!reasonCode || !suggestedAction) throw new Error('back-office task reason/action required');
  const sources = [...new Set((sourceRecordIds || []).map(String).filter(Boolean))];
  const maskedParent = {
    name: maskName(parent?.name || ''),
    phone: maskPhone(parent?.phone || phone || ''),
  };
  return (await client.query(
    `INSERT INTO parent_identity_backoffice_tasks
       (canonical_parent_id,masked_parent,source_record_ids,reason_code,suggested_action,
        correlation_id,rights_protection_status)
     VALUES ($1,$2::jsonb,$3::text[],$4,$5,$6,$7)
     ON CONFLICT (correlation_id,reason_code) DO UPDATE SET
       source_record_ids=EXCLUDED.source_record_ids,
       suggested_action=EXCLUDED.suggested_action,
       rights_protection_status=EXCLUDED.rights_protection_status,
       updated_at=NOW()
     RETURNING *`,
    [parent?.id || null, JSON.stringify(maskedParent), sources, reasonCode,
      suggestedAction, correlationId, rightsProtectionStatus]
  )).rows[0];
}

module.exports = { createParentIdentityBackofficeTask };
