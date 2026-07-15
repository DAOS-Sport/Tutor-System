#!/usr/bin/env node
/** Verify the full chain on an empty schema, then exercise 032 reruns and reversal. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const assert = require('node:assert/strict');
const { reverseLessonDeduction } = require('../services/deductionRevival');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const suffix = `${process.pid}_${Date.now()}`;
  const fullSchema = `migration_full_${suffix}`;
  const integrationSchema = `migration_test_${suffix}`;
  try {
    await client.query('BEGIN');
    const dir = path.join(__dirname, '..', '..', 'db', 'migrations');
    const migrations = fs.readdirSync(dir).filter((name) => /^\d+.*\.sql$/.test(name)).sort();

    // Empty-schema regression: every checked-in migration must apply in order.
    await client.query(`CREATE SCHEMA ${fullSchema}`);
    await client.query(`SET LOCAL search_path TO ${fullSchema}, public`);
    for (const name of migrations) {
      try {
        await client.query(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch (err) {
        throw new Error(`${name}: ${err.message}`);
      }
    }
    // The additive reversal migration is safe to run repeatedly on an already
    // migrated schema (the common production/bootstrap deployment path).
    const reversal = fs.readFileSync(path.join(dir, '032_shared_usage_reversal.sql'), 'utf8');
    await client.query(reversal);
    await client.query(reversal);

    // A compact legacy-shaped fixture makes it cheap to assert both upgrade
    // idempotency and the service's shared-session semantics.
    await client.query(`CREATE SCHEMA ${integrationSchema}`);
    await client.query(`SET LOCAL search_path TO ${integrationSchema}, public`);
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE course_periods (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        venue_id TEXT NOT NULL DEFAULT 'B',
        admin_enrollment_id TEXT,
        group_order_id UUID,
        enrollment_batch_id UUID,
        period_number INTEGER NOT NULL DEFAULT 1,
        total_sessions INTEGER NOT NULL DEFAULT 6,
        used_sessions INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE course_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_period_id UUID NOT NULL REFERENCES course_periods(id),
        status TEXT NOT NULL DEFAULT 'completed',
        created_via TEXT NOT NULL DEFAULT 'self_checkin',
        session_deducted BOOLEAN NOT NULL DEFAULT TRUE,
        self_checkin_date DATE,
        cancelled_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE students (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE checkin_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_session_id UUID NOT NULL REFERENCES course_sessions(id),
        student_id UUID NOT NULL REFERENCES students(id),
        UNIQUE(course_session_id, student_id)
      );
      CREATE TABLE manual_lesson_deductions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_period_id UUID NOT NULL REFERENCES course_periods(id),
        course_session_id UUID NOT NULL REFERENCES course_sessions(id),
        student_id UUID NOT NULL REFERENCES students(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE admin_enrollments (
        id TEXT PRIMARY KEY,
        group_order_id UUID,
        enrollment_batch_id UUID,
        period_number INTEGER NOT NULL DEFAULT 1,
        total_sessions INTEGER NOT NULL DEFAULT 6,
        used_sessions INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE admin_enrollment_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        enrollment_id TEXT NOT NULL,
        action TEXT NOT NULL,
        by_user TEXT NOT NULL
      );
    `);
    await client.query(reversal);
    await client.query(reversal);
    await client.query(reversal);
    const check = await client.query(
      `SELECT
         to_regclass('lesson_deduction_reversals') IS NOT NULL AS reversal_table,
         to_regclass('application_feature_flags') IS NOT NULL AS flag_table,
         (SELECT COUNT(*) FROM application_feature_flags
           WHERE key IN ('SHARED_CHECKIN_USAGE_V2','DEDUCTION_REVIVAL_V2')) AS flags`
    );
    if (!check.rows[0]?.reversal_table || !check.rows[0]?.flag_table || Number(check.rows[0]?.flags) !== 2) {
      throw new Error('migration verification query failed');
    }

    const period = await client.query(
      `INSERT INTO course_periods (admin_enrollment_id, total_sessions, used_sessions)
       VALUES ('E-CANARY', 6, 1) RETURNING id`
    );
    await client.query(`INSERT INTO admin_enrollments (id, total_sessions, used_sessions) VALUES ('E-CANARY', 6, 1)`);
    const session = await client.query(
      `INSERT INTO course_sessions (course_period_id, self_checkin_date)
       VALUES ($1, '2026-07-16') RETURNING id`,
      [period.rows[0].id]
    );
    const students = await client.query(
      `INSERT INTO students DEFAULT VALUES RETURNING id`
    );
    const s2 = await client.query(`INSERT INTO students DEFAULT VALUES RETURNING id`);
    const s3 = await client.query(`INSERT INTO students DEFAULT VALUES RETURNING id`);
    for (const studentId of [students.rows[0].id, s2.rows[0].id, s3.rows[0].id]) {
      await client.query(
        `INSERT INTO checkin_records (course_session_id, student_id) VALUES ($1, $2)
         ON CONFLICT (course_session_id, student_id) DO NOTHING`,
        [session.rows[0].id, studentId]
      );
    }
    // A retried 1:3 check-in still has three attendance rows and one usage event.
    for (const studentId of [students.rows[0].id, s2.rows[0].id, s3.rows[0].id]) {
      await client.query(
        `INSERT INTO checkin_records (course_session_id, student_id) VALUES ($1, $2)
         ON CONFLICT (course_session_id, student_id) DO NOTHING`,
        [session.rows[0].id, studentId]
      );
    }
    const shared13 = await client.query(
      `SELECT COUNT(*)::int AS attendances, COUNT(DISTINCT course_session_id)::int AS usages
         FROM checkin_records WHERE course_session_id = $1`,
      [session.rows[0].id]
    );
    assert.deepEqual(shared13.rows[0], { attendances: 3, usages: 1 });

    // The same invariant holds for a separate 1:2 entitlement.
    const period12 = await client.query(
      `INSERT INTO course_periods (admin_enrollment_id, total_sessions, used_sessions)
       VALUES ('E-CANARY-12', 6, 1) RETURNING id`
    );
    const session12 = await client.query(
      `INSERT INTO course_sessions (course_period_id, self_checkin_date)
       VALUES ($1, '2026-07-16') RETURNING id`,
      [period12.rows[0].id]
    );
    for (const studentId of [students.rows[0].id, s2.rows[0].id]) {
      await client.query(
        `INSERT INTO checkin_records (course_session_id, student_id) VALUES ($1, $2)
         ON CONFLICT (course_session_id, student_id) DO NOTHING`,
        [session12.rows[0].id, studentId]
      );
    }
    const shared12 = await client.query(
      `SELECT COUNT(*)::int AS attendances, COUNT(DISTINCT course_session_id)::int AS usages
         FROM checkin_records WHERE course_session_id = $1`,
      [session12.rows[0].id]
    );
    assert.deepEqual(shared12.rows[0], { attendances: 2, usages: 1 });
    const first = await reverseLessonDeduction(client, {
      sessionId: session.rows[0].id,
      reason: 'integration test',
      reversedBy: 'test-runner',
    });
    const retry = await reverseLessonDeduction(client, {
      sessionId: session.rows[0].id,
      reason: 'integration test retry',
      reversedBy: 'test-runner',
    });
    const state = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM checkin_records WHERE attendance_status = 'REVERSED')::int AS reversed,
         (SELECT COUNT(*) FROM lesson_deduction_reversals)::int AS ledgers,
         (SELECT used_sessions FROM course_periods WHERE id = $1)::int AS used`,
      [period.rows[0].id]
    );
    assert.equal(first.reversedAttendances, 3);
    assert.equal(first.idempotent, false);
    assert.equal(retry.idempotent, true);
    assert.deepEqual(state.rows[0], { reversed: 3, ledgers: 1, used: 0 });
    console.log(`full migration chain ok (${migrations.length} files); 032 rerun ok; 1:2/1:3 shared usage ok; reversal retry idempotent; rolled back`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migration idempotency failed:', err.message);
  process.exit(1);
});
