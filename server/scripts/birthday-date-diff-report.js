#!/usr/bin/env node
/**
 * Read-only comparison of local PostgreSQL DATE birthdays and Ragic Z01 linked students.
 * It never updates either source. Output is JSON so operations can review one-day drifts
 * before deciding whether any manual correction is warranted.
 */
process.env.TZ = 'Asia/Taipei';
require('dotenv').config();
const { pool } = require('../models/db');
const ragic = require('../services/ragic');
const { formatPlainDate } = require('../utils/dateTime');

function dayDelta(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

async function main() {
  const local = await pool.query(
    `SELECT s.id, s.name, s.id_number, s.student_code, s.birth_date,
            p.phone AS parent_phone
       FROM students s
       JOIN parents p ON p.id = s.parent_id
      WHERE COALESCE(s.is_active, TRUE) = TRUE
      ORDER BY p.phone, s.name`
  );
  const z01Rows = await ragic.getAllParents();
  const remoteStudents = [];
  for (const row of z01Rows || []) {
    const parent = ragic.mapZ01Parent(row) || {};
    for (const student of ragic.parseZ01Students(row)) {
      remoteStudents.push({ ...student, parent_phone: parent.phone || '' });
    }
  }

  const byId = new Map(remoteStudents.filter((s) => s.id_number).map((s) => [s.id_number.toUpperCase(), s]));
  const byCode = new Map(remoteStudents.filter((s) => s.student_code).map((s) => [String(s.student_code), s]));
  const differences = [];
  let matched = 0;
  for (const row of local.rows) {
    const remote = (row.id_number && byId.get(String(row.id_number).toUpperCase()))
      || (row.student_code && byCode.get(String(row.student_code)))
      || remoteStudents.find((s) => s.parent_phone === row.parent_phone && s.name === row.name);
    if (!remote) continue;
    matched += 1;
    const localDate = formatPlainDate(row.birth_date);
    const ragicDate = formatPlainDate(remote.birth_date);
    if (localDate !== ragicDate) {
      differences.push({
        student_id: row.id,
        student_name: row.name,
        local_date: localDate,
        ragic_date: ragicDate,
        day_delta: dayDelta(localDate, ragicDate),
        exactly_one_day_apart: Math.abs(dayDelta(localDate, ragicDate)) === 1,
      });
    }
  }
  process.stdout.write(`${JSON.stringify({
    generated_at_utc: new Date().toISOString(),
    read_only: true,
    local_students: local.rowCount,
    ragic_students: remoteStudents.length,
    matched,
    difference_count: differences.length,
    differences,
  }, null, 2)}\n`);
}

main()
  .catch((err) => {
    console.error(JSON.stringify({ error: err.message, code: err.code || null }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
