/**
 * 期末評鑑 + 教練考核 service
 *
 * 對外介面：
 *   - ensureInvitation(periodId)            建立或取得 invitation（cron / API 共用）
 *   - listForParent(parentId)               取得家長端尚未填或已填的全部 evaluations
 *   - getMine(evalId, parentId)             取得單筆（含完整題目）
 *   - submit(evalId, parentId, payload)     提交（4 維度 + comment + renew_intent）
 *   - listInvitesForReminder()              cron 用：找出 invited > 7 天且未提交未提醒
 *   - markReminderSent(evalId)
 *   - coachReport(coachId, { from, to })    F-M09 教練報表（avg + monthly trend + comments）
 *   - thresholds()                          目前生效門檻
 *   - evaluateCoachAgainstThresholds(coachId, today=now)  用於後台徽章
 */
const { pool } = require('../models/db');

const MAX_COMMENT = 1000;
const RENEW_VALUES = new Set(['yes', 'no', 'unknown']);

function _clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}

async function ensureInvitation(periodId) {
  const r = await pool.query(
    `SELECT cp.id AS period_id, cp.coach_id,
            ARRAY(SELECT DISTINCT s.parent_id
                    FROM course_period_enrollments e JOIN students s ON s.id = e.student_id
                   WHERE e.course_period_id = cp.id AND e.status = 'active') AS parent_ids
       FROM course_periods cp WHERE cp.id = $1`,
    [periodId]
  );
  if (!r.rowCount) return [];
  const { coach_id, parent_ids } = r.rows[0];
  const created = [];
  for (const pid of parent_ids || []) {
    const ins = await pool.query(
      `INSERT INTO course_evaluations (course_period_id, parent_id, coach_id)
       VALUES ($1, $2, $3) ON CONFLICT (course_period_id, parent_id) DO NOTHING
       RETURNING *`,
      [periodId, pid, coach_id]
    );
    if (ins.rowCount) created.push(ins.rows[0]);
  }
  return created;
}

async function listForParent(parentId) {
  const r = await pool.query(
    `SELECT ce.*, co.name AS coach_name, cp.venue_id, cp.course_type
       FROM course_evaluations ce
       JOIN coaches co ON co.id = ce.coach_id
       JOIN course_periods cp ON cp.id = ce.course_period_id
      WHERE ce.parent_id = $1
      ORDER BY ce.invited_at DESC`,
    [parentId]
  );
  return r.rows;
}

async function getMine(evalId, parentId) {
  const r = await pool.query(
    `SELECT ce.*, co.name AS coach_name, cp.venue_id
       FROM course_evaluations ce
       JOIN coaches co ON co.id = ce.coach_id
       JOIN course_periods cp ON cp.id = ce.course_period_id
      WHERE ce.id = $1 AND ce.parent_id = $2`,
    [evalId, parentId]
  );
  return r.rows[0] || null;
}

async function submit(evalId, parentId, payload) {
  const cur = await getMine(evalId, parentId);
  if (!cur) { const e = new Error('Not found'); e.status = 404; throw e; }
  if (cur.submitted_at) { const e = new Error('已提交，不可重複送出'); e.status = 409; throw e; }

  const t = _clampScore(payload?.score_teaching);
  const a = _clampScore(payload?.score_attitude);
  const p = _clampScore(payload?.score_progress);
  const o = _clampScore(payload?.score_overall);
  if (!t || !a || !p || !o) {
    const e = new Error('四項評分皆為必填（1-5 星）'); e.status = 400; throw e;
  }
  const renew = RENEW_VALUES.has(payload?.renew_intent) ? payload.renew_intent : 'unknown';
  const comment = String(payload?.comment || '').slice(0, MAX_COMMENT);

  const r = await pool.query(
    `UPDATE course_evaluations
        SET score_teaching = $1, score_attitude = $2, score_progress = $3, score_overall = $4,
            comment = $5, renew_intent = $6, submitted_at = NOW()
      WHERE id = $7 RETURNING *`,
    [t, a, p, o, comment, renew, evalId]
  );
  return r.rows[0];
}

async function listInvitesForReminder() {
  const r = await pool.query(
    `SELECT ce.id, ce.parent_id, ce.course_period_id, ce.coach_id, cp.venue_id
       FROM course_evaluations ce
       JOIN course_periods cp ON cp.id = ce.course_period_id
      WHERE ce.submitted_at IS NULL
        AND ce.reminder_sent_at IS NULL
        AND ce.invited_at < NOW() - INTERVAL '7 days'`
  );
  return r.rows;
}

async function markReminderSent(evalId) {
  await pool.query(
    `UPDATE course_evaluations SET reminder_sent_at = NOW() WHERE id = $1`,
    [evalId]
  );
}

