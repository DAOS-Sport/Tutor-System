/**
 * 期末評鑑 + 教練考核 service
 *
 * 對外介面：
 *   - ensureInvitation(periodId)
 *   - listForParent(parentId) / getMine(evalId, parentId) / submit(...)
 *   - listInvitesForReminder() / markReminderSent(evalId)
 *   - coachReport(coachId, { from, to })          F-M09 教練詳細
 *   - thresholds() / upsertThreshold(...)         F-A09
 *   - listAllCoachReports({ from, to })           F-M09 列表（每 metric 套對應 window_months）
 *   - detectBelowThreshold()                       F-A09 不達標偵測（dedupe by coach+metric+月）
 *   - listPendingAlerts() / markAlertNotified(id)
 */
const { pool } = require('../models/db');

const MAX_COMMENT = 1000;
const RENEW_VALUES = new Set(['yes', 'no', 'unknown']);
const METRIC_KEYS = ['avg_overall', 'avg_teaching', 'avg_attitude', 'avg_progress', 'renew_rate'];

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
  await pool.query(`UPDATE course_evaluations SET reminder_sent_at = NOW() WHERE id = $1`, [evalId]);
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

  return { summary: { ...s, renew_rate }, monthly: monthly.rows, comments: comments.rows };
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

// 計算單一教練、單一 metric 在指定 window_months 內的觀察值。
async function _windowedMetric(coachId, metric, windowMonths) {
  const months = Math.max(1, Number(windowMonths) || 3);
  const since = `NOW() - ($2 || ' months')::INTERVAL`;
  if (metric === 'renew_rate') {
    const r = await pool.query(
      `SELECT SUM(CASE WHEN renew_intent='yes' THEN 1 ELSE 0 END)::int AS y,
              SUM(CASE WHEN renew_intent='no'  THEN 1 ELSE 0 END)::int AS n,
              COUNT(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS submitted
         FROM course_evaluations
        WHERE coach_id = $1 AND submitted_at IS NOT NULL AND submitted_at >= ${since}`,
      [coachId, String(months)]
    );
    const { y = 0, n = 0, submitted = 0 } = r.rows[0] || {};
    const total = (Number(y) || 0) + (Number(n) || 0);
    return { value: total ? Number((y / total).toFixed(2)) : null, sample: submitted };
  }
  const col = ({ avg_overall: 'score_overall', avg_teaching: 'score_teaching',
                 avg_attitude: 'score_attitude', avg_progress: 'score_progress' })[metric];
  if (!col) return { value: null, sample: 0 };
  const r = await pool.query(
    `SELECT ROUND(AVG(${col})::numeric, 2) AS v, COUNT(*)::int AS n
       FROM course_evaluations
      WHERE coach_id = $1 AND submitted_at IS NOT NULL AND submitted_at >= ${since}`,
    [coachId, String(months)]
  );
  return { value: r.rows[0]?.v == null ? null : Number(r.rows[0].v), sample: r.rows[0]?.n || 0 };
}

async function listAllCoachReports() {
  const coaches = await pool.query(
    `SELECT co.id, co.name, co.is_senior, co.intro_review_status
       FROM coaches co WHERE co.is_active = TRUE ORDER BY co.name`
  );
  const ths = (await thresholds()).filter((t) => t.is_active && METRIC_KEYS.includes(t.metric));
  const out = [];
  for (const co of coaches.rows) {
    const metrics = {};
    const failed = [];
    for (const th of ths) {
      const { value, sample } = await _windowedMetric(co.id, th.metric, th.window_months);
      metrics[th.metric] = { value, sample, min_value: Number(th.min_value), window_months: th.window_months };
      if (value != null && Number(value) < Number(th.min_value)) failed.push(th.metric);
    }
    // 為 UI 兼容，再算一個全期 avg/n + renew_rate 作為總覽欄位
    const overall = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS n,
              ROUND(AVG(score_overall) FILTER (WHERE submitted_at IS NOT NULL)::numeric, 2) AS avg_overall,
              ROUND(AVG(score_teaching) FILTER (WHERE submitted_at IS NOT NULL)::numeric, 2) AS avg_teaching,
              SUM(CASE WHEN renew_intent='yes' THEN 1 ELSE 0 END)::int AS renew_yes,
              SUM(CASE WHEN renew_intent='no'  THEN 1 ELSE 0 END)::int AS renew_no
         FROM course_evaluations WHERE coach_id = $1`,
      [co.id]
    );
    const o = overall.rows[0] || {};
    const totalRenew = (Number(o.renew_yes) || 0) + (Number(o.renew_no) || 0);
    const renew_rate = totalRenew ? Number((o.renew_yes / totalRenew).toFixed(2)) : null;
    out.push({ ...co, ...o, renew_rate, metrics, failed_metrics: failed });
  }
  return out;
}

// 不達標偵測（cron 用）：每個教練 / 每個啟用門檻 → 同月寫一次，UNIQUE 防重。
async function detectBelowThreshold() {
  const reports = await listAllCoachReports();
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const created = [];
  for (const r of reports) {
    for (const metric of r.failed_metrics || []) {
      const m = r.metrics[metric];
      const ins = await pool.query(
        `INSERT INTO eval_threshold_alerts
           (coach_id, metric, observed_value, min_value, window_months, period_month)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (coach_id, metric, period_month) DO NOTHING
         RETURNING *`,
        [r.id, metric, m?.value, m?.min_value, m?.window_months, month]
      );
      if (ins.rowCount) created.push({ ...ins.rows[0], coach_name: r.name });
    }
  }
  return created;
}

async function listPendingAlerts() {
  const r = await pool.query(
    `SELECT a.*, co.name AS coach_name
       FROM eval_threshold_alerts a JOIN coaches co ON co.id = a.coach_id
      WHERE a.notified_at IS NULL ORDER BY a.created_at DESC`
  );
  return r.rows;
}

async function markAlertNotified(id) {
  await pool.query(`UPDATE eval_threshold_alerts SET notified_at = NOW() WHERE id = $1`, [id]);
}

module.exports = {
  ensureInvitation, listForParent, getMine, submit,
  listInvitesForReminder, markReminderSent,
  coachReport, listAllCoachReports,
  thresholds, upsertThreshold,
  detectBelowThreshold, listPendingAlerts, markAlertNotified,
};
