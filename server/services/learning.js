/**
 * 學習歷程 service：lesson_plans / session_records / tag library
 *
 * 對外介面：
 *   - getPlan(periodId)            取得課前規劃（無則回 null）
 *   - upsertPlan(periodId, coachId, fields)
 *   - publishPlan(periodId, coachId)         => 回傳 plan + 是否從 draft → published
 *   - getRecord(sessionId)                   取得授課記錄（無則回 null）
 *   - upsertRecord(sessionId, coachId, fields)
 *   - submitRecord(sessionId, coachId)       提交（首次或重新提交）
 *     ‧ 重新提交時把舊欄位 snapshot 寫入 session_record_versions
 *   - copyPrev(sessionId, coachId)           載入「前一堂」紀錄欄位（不寫入）
 *   - listTags()                             系統 + 教練個人標籤一覽
 *   - listLearningHistory(periodId)          家長端：plan + records 時間軸
 *
 * Authorization 準則：所有 coach 寫入路徑都會比對 course_periods.coach_id；不放權限就直接 throw。
 */
const { pool } = require('../models/db');

const RECORD_FIELDS = ['summary', 'highlights', 'improvements', 'homework'];
const PLAN_FIELDS = ['goals', 'expected_outcomes', 'learning_plan', 'initial_assessment', 'notes'];

async function _periodOwnedBy(periodId, coachId) {
  const r = await pool.query(`SELECT coach_id FROM course_periods WHERE id = $1`, [periodId]);
  if (r.rows.length === 0) return false;
  return String(r.rows[0].coach_id) === String(coachId);
}

async function _sessionPeriodAndCoach(sessionId) {
  const r = await pool.query(
    `SELECT cs.id, cs.course_period_id, cp.coach_id, cs.scheduled_at
       FROM course_sessions cs JOIN course_periods cp ON cp.id = cs.course_period_id
      WHERE cs.id = $1`,
    [sessionId]
  );
  return r.rows[0] || null;
}

// ── 課前規劃 (F-C04) ────────────────────────────
async function getPlan(periodId) {
  const r = await pool.query(`SELECT * FROM lesson_plans WHERE course_period_id = $1`, [periodId]);
  return r.rows[0] || null;
}

async function upsertPlan(periodId, coachId, fields) {
  if (!await _periodOwnedBy(periodId, coachId)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  const v = {};
  for (const k of PLAN_FIELDS) v[k] = String(fields?.[k] || '').slice(0, 4000);
  const r = await pool.query(
    `INSERT INTO lesson_plans (course_period_id, coach_id, goals, expected_outcomes, learning_plan, initial_assessment, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (course_period_id) DO UPDATE
       SET goals = EXCLUDED.goals,
           expected_outcomes = EXCLUDED.expected_outcomes,
           learning_plan = EXCLUDED.learning_plan,
           initial_assessment = EXCLUDED.initial_assessment,
           notes = EXCLUDED.notes,
           updated_at = NOW()
     RETURNING *`,
    [periodId, coachId, v.goals, v.expected_outcomes, v.learning_plan, v.initial_assessment, v.notes]
  );
  return r.rows[0];
}

async function publishPlan(periodId, coachId) {
  if (!await _periodOwnedBy(periodId, coachId)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  const r = await pool.query(
    `UPDATE lesson_plans
        SET status = 'published',
            published_at = COALESCE(published_at, NOW()),
            updated_at = NOW()
      WHERE course_period_id = $1
      RETURNING *`,
    [periodId]
  );
  return r.rows[0] || null;
}

// ── 授課記錄 (F-C05) ────────────────────────────
async function getRecord(sessionId) {
  const r = await pool.query(`SELECT * FROM session_records WHERE course_session_id = $1`, [sessionId]);
  if (r.rows.length === 0) return null;
  const rec = r.rows[0];
  const tags = await pool.query(
    `SELECT label FROM session_record_tags WHERE session_record_id = $1 ORDER BY created_at`,
    [rec.id]
  );
  return { ...rec, tags: tags.rows.map((t) => t.label) };
}

function _mediaList(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m) => m && m.url)
    .slice(0, 10)
    .map((m) => ({
      url: String(m.url).slice(0, 1000),
      mime: String(m.mime || 'application/octet-stream').slice(0, 100),
      name: String(m.name || '').slice(0, 200),
      size: Number(m.size) || 0,
    }));
}

