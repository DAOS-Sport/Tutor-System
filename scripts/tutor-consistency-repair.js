#!/usr/bin/env node
'use strict';
// Explicit operator tool. Default is read-only. Never called from app startup.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pool } = require('../server/node_modules/pg');
const TABLES = {
  admin_enrollments: ['coach', 'updated_at'],
  course_sessions: ['status', 'completed_at', 'updated_at'],
  course_periods: ['status', 'entitlement_state', 'updated_at'],
};
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function saveNew(file, value) {
  if (!file) throw new Error('An explicit output path is required');
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function snapshot(db, table, id, lock = false) {
  if (!TABLES[table]) throw new Error('unsupported table');
  const r = await db.query(`SELECT to_jsonb(t) AS row, md5(to_jsonb(t)::text) AS version FROM ${table} t WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (r.rowCount !== 1) throw new Error('repair target missing');
  return r.rows[0];
}
async function candidates(db) {
  const result = [];
  const coaches = await db.query(`SELECT e.id,c.name FROM admin_enrollments e JOIN coaches c ON c.id=e.coach_id
    WHERE e.coach LIKE '%[object Object]%' AND c.name IS NOT NULL AND btrim(c.name)<>'' ORDER BY e.id`);
  for (const r of coaches.rows) result.push({ table: 'admin_enrollments', id: r.id, reason: 'canonical_coach_name', patch: { coach: r.name } });
  // Only metadata completion: never infer or change how many lessons were used.
  // Existing session_deducted=true proves the consumption path already ran.
  const sessions = await db.query(`SELECT s.id,min(c.checked_in_at) AS attended_at FROM course_sessions s
    JOIN checkin_records c ON c.course_session_id=s.id AND c.reversed_at IS NULL AND c.attendance_status='ATTENDED'
    WHERE s.status='confirmed' AND s.scheduled_at<now() AND s.session_deducted=true GROUP BY s.id ORDER BY s.id`);
  for (const r of sessions.rows) result.push({ table: 'course_sessions', id: r.id, reason: 'attended_session_status', patch: { status: 'completed', completed_at: r.attended_at } });
  // A period already marked refunded can be disabled without deciding which
  // family owns a shared active period. Active/refunded-source cases stay manual.
  const periods = await db.query("SELECT id FROM course_periods WHERE status='refunded' AND entitlement_state='ACTIVE' ORDER BY id");
  for (const r of periods.rows) result.push({ table: 'course_periods', id: r.id, reason: 'refunded_period_entitlement', patch: { entitlement_state: 'MANUAL_REVIEW' } });
  for (const r of result) {
    const before = await snapshot(db, r.table, r.id);
    r.before = before.row; r.version = before.version;
    if (r.table === 'course_sessions' && r.before.completed_at) r.patch.completed_at = r.before.completed_at;
  }
  const pending = await db.query(`SELECT
    (SELECT count(*) FROM admin_enrollments e WHERE e.coach LIKE '%[object Object]%' AND NOT EXISTS(SELECT 1 FROM coaches c WHERE c.id=e.coach_id AND btrim(c.name)<>'')) coach_identity_unknown,
    (SELECT count(*) FROM course_sessions s WHERE s.status='confirmed' AND s.scheduled_at<now() AND NOT s.session_deducted AND EXISTS(SELECT 1 FROM checkin_records c WHERE c.course_session_id=s.id AND c.reversed_at IS NULL)) attendance_consumption_review,
    (SELECT count(*) FROM course_periods p JOIN admin_enrollments e ON e.id=p.admin_enrollment_id WHERE e.status='refunded' AND p.status<>'refunded') refunded_source_active_period`);
  return { changes: result, manual_review: pending.rows[0] };
}
function signature(changes) { return changes.map(r => `${r.table}:${r.id}:${r.version}:${JSON.stringify(r.patch)}`).sort(); }
async function update(db, change, patch) {
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(k => !TABLES[change.table]?.includes(k))) throw new Error('invalid repair columns');
  await db.query(`UPDATE ${change.table} SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [change.id, ...keys.map(k => patch[k])]);
  return snapshot(db, change.table, change.id);
}
async function run({ mode = 'dry-run', output, planFile, confirmDatabase, backupFile, receiptFile, actor, url = process.env.DATABASE_URL } = {}) {
  if (!['dry-run', 'apply', 'rollback'].includes(mode)) throw new Error('mode must be dry-run, apply or rollback');
  if (mode !== 'dry-run') {
    if (!actor || !backupFile || !receiptFile || path.resolve(backupFile) === path.resolve(receiptFile)) throw new Error('actor and distinct backup/receipt paths required');
    for (const file of [backupFile, receiptFile]) {
      if (fs.existsSync(file)) throw new Error('output already exists; refusing overwrite');
      fs.accessSync(path.dirname(path.resolve(file)), fs.constants.W_OK);
    }
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = await pool.connect();
  try {
    await db.query(mode === 'dry-run' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL statement_timeout='15s'");
    await db.query("SET LOCAL lock_timeout='3s'");
    const identity = (await db.query('SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port')).rows[0];
    if (mode === 'dry-run') {
      const data = await candidates(db);
      const plan = { schema: 1, created_at: new Date().toISOString(), identity, ...data };
      plan.digest = digest(plan);
      saveNew(output, plan);
      await db.query('ROLLBACK');
      return { mode, proposed: data.changes.length, manual_review: data.manual_review, digest: plan.digest };
    }
    if (confirmDatabase !== identity.database) throw new Error('Explicit database confirmation required');
    const saved = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const savedDigest = saved.digest; delete saved.digest;
    if (savedDigest !== digest(saved)) throw new Error('Plan/backup digest mismatch');
    if (JSON.stringify(saved.identity) !== JSON.stringify(identity)) throw new Error('Database identity mismatch');
    // Shared advisory lock prevents two repair/rollback operators overlapping.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('tutor-consistency-repair-v1'))");
    if (mode === 'apply') {
      const fresh = await candidates(db);
      if (JSON.stringify(signature(fresh.changes)) !== JSON.stringify(signature(saved.changes))) throw new Error('Plan stale; regenerate dry-run');
    }
    const mutations = [];
    for (const change of saved.changes) {
      const current = await snapshot(db, change.table, change.id, true);
      const expected = mode === 'apply' ? change.version : change.after_version;
      if (current.version !== expected) throw new Error('Concurrent edit detected; transaction rolled back');
      const patch = mode === 'apply' ? { ...change.patch, updated_at: new Date().toISOString() }
        : Object.fromEntries([...Object.keys(change.patch), 'updated_at'].map(k => [k, change.before[k]]));
      const after = await update(db, change, patch);
      mutations.push({ ...change, after: after.row, after_version: after.version });
    }
    // fsync a complete before/after backup before committing any business edit.
    const backup = { schema: 1, mode, actor, created_at: new Date().toISOString(), identity, plan_digest: savedDigest, changes: mutations };
    backup.digest = digest(backup);
    saveNew(backupFile, backup);
    await db.query('COMMIT');
    try { saveNew(receiptFile, { committed: true, mode, actor, changed: mutations.length, backup_digest: backup.digest, at: new Date().toISOString() }); }
    catch (e) { throw new Error(`COMMITTED but receipt could not be saved; compare database with backup before retrying: ${e.code || e.message}`); }
    return { mode, changed: mutations.length, committed: true, backup_digest: backup.digest };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { db.release(); await pool.end(); }
}
module.exports = { run, candidates };
if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  const flags = { '--mode': 'mode', '--output': 'output', '--plan': 'planFile', '--confirm-database': 'confirmDatabase', '--backup': 'backupFile', '--receipt': 'receiptFile', '--actor': 'actor' };
  for (let i = 0; i < args.length; i += 2) { if (!flags[args[i]] || !args[i + 1]) throw new Error('invalid option'); options[flags[args[i]]] = args[i + 1]; }
  run(options).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
