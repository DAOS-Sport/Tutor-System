'use strict';

const { getTrueRagicLineUid } = require('../config/ragicSchema');

const INVALID_SOURCE_STATUSES = new Set(['MERGED', 'INVALID_SOURCE', 'ARCHIVED', 'SUPERSEDED']);
const ALIAS_METHODS = new Set(['MULTIPLE_SOURCE_ALIAS']);

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function oneWinner(sourceIds, priority, evidence = {}) {
  const ids = unique(sourceIds);
  return ids.length === 1
    ? { winnerSourceId: ids[0], priority, decision: 'WINNER', evidence }
    : null;
}

async function priority4StudentSourceEvidence(client, {
  sourceIds,
  familyById,
  exactMatches,
  canonicalParent,
  z01Links,
}) {
  const childIds = exactMatches.map((row) => row.id);
  const children = childIds.length ? (await client.query(
    `SELECT id,z03_record_id,source_row_key,canonical_student_id
       FROM ragic_z03_students WHERE id=ANY($1::bigint[])`, [childIds]
  )).rows : [];
  const rowKeys = unique(children.map((row) => row.source_row_key));
  const studentSourceIds = unique(sourceIds.flatMap((sourceId) => [
    sourceId,
    ...rowKeys.map((rowKey) => `${sourceId}:${rowKey}`),
    ...rowKeys,
  ]));
  const studentLinks = studentSourceIds.length ? (await client.query(
    `SELECT source_table,source_record_id,canonical_parent_id,canonical_student_id
       FROM source_record_links
      WHERE source_system='RAGIC'
        AND source_table IN ('Z01_STUDENT','Z03_STUDENT','Z02')
        AND source_record_id=ANY($1::text[])`, [studentSourceIds]
  )).rows : [];
  const localStudents = canonicalParent ? (await client.query(
    `SELECT id,ragic_record_id FROM students WHERE parent_id=$1 AND is_active=TRUE`,
    [canonicalParent.id]
  )).rows : [];

  const evidenceBySource = {};
  for (const sourceId of sourceIds) {
    const family = familyById.get(String(sourceId));
    const sourceChildren = children.filter((row) => String(row.z03_record_id) === String(family?.id));
    const sourceRowKeys = new Set(sourceChildren.map((row) => String(row.source_row_key || '')));
    const studentIds = [];
    for (const row of sourceChildren) {
      if (row.canonical_student_id) studentIds.push(row.canonical_student_id);
    }
    for (const link of z01Links) {
      if (String(link.source_record_id) === String(sourceId) && link.canonical_student_id) {
        studentIds.push(link.canonical_student_id);
      }
    }
    for (const link of studentLinks) {
      const recordId = String(link.source_record_id || '');
      const belongs = recordId === String(sourceId)
        || recordId.startsWith(`${sourceId}:`)
        || sourceRowKeys.has(recordId);
      if (belongs && link.canonical_student_id) studentIds.push(link.canonical_student_id);
    }
    for (const student of localStudents) {
      if (student.ragic_record_id && sourceRowKeys.has(String(student.ragic_record_id))) {
        studentIds.push(student.id);
      }
    }
    evidenceBySource[sourceId] = unique(studentIds);
  }

  const evidenced = sourceIds.filter((sourceId) => evidenceBySource[sourceId].length === 1);
  const conflicting = sourceIds.filter((sourceId) => evidenceBySource[sourceId].length > 1);
  if (conflicting.length) {
    return { decision: 'NO_DECISION', reason: 'CONFLICTING_STUDENT_SOURCE_EVIDENCE', evidenceBySource };
  }
  if (evidenced.length === 1) {
    return {
      decision: 'WINNER',
      winnerSourceId: String(evidenced[0]),
      canonicalStudentId: evidenceBySource[evidenced[0]][0],
      evidenceBySource,
    };
  }
  if (evidenced.length > 1) {
    const allStudents = unique(evidenced.flatMap((sourceId) => evidenceBySource[sourceId]));
    return {
      decision: 'NO_DECISION',
      reason: allStudents.length === 1
        ? 'MULTIPLE_SOURCES_ALIAS_SAME_CANONICAL_STUDENT'
        : 'MULTIPLE_STUDENT_SOURCE_EVIDENCE',
      canonicalStudentId: allStudents.length === 1 ? allStudents[0] : null,
      evidenceBySource,
    };
  }
  return { decision: 'NO_DECISION', reason: 'NO_STUDENT_SOURCE_EVIDENCE', evidenceBySource };
}