async function upsertRecord(sessionId, coachId, fields) {
  const sess = await _sessionPeriodAndCoach(sessionId);
  if (!sess) { const e = new Error('Not found'); e.status = 404; throw e; }
  if (String(sess.coach_id) !== String(coachId)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  const v = {};
  for (const k of RECORD_FIELDS) v[k] = String(fields?.[k] || '').slice(0, 4000);
  const media = _mediaList(fields?.media);
  const r = await pool.query(
    `INSERT INTO session_records (course_session_id, course_period_id, coach_id, summary, highlights, improvements, homework, media)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (course_session_id) DO UPDATE
       SET summary = EXCLUDED.summary,
           highlights = EXCLUDED.highlights,
           improvements = EXCLUDED.improvements,
           homework = EXCLUDED.homework,
           media = EXCLUDED.media,
           updated_at = NOW()
     RETURNING *`,
    [sessionId, sess.course_period_id, coachId, v.summary, v.highlights, v.improvements, v.homework, JSON.stringify(media)]
  );
  const rec = r.rows[0];
  if (Array.isArray(fields?.tags)) {
    await pool.query(`DELETE FROM session_record_tags WHERE session_record_id = $1`, [rec.id]);
    for (const t of fields.tags.slice(0, 20)) {
      const label = String(t || '').slice(0, 40).trim();
      if (!label) continue;
      await pool.query(
        `INSERT INTO session_record_tags (session_record_id, label) VALUES ($1, $2)
         ON CONFLICT (session_record_id, label) DO NOTHING`,
        [rec.id, label]
      );
    }
  }
  return getRecord(sessionId);
}

async function submitRecord(sessionId, coachId) {
  const existing = await getRecord(sessionId);
  if (!existing) { const e = new Error('Not found'); e.status = 404; throw e; }
  if (String(existing.coach_id) !== String(coachId)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  // 若已 submitted → 寫入版本快照後重新提交
  if (existing.status === 'submitted') {
    const ver = await pool.query(
      `SELECT COALESCE(MAX(version_no),0)+1 AS next FROM session_record_versions WHERE session_record_id = $1`,
      [existing.id]
    );
    await pool.query(
      `INSERT INTO session_record_versions (session_record_id, version_no, snapshot, edited_by)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [existing.id, ver.rows[0].next, JSON.stringify(existing), coachId]
    );
  }
  const r = await pool.query(
    `UPDATE session_records
        SET status = 'submitted',
            submitted_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [existing.id]
  );
  return r.rows[0];
}

async function listVersions(sessionId) {
  const rec = await getRecord(sessionId);
  if (!rec) return [];
  const r = await pool.query(
    `SELECT version_no, snapshot, edited_by, created_at
       FROM session_record_versions WHERE session_record_id = $1 ORDER BY version_no DESC`,
    [rec.id]
  );
  return r.rows;
}

async function copyPrev(sessionId, coachId) {
  const cur = await _sessionPeriodAndCoach(sessionId);
  if (!cur) { const e = new Error('Not found'); e.status = 404; throw e; }
  if (String(cur.coach_id) !== String(coachId)) {
    const e = new Error('Forbidden'); e.status = 403; throw e;
  }
  const r = await pool.query(
    `SELECT sr.summary, sr.highlights, sr.improvements, sr.homework
       FROM session_records sr
       JOIN course_sessions cs ON cs.id = sr.course_session_id
      WHERE sr.course_period_id = $1
        AND cs.scheduled_at < $2
        AND sr.status = 'submitted'
      ORDER BY cs.scheduled_at DESC LIMIT 1`,
    [cur.course_period_id, cur.scheduled_at]
  );
  return r.rows[0] || null;
}

// ── 標籤庫 ────────────────────────────────────
async function listTags(coachId) {
  const sys = await pool.query(
    `SELECT t.id, t.label, t.text_template, t.category_id, c.name AS category_name
       FROM tag_library t JOIN tag_categories c ON c.id = t.category_id
      WHERE t.is_active = TRUE
      ORDER BY c.sort_order, c.name, t.sort_order, t.label`
  );
  let personal = { rows: [] };
  if (coachId) {
    personal = await pool.query(
      `SELECT id, label, text_template FROM coach_personal_tags WHERE coach_id = $1 ORDER BY created_at DESC`,
      [coachId]
    );
  }
  return { system: sys.rows, personal: personal.rows };
}

async function addPersonalTag(coachId, { label, text_template }) {
  const r = await pool.query(
    `INSERT INTO coach_personal_tags (coach_id, label, text_template) VALUES ($1, $2, $3)
     ON CONFLICT (coach_id, label) DO UPDATE SET text_template = EXCLUDED.text_template
     RETURNING id, label, text_template`,
    [coachId, String(label || '').slice(0, 40), String(text_template || '').slice(0, 1000)]
  );
  return r.rows[0];
}

async function removePersonalTag(coachId, id) {
  const r = await pool.query(`DELETE FROM coach_personal_tags WHERE id = $1 AND coach_id = $2`, [id, coachId]);
  return r.rowCount > 0;
}

// ── 家長端：學習歷程總覽 ──────────────────────────
async function listLearningHistory(periodId) {
  const plan = await pool.query(
    `SELECT * FROM lesson_plans WHERE course_period_id = $1 AND status = 'published'`,
    [periodId]
  );
  const recs = await pool.query(
    `SELECT sr.*, cs.scheduled_at, cs.duration_minutes
       FROM session_records sr
       JOIN course_sessions cs ON cs.id = sr.course_session_id
      WHERE sr.course_period_id = $1 AND sr.status = 'submitted'
      ORDER BY cs.scheduled_at ASC`,
    [periodId]
  );
  // 附上 tag labels
  const ids = recs.rows.map((r) => r.id);
  let tagMap = new Map();
  if (ids.length) {
    const tg = await pool.query(
      `SELECT session_record_id, label FROM session_record_tags WHERE session_record_id = ANY($1)`,
      [ids]
    );
    for (const t of tg.rows) {
      const cur = tagMap.get(t.session_record_id) || [];
      cur.push(t.label);
      tagMap.set(t.session_record_id, cur);
    }
  }
  return {
    plan: plan.rows[0] || null,
    records: recs.rows.map((r) => ({ ...r, tags: tagMap.get(r.id) || [] })),
  };
}

async function coachOwnsSession(sessionId, coachId) {
  const r = await pool.query(
    `SELECT 1
       FROM course_sessions cs
       JOIN course_periods cp ON cp.id = cs.course_period_id
      WHERE cs.id = $1 AND cp.coach_id = $2`,
    [sessionId, coachId]
  );
  return r.rows.length > 0;
}

module.exports = {
  getPlan, upsertPlan, publishPlan,
  getRecord, upsertRecord, submitRecord, listVersions, copyPrev,
  coachOwnsSession,
  listTags, addPersonalTag, removePersonalTag,
  listLearningHistory,
};