// ── 後台教練考核報表 (F-M09) ──────────────────
async function coachReport(coachId, { from, to } = {}) {
  const args = [coachId];
  let where = `WHERE coach_id = $1 AND submitted_at IS NOT NULL`;
  if (from) { args.push(from); where += ` AND submitted_at >= $${args.length}`; }
  if (to)   { args.push(to);   where += ` AND submitted_at <= $${args.length}`; }

  const summary = await pool.query(
    `SELECT COUNT(*)::int AS n,
            ROUND(AVG(score_overall)::numeric, 2) AS avg_overall,
            ROUND(AVG(score_teaching)::numeric, 2) AS avg_teaching,
            ROUND(AVG(score_attitude)::numeric, 2) AS avg_attitude,
            ROUND(AVG(score_progress)::numeric, 2) AS avg_progress,
            SUM(CASE WHEN renew_intent = 'yes' THEN 1 ELSE 0 END)::int AS renew_yes,
            SUM(CASE WHEN renew_intent = 'no'  THEN 1 ELSE 0 END)::int AS renew_no
       FROM course_evaluations ${where}`,
    args
  );

  const monthly = await pool.query(
    `SELECT TO_CHAR(DATE_TRUNC('month', submitted_at), 'YYYY-MM') AS month,
            COUNT(*)::int AS n,
            ROUND(AVG(score_overall)::numeric, 2) AS avg_overall,
            ROUND(AVG(score_teaching)::numeric, 2) AS avg_teaching
       FROM course_evaluations ${where}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
    args
  );

  const comments = await pool.query(
    `SELECT id, comment, score_overall, renew_intent, submitted_at
       FROM course_evaluations ${where} AND comment <> ''
      ORDER BY submitted_at DESC LIMIT 30`,
    args
  );

  const s = summary.rows[0] || {};
  const total = (Number(s.renew_yes) || 0) + (Number(s.renew_no) || 0);
  const renew_rate = total ? Number((s.renew_yes / total).toFixed(2)) : null;

  return {
    summary: { ...s, renew_rate },
    monthly: monthly.rows,
    comments: comments.rows,
  };
}

async function thresholds() {
  const r = await pool.query(
    `SELECT id, metric, min_value, window_months, is_active, updated_at
       FROM eval_thresholds ORDER BY metric`
  );
  return r.rows;
}

async function upsertThreshold({ metric, min_value, window_months, is_active }) {
  const r = await pool.query(
    `INSERT INTO eval_thresholds (metric, min_value, window_months, is_active)
     VALUES ($1, $2, $3, COALESCE($4, TRUE))
     ON CONFLICT (metric) DO UPDATE
       SET min_value = EXCLUDED.min_value,
           window_months = EXCLUDED.window_months,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()
     RETURNING *`,
    [metric, min_value, window_months || 3, is_active]
  );
  return r.rows[0];
}

async function listAllCoachReports({ from, to } = {}) {
  const r = await pool.query(
    `SELECT co.id, co.name, co.is_senior, co.intro_review_status,
            COUNT(ce.id) FILTER (WHERE ce.submitted_at IS NOT NULL)::int AS n,
            ROUND(AVG(ce.score_overall) FILTER (WHERE ce.submitted_at IS NOT NULL)::numeric, 2) AS avg_overall,
            ROUND(AVG(ce.score_teaching) FILTER (WHERE ce.submitted_at IS NOT NULL)::numeric, 2) AS avg_teaching,
            SUM(CASE WHEN ce.renew_intent = 'yes' THEN 1 ELSE 0 END)::int AS renew_yes,
            SUM(CASE WHEN ce.renew_intent = 'no'  THEN 1 ELSE 0 END)::int AS renew_no
       FROM coaches co
       LEFT JOIN course_evaluations ce ON ce.coach_id = co.id
            ${from ? `AND ce.submitted_at >= '${new Date(from).toISOString()}'` : ''}
            ${to ? `AND ce.submitted_at <= '${new Date(to).toISOString()}'` : ''}
      WHERE co.is_active = TRUE
      GROUP BY co.id, co.name, co.is_senior, co.intro_review_status
      ORDER BY avg_overall DESC NULLS LAST, co.name`
  );
  const ths = await thresholds();
  const map = Object.fromEntries(ths.filter((t) => t.is_active).map((t) => [t.metric, Number(t.min_value)]));
  return r.rows.map((row) => {
    const total = (Number(row.renew_yes) || 0) + (Number(row.renew_no) || 0);
    const renew_rate = total ? Number((row.renew_yes / total).toFixed(2)) : null;
    const failed = [];
    if (map.avg_overall && row.avg_overall != null && Number(row.avg_overall) < map.avg_overall) failed.push('avg_overall');
    if (map.avg_teaching && row.avg_teaching != null && Number(row.avg_teaching) < map.avg_teaching) failed.push('avg_teaching');
    if (map.renew_rate && renew_rate != null && renew_rate < map.renew_rate) failed.push('renew_rate');
    return { ...row, renew_rate, failed_metrics: failed };
  });
}

module.exports = {
  ensureInvitation, listForParent, getMine, submit,
  listInvitesForReminder, markReminderSent,
  coachReport, listAllCoachReports,
  thresholds, upsertThreshold,
};