async function priority5RegistrationSourceEvidence(client, { sourceIds, canonicalParent }) {
  const discovered = (await client.query(
    `SELECT table_name,column_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name IN ('group_orders','group_order_members','admin_enrollments','source_record_links')`
  )).rows;
  const columns = discovered.reduce((acc, row) => {
    if (!acc[row.table_name]) acc[row.table_name] = [];
    acc[row.table_name].push(row.column_name);
    return acc;
  }, {});
  const sourceLinks = (await client.query(
    `SELECT source_record_id,enrollment_id,canonical_parent_id,canonical_student_id
       FROM source_record_links
      WHERE source_system='RAGIC' AND source_table='Z01'
        AND source_record_id=ANY($1::text[])`, [sourceIds]
  )).rows;
  const explicit = sourceLinks.filter((row) => row.enrollment_id);
  if (!explicit.length) {
    return {
      decision: 'NO_DECISION',
      reason: 'NO_EXPLICIT_Z01_REGISTRATION_REFERENCE',
      discoveredColumns: columns,
    };
  }
  const enrollmentIds = unique(explicit.map((row) => row.enrollment_id));
  const memberRows = columns.group_order_members?.includes('student_ids')
    ? (await client.query(
      `SELECT id,parent_id,student_ids FROM group_order_members WHERE id=ANY($1::uuid[])`, [enrollmentIds]
    )).rows
    : [];
  const memberById = new Map(memberRows.map((row) => [String(row.id), row]));
  const proven = explicit.filter((row) => {
    const member = memberById.get(String(row.enrollment_id));
    if (!member) return false;
    if (canonicalParent && String(member.parent_id) !== String(canonicalParent.id)) return false;
    if (row.canonical_parent_id && String(member.parent_id) !== String(row.canonical_parent_id)) return false;
    return !row.canonical_student_id
      || (member.student_ids || []).map(String).includes(String(row.canonical_student_id));
  });
  const winner = oneWinner(proven.map((row) => row.source_record_id), 5, {
    registrationIds: unique(proven.map((row) => row.enrollment_id)),
  });
  return winner || {
    decision: 'NO_DECISION',
    reason: proven.length ? 'MULTIPLE_REGISTRATION_SOURCE_EVIDENCE' : 'REGISTRATION_REFERENCE_NOT_CANONICAL',
    discoveredColumns: columns,
  };
}

async function priority6UniqueWritableBlankSource(client, { sourceIds, shadowBySource }) {
  const blank = sourceIds.filter((sourceId) => !getTrueRagicLineUid(shadowBySource.get(String(sourceId))?.raw_data));
  if (blank.length !== 1) {
    return { decision: 'NO_DECISION', reason: 'WRITABLE_BLANK_SOURCE_NOT_UNIQUE', blankSourceIds: blank };
  }
  const others = sourceIds.filter((sourceId) => String(sourceId) !== String(blank[0]));
  if (!others.length) return { decision: 'NO_DECISION', reason: 'NO_OTHER_SOURCE_TO_INVALIDATE' };
  const statuses = (await client.query(
    `SELECT source_record_id,status,reason,set_at
       FROM ragic_source_identity_status
      WHERE source_system='RAGIC' AND source_table='Z01'
        AND source_record_id=ANY($1::text[])`, [others]
  )).rows;
  const statusBySource = new Map(statuses.map((row) => [String(row.source_record_id), row]));
  const allInvalid = others.every((sourceId) => {
    const row = statusBySource.get(String(sourceId));
    return row && INVALID_SOURCE_STATUSES.has(row.status) && String(row.reason || '').trim() && row.set_at;
  });
  return allInvalid
    ? { decision: 'WINNER', winnerSourceId: String(blank[0]), statuses }
    : { decision: 'NO_DECISION', reason: 'OTHER_SOURCES_NOT_EXPLICITLY_INVALID', statuses };
}

