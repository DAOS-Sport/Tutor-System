'use strict';

const { formatPlainDate } = require('../utils/dateTime');

// Callers must use the same transaction as the student mutation. Never catch an
// audit failure and commit the mutation: both records are one business write.
const STUDENT_AUDIT_FIELDS = Object.freeze([
  'parent_id', 'name', 'birth_date', 'gender', 'id_number', 'blood_type',
  'student_code', 'is_active', 'ragic_record_id',
]);

function valueForAudit(value, field) {
  if (value == null || value === '') return null;
  if (field === 'birth_date') {
    if (value instanceof Date) {
      // pg 的 DATE 由 models/db.js 以台北午夜解讀；用台北日曆投影取回原日期，
      // 不用 getFullYear() 等本地 getter（那會跟著 Node 行程 TZ 走，Issue #11）。
      return formatPlainDate(value);
    }
    return String(value).slice(0, 10);
  }
  return value;
}

function diffChanges(before, after, fields = STUDENT_AUDIT_FIELDS) {
  const changes = {};
  for (const field of fields) {
    const b = valueForAudit(before?.[field], field);
    const a = valueForAudit(after?.[field], field);
    if (JSON.stringify(b) !== JSON.stringify(a)) changes[field] = { before: b, after: a };
  }
  return Object.keys(changes).length ? changes : null;
}

async function writeStudentAudit(db, studentId, action, { byUser, byRole, changes, note } = {}) {
  if (!byUser || !byRole) throw new Error('STUDENT_AUDIT_ACTOR_REQUIRED');
  if (action === 'create' && changes === undefined) {
    const row = (await db.query('SELECT * FROM students WHERE id = $1', [studentId])).rows[0];
    if (!row) throw new Error('STUDENT_AUDIT_ROW_MISSING');
    changes = diffChanges(null, row);
  }
  if (action === 'edit' && !changes) return;
  await db.query(
    `INSERT INTO student_audit_logs (student_id, action, by_user, by_role, changes, note)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [studentId, action, String(byUser), String(byRole), changes ? JSON.stringify(changes) : null, note || null]
  );
}

function parentActor(parentId, note) {
  return { byUser: `parent:${parentId}`, byRole: 'parent', note };
}

function adminActorName(req) {
  const user = req.adminUser || {};
  return user.sub || user.id || user.username || user.name || null;
}

module.exports = { STUDENT_AUDIT_FIELDS, diffChanges, writeStudentAudit, parentActor, adminActorName };
