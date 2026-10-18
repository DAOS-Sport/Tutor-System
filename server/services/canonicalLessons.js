'use strict';
const fs = require('node:fs');
const path = require('node:path');

async function ensureCanonicalLessonSchema(pool) {
  await pool.query(fs.readFileSync(path.join(__dirname,'../../db/migrations/069_course_lesson_normalization.sql'),'utf8'));
}

async function attachCanonicalLessons(rows,pool) {
  const ids = rows.map(row=>row.id).filter(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (!ids.length) return rows;
  // Older schemas have no stored corrections. Once installed, query failures
  // must surface; never catch them and export duplicate salary rows instead.
  const installed = await pool.query("SELECT to_regclass('v_course_lesson_payroll') IS NOT NULL AS installed");
  if (!installed.rows[0]?.installed) return rows;
  const result = await pool.query(`SELECT v.*,
    COALESCE((SELECT json_agg(json_build_object('id',st.id::text,'name',st.name) ORDER BY st.name,st.id)
      FROM students st WHERE st.id=ANY(v.roster_student_ids)),'[]'::json) AS roster
    FROM v_course_lesson_payroll v WHERE v.normalization_id IS NOT NULL
      AND v.source_session_ids && $1::uuid[]`,[ids]);
  const bySession = new Map();
  for (const row of result.rows) for (const id of row.source_session_ids) bySession.set(id,{
    id:row.canonical_lesson_id,source_session_ids:row.source_session_ids,source_valid:row.source_valid,
    consumed:row.consumed,roster:row.roster,policy:row.policy,checkin_at:row.checkin_at,
  });
  return rows.map(row=>bySession.has(row.id)?{...row,canonical_lesson:bySession.get(row.id)}:row);
}
module.exports = {ensureCanonicalLessonSchema,attachCanonicalLessons};