async function resolveMultipleSourceCandidate(client, {
  matchedFamilies,
  exactMatches,
  canonicalParent,
  currentLineUid,
  maxPriority = 6,
}) {
  const sourceIds = unique(matchedFamilies.map((row) => row.z01_ragic_record_id));
  const familyById = new Map(matchedFamilies.map((row) => [String(row.z01_ragic_record_id), row]));
  const links = (await client.query(
    `SELECT source_record_id,canonical_parent_id,canonical_student_id,enrollment_id,link_method
       FROM source_record_links
      WHERE source_system='RAGIC' AND source_table='Z01'
        AND source_record_id=ANY($1::text[]) FOR UPDATE`, [sourceIds]
  )).rows;
  const primaryLinks = links.filter((row) => !ALIAS_METHODS.has(row.link_method)
    && (!canonicalParent || String(row.canonical_parent_id) === String(canonicalParent.id)));
  let winner = oneWinner(primaryLinks.map((row) => row.source_record_id), 1, { linkMethods: primaryLinks.map((row) => row.link_method) });
  if (winner) return winner;

  const shadows = (await client.query(
    `SELECT ragic_record_id,raw_data FROM ragic_z01_shadow
      WHERE ragic_record_id=ANY($1::text[])`, [sourceIds]
  )).rows;
  const shadowBySource = new Map(shadows.map((row) => [String(row.ragic_record_id), row]));
  winner = oneWinner(sourceIds.filter((sourceId) =>
    getTrueRagicLineUid(shadowBySource.get(String(sourceId))?.raw_data) === currentLineUid
  ), 2);
  if (winner) return winner;

  winner = canonicalParent?.ragic_record_id
    ? oneWinner(sourceIds.filter((sourceId) => String(sourceId) === String(canonicalParent.ragic_record_id)), 3)
    : null;
  if (winner) return winner;

  if (maxPriority < 4) {
    return {
      winnerSourceId: null,
      priority: null,
      decision: 'NO_DECISION',
      evidence: { priority4: { decision: 'NOT_EVALUATED', reason: 'CANARY_NOT_ENABLED' } },
    };
  }

  const p4 = await priority4StudentSourceEvidence(client, {
    sourceIds, familyById, exactMatches, canonicalParent, z01Links: links,
  });
  if (p4.decision === 'WINNER') {
    return { winnerSourceId: p4.winnerSourceId, priority: 4, decision: 'WINNER', evidence: p4 };
  }

  const p5 = await priority5RegistrationSourceEvidence(client, { sourceIds, canonicalParent });
  if (p5.decision === 'WINNER') return p5;

  const p6 = await priority6UniqueWritableBlankSource(client, { sourceIds, shadowBySource });
  if (p6.decision === 'WINNER') {
    return { winnerSourceId: p6.winnerSourceId, priority: 6, decision: 'WINNER', evidence: p6 };
  }

  return {
    winnerSourceId: null,
    priority: null,
    decision: 'NO_DECISION',
    evidence: { priority4: p4, priority5: p5, priority6: p6 },
  };
}

module.exports = {
  INVALID_SOURCE_STATUSES,
  resolveMultipleSourceCandidate,
  priority4StudentSourceEvidence,
  priority5RegistrationSourceEvidence,
  priority6UniqueWritableBlankSource,
};
