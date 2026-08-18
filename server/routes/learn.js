/**
 * /api/learn — 學習歷程 HTTP API
 *
 *  ── 教練端（requireCoach） ──
 *   GET    /plans/:periodId
 *   PUT    /plans/:periodId            { goals, expected_outcomes, learning_plan, initial_assessment, notes }
 *   POST   /plans/:periodId/publish
 *   GET    /records/by-session/:sessionId
 *   PUT    /records/by-session/:sessionId  { summary, highlights, improvements, homework, media[], tags[] }
 *   POST   /records/by-session/:sessionId/submit
 *   GET    /records/by-session/:sessionId/copy-prev
 *   GET    /records/by-session/:sessionId/versions
 *   GET    /tags                        系統 + 教練個人標籤
 *   POST   /personal-tags               { label, text_template }
 *   DELETE /personal-tags/:id
 *
 *  ── 家長端（requireParent） ──
 *   GET    /history/:periodId           檢視該期 lesson plan + 已送出 records
 *
 *  ── 共用上傳 ──
 *   POST   /uploads                     multipart file → 回 { url, mime, name, size }
 *                                        （供授課記錄媒體欄位使用，限 coach）
 */
const express = require('express');
const { singleUpload } = require('../middlewares/uploadError');
const multer = require('multer');
const { pool } = require('../models/db');
const { requireCoach } = require('../middlewares/coachAuth');
const { requireParent } = require('../middlewares/parentAuth');
const learning = require('../services/learning');
const { saveBuffer, ALLOWED_MAX_BYTES } = require('../services/objectStorage');
const line = require('../services/line');
const { formatPlainDate } = require('../utils/dateTime');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ALLOWED_MAX_BYTES } });

// multer 自己丟的錯（例如檔案過大）沒有 .status，不包的話會掉到全域
// 錯誤處理變成 500 + 英文訊息。實測 6MB 頭像回 500 "File too large"。
const uploadFile = singleUpload(upload, ALLOWED_MAX_BYTES);

function handle(err, res, where) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error(`[learn ${where}]`, err);
  res.status(500).json({ error: 'internal error' });
}

// ── 課前規劃 ──────────────────────────────
router.get('/plans/:periodId', requireCoach, async (req, res) => {
  try {
    const r = await pool.query('SELECT coach_id FROM course_periods WHERE id = $1', [req.params.periodId]);
    if (!r.rowCount) return res.status(404).json({ error: 'period not found' });
    if (String(r.rows[0].coach_id) !== String(req.coach.id))
      return res.status(403).json({ error: 'Forbidden' });
    const plan = await learning.getPlan(req.params.periodId);
    res.json(plan);
  } catch (e) { handle(e, res, 'GET plan'); }
});

router.put('/plans/:periodId', requireCoach, async (req, res) => {
  try {
    const plan = await learning.upsertPlan(req.params.periodId, req.coach.id, req.body || {});
    res.json(plan);
  } catch (e) { handle(e, res, 'PUT plan'); }
});

router.post('/plans/:periodId/publish', requireCoach, async (req, res) => {
  try {
    const plan = await learning.publishPlan(req.params.periodId, req.coach.id);
    if (!plan) return res.status(404).json({ error: 'plan not found' });
    // 通知家長（best effort，不阻塞）
    notifyPlanPublished(req.params.periodId).catch((e) => console.warn('[learn] notify plan failed:', e.message));
    res.json(plan);
  } catch (e) { handle(e, res, 'POST publish'); }
});

// ── 授課記錄 ──────────────────────────────
router.get('/records/by-session/:sessionId', requireCoach, async (req, res) => {
  try {
    const sess = await pool.query(
      `SELECT COALESCE(cs.coach_id, cp.coach_id) AS coach_id FROM course_sessions cs JOIN course_periods cp ON cp.id = cs.course_period_id WHERE cs.id = $1`,
      [req.params.sessionId]
    );
    if (!sess.rowCount) return res.status(404).json({ error: 'session not found' });
    if (String(sess.rows[0].coach_id) !== String(req.coach.id))
      return res.status(403).json({ error: 'Forbidden' });
    const rec = await learning.getRecord(req.params.sessionId);
    res.json(rec);
  } catch (e) { handle(e, res, 'GET record'); }
});

router.put('/records/by-session/:sessionId', requireCoach, async (req, res) => {
  try {
    const rec = await learning.upsertRecord(req.params.sessionId, req.coach.id, req.body || {});
    res.json(rec);
  } catch (e) { handle(e, res, 'PUT record'); }
});

router.post('/records/by-session/:sessionId/submit', requireCoach, async (req, res) => {
  try {
    const rec = await learning.submitRecord(req.params.sessionId, req.coach.id);
    notifyRecordSubmitted(req.params.sessionId).catch((e) => console.warn('[learn] notify record failed:', e.message));
    res.json(rec);
  } catch (e) { handle(e, res, 'POST submit'); }
});

router.get('/records/by-session/:sessionId/copy-prev', requireCoach, async (req, res) => {
  try {
    const prev = await learning.copyPrev(req.params.sessionId, req.coach.id);
    res.json(prev);
  } catch (e) { handle(e, res, 'GET copy-prev'); }
});

