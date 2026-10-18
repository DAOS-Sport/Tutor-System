'use strict';
const { createHash } = require('crypto');
const { normalizePhone, isCanonicalMobilePhone } = require('./identityNormalizer');
const REASON = 'REVIEWED_OPTIONAL_CONTACT_GAPS';
const text = value => String(value ?? '').trim();
function version(row) {
  // Include the complete source snapshot and conflict flags, never return its PII.
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}
function sourceFingerprint(row) {
  const parentKeys = ['raw_name','venue_raw','phone','identity_raw','gender_raw','email_raw','line_uid_raw','last_error_code','claim_state','canonical_parent_id'];
  const childKeys = ['source_row_key','name_raw','birth_date_raw','gender_raw','id_number_raw','student_code_raw','registered_phone_raw','classification','present_in_latest_payload'];
  return createHash('sha256').update(JSON.stringify({
    parent: parentKeys.map(k => row[k] ?? null),
    students: (row.students || []).map(s => childKeys.map(k => s[k] ?? null)).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })).digest('hex');
}
function classify(row) {
  if (row.status !== 'pending') return { eligible: false, reason: 'NOT_PENDING' };
  if (row.reason_code !== 'TRUE_LINE_UID_EMPTY' || row.claim_state !== 'UNRESOLVED'
      || row.last_error_code || row.canonical_parent_id || row.has_claim || row.has_link || row.has_tombstone) {
    return { eligible: false, reason: 'IDENTITY_REVIEW_REQUIRED' };
  }
  if (!isCanonicalMobilePhone(row.phone) || row.duplicate_phone) return { eligible: false, reason: 'PHONE_CONFLICT_OR_INVALID' };
  if (['raw_name', 'venue_raw', 'identity_raw', 'gender_raw', 'email_raw'].some(k => !text(row[k]))
      || row.venue_raw === '待補登' || /^[\d\s+()\-]+$/.test(row.raw_name)) return { eligible: false, reason: 'OTHER_PARENT_GAPS' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(row.email_raw))) return { eligible: false, reason: 'PARENT_EMAIL_FORMAT' };
  const students = row.students || [];
  if (!students.length || students.some(s => !text(s.name_raw) || !text(s.birth_date_raw)
      || s.classification !== 'VALID' || s.present_in_latest_payload === false
      || (!text(s.id_number_raw) && !text(s.student_code_raw)))) {
    return { eligible: false, reason: 'OTHER_STUDENT_GAPS' };
  }
  // Mirrors the existing Z03 required fields. This does not certify identity,
  // validate national IDs, create an account, or authorize access.
  if (students.some(s => text(s.registered_phone_raw) && !isCanonicalMobilePhone(s.registered_phone_raw))) {
    return { eligible: false, reason: 'INVALID_STUDENT_PHONE' };
  }
  const validBirth = value => {
    const m = text(value).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (!m) return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2])-1, Number(m[3])));
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth()+1 === Number(m[2])
      && d.getUTCDate() === Number(m[3]) && d.getTime() <= Date.now();
  };
  if (students.some(s => !validBirth(s.birth_date_raw))) return { eligible: false, reason: 'STUDENT_BIRTH_FORMAT' };
  if (text(row.line_uid_raw)) return { eligible: false, reason: 'UID_REQUIRES_CANONICAL_REVIEW' };
  return { eligible: true, reason: students.some(s => !text(s.registered_phone_raw)) ? 'UID_AND_STUDENT_PHONE_OPTIONAL' : 'UID_OPTIONAL' };
}
async function load(client, ids, lock = false) {
  const result = await client.query(`SELECT z.*,
    EXISTS(SELECT 1 FROM identity_claims c WHERE c.source_system='RAGIC' AND c.source_table='Z01' AND c.source_record_id=z.z01_ragic_record_id) AS has_claim,
    EXISTS(SELECT 1 FROM source_record_links l WHERE l.source_system='RAGIC' AND l.source_table='Z01' AND l.source_record_id=z.z01_ragic_record_id) AS has_link,
    EXISTS(SELECT 1 FROM ragic_z03_deleted_tombstones t WHERE t.z01_ragic_record_id=z.z01_ragic_record_id) AS has_tombstone
    FROM ragic_z03_records z WHERE ${ids ? 'z.id = ANY($1::bigint[])' : "z.status = 'pending'"} ORDER BY z.id${lock ? ' FOR UPDATE OF z' : ''}`, ids ? [ids] : []);
  const rows = result.rows;
  if (!rows.length) return [];
  const students = (await client.query('SELECT * FROM ragic_z03_students WHERE z03_record_id = ANY($1::bigint[]) ORDER BY z03_record_id, id' + (lock ? ' FOR UPDATE' : ''), [rows.map(r => r.id)])).rows;
  // Include all Z03 rows in uniqueness checking, not just the selected page.
  const phones = (await client.query('SELECT id, phone FROM ragic_z03_records')).rows;
  const counts = new Map();
  for (const r of phones) { const p = normalizePhone(r.phone); counts.set(p, (counts.get(p) || 0) + 1); }
  return rows.map(row => ({ ...row, duplicate_phone: (counts.get(normalizePhone(row.phone)) || 0) > 1,
    students: students.filter(s => String(s.z03_record_id) === String(row.id)) }));
}
function createArchiveService(pool) {
  return {
    async preview() {
      const rows = await load(pool);
      const candidates = [], excluded = {};
      for (const row of rows) {
        const check = classify(row);
        if (check.eligible) candidates.push({ id: String(row.id), version: version(row), reason: check.reason });
        else excluded[check.reason] = (excluded[check.reason] || 0) + 1;
      }
      return { reviewed: rows.length, candidates, excluded, policy: REASON };
    },
    async apply(items, actor) {
      if (!actor || !Array.isArray(items) || !items.length || items.length > 5000
          || items.some(i => !/^\d+$/.test(String(i?.id)) || !/^[a-f0-9]{64}$/.test(i?.version || ''))
          || new Set(items.map(i => String(i.id))).size !== items.length) {
        throw Object.assign(new Error('批次或操作者無效，請重新預覽'), { status: 400 });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const rows = await load(client, items.map(i => String(i.id)), true);
        if (rows.length !== items.length) throw Object.assign(new Error('資料已變更，請重新預覽'), { status: 409 });
        const changed = [], already = [];
        for (const row of rows) {
          if (row.status === 'resolved' && row.reason_code === REASON) { already.push(String(row.id)); continue; }
          const expected = items.find(i => String(i.id) === String(row.id));
          if (version(row) !== expected.version || !classify(row).eligible) throw Object.assign(new Error('資料或分類已變更，整批未套用，請重新預覽'), { status: 409 });
          changed.push(String(row.id));
        }
        if (changed.length) await client.query(`UPDATE ragic_z03_records SET status='resolved', reason_code=$2,
          resolved_by=$3, resolved_at=NOW() WHERE id = ANY($1::bigint[])`, [changed, REASON, actor]);
        await client.query('COMMIT');
        return { archived: changed, already_archived: already, policy: REASON, identity_activated: false };
      } catch (error) { await client.query('ROLLBACK'); if (error.code === '40001') error.status = 409; throw error; }
      finally { client.release(); }
    },
  };
}
module.exports = { createArchiveService, classify, version, sourceFingerprint, REASON };