router.get('/records/by-session/:sessionId/versions', requireCoach, async (req, res) => {
  try {
    // Ownership check: only the assigned coach can read version history.
    const ok = await learning.coachOwnsSession(req.params.sessionId, req.coach.id);
    if (!ok) return res.status(403).json({ error: '此課程不屬於您' });
    const list = await learning.listVersions(req.params.sessionId);
    res.json(list);
  } catch (e) { handle(e, res, 'GET versions'); }
});

// ── 標籤庫 ────────────────────────────────
router.get('/tags', requireCoach, async (req, res) => {
  try { res.json(await learning.listTags(req.coach.id)); }
  catch (e) { handle(e, res, 'GET tags'); }
});

router.post('/personal-tags', requireCoach, async (req, res) => {
  try {
    const t = await learning.addPersonalTag(req.coach.id, req.body || {});
    res.status(201).json(t);
  } catch (e) { handle(e, res, 'POST personal-tags'); }
});

router.delete('/personal-tags/:id', requireCoach, async (req, res) => {
  try {
    const ok = await learning.removePersonalTag(req.coach.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { handle(e, res, 'DELETE personal-tags'); }
});

// ── 家長端：學習歷程 ────────────────────────
router.get('/history/:periodId', requireParent, async (req, res) => {
  try {
    // 防呆：course_period_id 為 UUID 欄位。若傳進非 UUID（例如舊前端誤帶 admin_enrollment id
    // 'EMPXS...'），直接回 404，避免 Postgres 22P02 型別錯誤被當成 500「載入失敗」。
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.periodId || '')) {
      return res.status(404).json({ error: '查無此課程' });
    }
    const guard = await pool.query(
      `SELECT 1 FROM course_period_enrollments e
       JOIN students s ON s.id = e.student_id
       WHERE e.course_period_id = $1 AND s.parent_id = $2
         AND e.status IN ('active','transferred_out') LIMIT 1`,
      [req.params.periodId, req.parent.id]
    );
    if (!guard.rowCount) return res.status(403).json({ error: 'Forbidden' });
    const data = await learning.listLearningHistory(req.params.periodId);
    res.json(data);
  } catch (e) { handle(e, res, 'GET history'); }
});

// ── 媒體上傳（教練上傳授課記錄附件） ───────────
router.post('/uploads', requireCoach, uploadFile, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const out = await saveBuffer({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
    });
    res.json({ url: out.url, mime: req.file.mimetype, name: req.file.originalname, size: req.file.size });
  } catch (e) { handle(e, res, 'POST uploads'); }
});

// ── 通知 helpers（best-effort） ──────────────
async function notifyPlanPublished(periodId) {
  const r = await pool.query(
    `SELECT cp.venue_id, co.name AS coach_name,
            ARRAY(SELECT DISTINCT pa.line_uid FROM course_period_enrollments e
                    JOIN students s ON s.id = e.student_id
                    JOIN parents pa ON pa.id = s.parent_id
                   WHERE e.course_period_id = cp.id AND e.status = 'active' AND pa.line_uid IS NOT NULL) AS uids
       FROM course_periods cp JOIN coaches co ON co.id = cp.coach_id WHERE cp.id = $1`,
    [periodId]
  );
  if (!r.rowCount) return;
  const { venue_id, coach_name, uids } = r.rows[0];
  if (!uids || uids.length === 0) return;
  const liffUrl = (process.env.LIFF_URL_PARENT || process.env.LIFF_URL || 'https://liff.line.me/-') + `/history/${periodId}`;
  const msg = line.templates.coursePlanPublished({ coachName: coach_name, liffUrl });
  for (const uid of uids) {
    try { await line.pushMessage(uid, msg, venue_id); }
    catch (e) { console.warn('[learn] push plan to', uid, e.message); }
  }
}

async function notifyRecordSubmitted(sessionId) {
  const r = await pool.query(
    `SELECT cp.venue_id, cp.id AS period_id, co.name AS coach_name, cs.scheduled_at,
            ARRAY(SELECT DISTINCT pa.line_uid FROM course_period_enrollments e
                    JOIN students s ON s.id = e.student_id
                    JOIN parents pa ON pa.id = s.parent_id
                   WHERE e.course_period_id = cp.id AND e.status = 'active' AND pa.line_uid IS NOT NULL) AS uids
       FROM course_sessions cs JOIN course_periods cp ON cp.id = cs.course_period_id
       LEFT JOIN coaches co ON co.id = COALESCE(cs.coach_id, cp.coach_id) WHERE cs.id = $1`,
    [sessionId]
  );
  if (!r.rowCount) return;
  const row = r.rows[0];
  if (!row.uids || row.uids.length === 0) return;
  const [, month, day] = formatPlainDate(row.scheduled_at).split('-');
  const dateStr = `${Number(month)}/${Number(day)}`;
  const liffUrl = (process.env.LIFF_URL_PARENT || process.env.LIFF_URL || 'https://liff.line.me/-') + `/history/${row.period_id}`;
  const msg = line.templates.sessionRecordPublished({ coachName: row.coach_name, sessionDate: dateStr, liffUrl });
  for (const uid of row.uids) {
    try { await line.pushMessage(uid, msg, row.venue_id); }
    catch (e) { console.warn('[learn] push record to', uid, e.message); }
  }
}

module.exports = router;
