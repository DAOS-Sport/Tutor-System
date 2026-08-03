/**
 * /api/coach-portal — 教練端 LINE OAuth web 登入模組（與家長端 /api/auth 完全分離）
 *
 * 比照排課系統可移植模板（LINE OAuth + Ragic H01 員工表比對），落在本系統的 JS + 原生 pg：
 *   §0 比對機制（三層 fallback）：
 *     A. LINE ID 直接命中  — coaches.line_uid == profile.userId（H01 同步時就已綁好）
 *     B. 姓名 fallback     — A miss → 用輸入姓名比對 coaches.name 且 is_active，綁定 line_uid 回該筆
 *     C. 查無              — 兩者皆 miss → 推播 IT 管理員（itAlert，可選）→ 404
 *
 * 身分表：直接重用既有 coaches（已由 ragicAdmin 同步含 name / line_uid / is_active）。
 * Session：成功後同時
 *     - 簽既有 12h coach JWT（讓現有 /api/coaches/* 的 requireCoach 不用改）
 *     - 發 30 天 portal session（coach_portal_sessions）供重開 App 免重走授權
 *
 * OAuth state / 登入後 handoff 一律落 DB（coach_oauth_states），多實例 / 重啟皆安全。
 * 長效 token 不放 URL：callback 後只帶一次性 handoff code，前端再 POST 換正式 token。
 *
 * 端點：
 *   GET  /auth/line/status            { configured }
 *   GET  /auth/line                   → 302 導向 LINE 授權
 *   GET  /auth/line/callback          → 比對 → 302 回 /liff/coach-portal?lineLogin=...
 *   GET  /auth/line/token-info/:token { displayName, pictureUrl }（給姓名表單打招呼用）
 *   POST /auth/exchange   { code }    → { coach, token, portalToken }（A 層命中換正式 token）
 *   POST /link-by-name    { token, name } → { coach, token, portalToken } | 404 | 409
 *   GET  /session                     （帶 x-coach-token）→ { coach, token } 換新 JWT
 *   POST /logout                      （帶 x-coach-token）→ { ok:true }
 */
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../models/db');
const { signCoachToken } = require('../middlewares/coachAuth');
const oauth = require('../services/coachOAuth');
const session = require('../services/coachPortalSession');
const itAlert = require('../services/itAlert');
const { cleanVenueList, COACH_STAFF_PROFILE_SELECT } = require('../services/coachVenueScope');

const router = express.Router();

const FRONTEND_PATH = '/liff/coach-portal';
const OAUTH_STATE_TTL_MIN = 10; // CSRF state 有效期
const HANDOFF_TTL_MIN = 5;      // callback 後一次性 handoff 有效期

// ── 簡易 per-IP 速率限制（與 routes/auth.js 同樣 5 / 5min；單機 MVP 夠用）──
const _attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;
function _rateLimited(ip) {
  const now = Date.now();
  const arr = (_attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  _attempts.set(ip, arr);
  if (_attempts.size > 5000) _attempts.clear();
  return arr.length > MAX_ATTEMPTS;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();
}

function stripCoachGovernanceFields(coach) {
  if (!coach) return coach;
  const { ragic_data_no, ...safe } = coach;
  return safe;
}

// ── OAuth state / handoff（DB-backed，coach_oauth_states）──
async function createState(kind, data, ttlMin) {
  const token = crypto.randomBytes(24).toString('base64url');
  await pool.query(
    `INSERT INTO coach_oauth_states (token, kind, data, expires_at)
     VALUES ($1, $2, $3::jsonb, NOW() + ($4 || ' minutes')::interval)`,
    [token, kind, JSON.stringify(data || {}), String(ttlMin)]
  );
  return token;
}
async function consumeState(token, kind) {
  if (!token) return null;
  const r = await pool.query(
    `DELETE FROM coach_oauth_states
      WHERE token = $1 AND kind = $2 AND expires_at > NOW()
      RETURNING data`,
    [token, kind]
  );
  return r.rowCount ? r.rows[0].data : null;
}
async function peekState(token, kind) {
  if (!token) return null;
  const r = await pool.query(
    `SELECT data FROM coach_oauth_states WHERE token = $1 AND kind = $2 AND expires_at > NOW()`,
    [token, kind]
  );
  return r.rowCount ? r.rows[0].data : null;
}

// ── 載入完整 coach（含 venue_ids + multiplier alias，與 coaches.js 一致）──
async function loadCoach(coachId) {
  const r = await pool.query(
    `SELECT ${COACH_STAFF_PROFILE_SELECT}
       FROM coaches c
       JOIN admin_staff s ON s.id = c.ragic_employee_id
      WHERE c.id = $1
        AND s.active = TRUE
        AND c.is_active = TRUE`,
    [coachId]
  );
  if (!r.rowCount) return null;
  const coach = stripCoachGovernanceFields(r.rows[0]);
  coach.multiplier = Number(coach.pricing_multiplier);
  coach.venue_ids = cleanVenueList(coach.venue_ids);
  coach.venues = coach.venue_ids;
  // [可教場館診斷] 印出 DB 端完整 venue_ids 陣列，定位「只顯示新北」是資料/API/前端哪一層
  console.log('[coach.venue_ids][db]', coachId, JSON.stringify(coach.venue_ids));
  return coach;
}

// 簽 12h JWT + 發 30天 portal session，回傳給前端的 payload（剝除 line_uid PII）
async function issueLogin(coach) {
  const token = signCoachToken({ coachId: coach.id, phone: coach.phone, lineUid: coach.line_uid || null });
  const portalToken = await session.issue(coach.id, coach.line_uid);
  const { line_uid, ragic_data_no, ...safe } = coach;
  // [可教場館診斷] 印出實際回給前端的 venue_ids
  console.log('[coach.venue_ids][login-payload]', safe.id, JSON.stringify(safe.venue_ids));
  return { coach: safe, token, portalToken };
}

function frontendRedirect(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.redirect(302, `${FRONTEND_PATH}?${qs}`);
}

// ─────────────────────────────────────────────────────────────
// GET /auth/line/status — 前端判斷是否可走 OAuth（未設 channel → 顯示提示而非空白）
// ─────────────────────────────────────────────────────────────
router.get('/auth/line/status', (req, res) => {
  // redirectUri / publicOrigin 為網址（非機密）：方便上線後直接從本端點看出
  // 「這個環境要白名單哪一條 callback」，免去猜正式網域。
  res.json({
    configured: oauth.isConfigured(),
    publicOrigin: oauth.publicOrigin(),
    redirectUri: oauth.redirectUri(),
  });
});

// ─────────────────────────────────────────────────────────────
// GET /auth/line — 產生 CSRF state → 導向 LINE 授權
// ─────────────────────────────────────────────────────────────
router.get('/auth/line', async (req, res) => {
  try {
    if (!oauth.isConfigured()) {
      return frontendRedirect(res, { error: 'not_configured' });
    }
    const state = await createState('csrf', {}, OAUTH_STATE_TTL_MIN);
    return res.redirect(302, oauth.buildAuthorizeUrl(state));
  } catch (err) {
    console.error('[coach-portal/auth/line]', err);
    return frontendRedirect(res, { error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /auth/line/callback — LINE 導回：驗 state → 換 token → 取 profile → 三層比對
// ─────────────────────────────────────────────────────────────
router.get('/auth/line/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.warn('[coach-portal/callback] LINE error:', error, req.query.error_description || '');
    return frontendRedirect(res, { error: 'line_denied' });
  }
  if (!code || !state) return frontendRedirect(res, { error: 'bad_request' });

  // 驗 CSRF state（一次性）
  const st = await consumeState(String(state), 'csrf');
  if (!st) return frontendRedirect(res, { error: 'bad_state' });

  let profile;
  try {
    const tok = await oauth.exchangeCodeForToken(String(code));
    profile = await oauth.getProfile(tok.access_token);
  } catch (err) {
    console.warn('[coach-portal/callback] oauth failed:', err.message);
    return frontendRedirect(res, { error: 'oauth_failed' });
  }
  const lineUid = profile?.userId;
  if (!lineUid) return frontendRedirect(res, { error: 'no_profile' });

  try {
    // ── A 層：line_uid 直接命中 ──
    const hit = await pool.query(
      `SELECT id FROM coaches WHERE line_uid = $1 AND is_active = TRUE LIMIT 1`,
      [lineUid]
    );
    if (hit.rowCount) {
      const codeTok = await createState('handoff',
        { status: 'existing', line_uid: lineUid }, HANDOFF_TTL_MIN);
      return frontendRedirect(res, { lineLogin: 'existing', code: codeTok });
    }
    // ── A miss → 交給前端走姓名 fallback（B 層）──
    const codeTok = await createState('handoff',
      { status: 'new', line_uid: lineUid,
        display_name: profile.displayName || '', picture_url: profile.pictureUrl || '' },
      HANDOFF_TTL_MIN);
    return frontendRedirect(res, { lineLogin: 'new', token: codeTok });
  } catch (err) {
    console.error('[coach-portal/callback] lookup failed:', err);
    return frontendRedirect(res, { error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /auth/line/token-info/:token — 姓名表單用：回 LINE 顯示名稱 / 頭像（不外露 line_uid）
// ─────────────────────────────────────────────────────────────
router.get('/auth/line/token-info/:token', async (req, res) => {
  const data = await peekState(req.params.token, 'handoff');
  if (!data || data.status !== 'new') {
    return res.status(404).json({ error: '連結已失效，請重新登入', code: 'HANDOFF_EXPIRED' });
  }
  res.json({ displayName: data.display_name || '', pictureUrl: data.picture_url || '' });
});

// ─────────────────────────────────────────────────────────────
// POST /auth/exchange { code } — A 層命中：一次性 handoff → 正式 token
// ─────────────────────────────────────────────────────────────
router.post('/auth/exchange', async (req, res) => {
  try {
    const data = await consumeState(String(req.body?.code || ''), 'handoff');
    if (!data || data.status !== 'existing') {
      return res.status(400).json({ error: '登入連結已失效，請重新登入', code: 'HANDOFF_INVALID' });
    }
    const r = await pool.query(
      `SELECT id FROM coaches WHERE line_uid = $1 AND is_active = TRUE LIMIT 1`,
      [data.line_uid]
    );
    if (!r.rowCount) {
      return res.status(404).json({ error: '查無教練資料', code: 'COACH_NOT_FOUND' });
    }
    const coach = await loadCoach(r.rows[0].id);
    session.cleanupExpired();
    return res.json(await issueLogin(coach));
  } catch (err) {
    console.error('[coach-portal/exchange]', err);
    res.status(500).json({ error: '登入失敗', code: 'EXCHANGE_FAILED' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /link-by-name { token, name } — B 層：姓名 fallback 綁定
//   200 { coach, token, portalToken }
//   404 COACH_NOT_FOUND（查無 → 已推播 IT）
//   409 NAME_ALREADY_BOUND（該姓名教練已綁別的 LINE） / NAME_AMBIGUOUS（同名多筆）
// ─────────────────────────────────────────────────────────────
router.post('/link-by-name', async (req, res) => {
  const ip = clientIp(req);
  if (_rateLimited(ip)) {
    return res.status(429).json({ error: '嘗試次數過多，請稍後再試', code: 'RATE_LIMITED' });
  }
  try {
    const data = await consumeState(String(req.body?.token || ''), 'handoff');
    if (!data || data.status !== 'new') {
      return res.status(400).json({ error: '登入連結已失效，請重新登入', code: 'HANDOFF_INVALID' });
    }
    const lineUid = data.line_uid;
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '請輸入姓名', code: 'NAME_REQUIRED' });

    // 0) 該 line_uid 其實已綁某教練（理論上 A 層會先命中，但防並發 / 重試）→ 直接登入
    const already = await pool.query(
      `SELECT id FROM coaches WHERE line_uid = $1 AND is_active = TRUE LIMIT 1`, [lineUid]);
    if (already.rowCount) {
      const coach = await loadCoach(already.rows[0].id);
      return res.json(await issueLogin(coach));
    }

    // 1) 候選：在職、未綁、姓名精準相符
    const cand = await pool.query(
      `SELECT id FROM coaches
        WHERE name = $1 AND is_active = TRUE AND COALESCE(line_uid,'') = ''`,
      [name]
    );

    if (cand.rowCount === 1) {
      // 綁定（再次以 line_uid IS NULL 為條件，防並發兩人同時綁同一筆）
      let bound;
      try {
        bound = await pool.query(
          `UPDATE coaches SET line_uid = $1, updated_at = NOW()
            WHERE id = $2 AND COALESCE(line_uid,'') = ''
            RETURNING id`,
          [lineUid, cand.rows[0].id]
        );
      } catch (e) {
        // line_uid UNIQUE 衝突（此 LINE 已被其他教練佔用）
        console.warn('[coach-portal/link-by-name] bind conflict:', e.message);
        return res.status(409).json({
          error: '此 LINE 帳號已綁定其他教練，請聯絡管理員', code: 'LINE_ALREADY_BOUND',
        });
      }
      if (!bound.rowCount) {
        // 並發落敗：該筆已被綁。重查該 line_uid 是否就是本人
        const re = await pool.query(
          `SELECT id FROM coaches WHERE line_uid = $1 AND is_active = TRUE LIMIT 1`, [lineUid]);
        if (re.rowCount) return res.json(await issueLogin(await loadCoach(re.rows[0].id)));
        return res.status(409).json({ error: '綁定衝突，請重新登入', code: 'BIND_RACE' });
      }
      const coach = await loadCoach(cand.rows[0].id);
      console.log(`[coach-portal] 姓名 fallback 綁定成功 coach=${coach.id} name=${name}`);
      return res.json(await issueLogin(coach));
    }

    if (cand.rowCount > 1) {
      return res.status(409).json({
        error: '系統有多位同名教練，請聯絡管理員協助綁定', code: 'NAME_AMBIGUOUS',
      });
    }

    // cand === 0：同名教練是否「已綁別的 LINE」？
    const boundOther = await pool.query(
      `SELECT line_uid FROM coaches
        WHERE name = $1 AND is_active = TRUE
          AND COALESCE(line_uid,'') <> '' AND line_uid <> $2 LIMIT 1`,
      [name, lineUid]
    );
    if (boundOther.rowCount) {
      // 這條路徑原本完全靜默 → production 上教練回報「登不進去」時，
      // log 裡查不到他實際用哪支 LINE、DB 存的又是哪一支，無從判斷是
      // 「他換了 LINE」還是「UID 被別人搶綁 / HR 貼錯」。
      // 只印尾 4 碼（不外露完整 UID），足以比對兩者是否為同一支。
      const dbUid = String(boundOther.rows[0].line_uid || '');
      console.warn('[coach-portal] NAME_ALREADY_BOUND', {
        name,
        incoming_uid_tail: `***${String(lineUid).slice(-4)}`,
        db_uid_tail: `***${dbUid.slice(-4)}`,
        hint: '兩者尾碼不同即代表登入者與 DB 綁定的不是同一支 LINE，需由後台解除綁定後重綁',
      });
      return res.status(409).json({
        error: '此姓名的教練已綁定其他 LINE，請聯絡管理員', code: 'NAME_ALREADY_BOUND',
      });
    }

    // ── C 層：真的查無 → 推播 IT（可選，graceful）→ 404 ──
    itAlert.pushCoachUnbound({ lineUid, displayName: data.display_name, name });
    return res.status(404).json({
      error: '查無此姓名的教練資料，已通知管理員協助處理', code: 'COACH_NOT_FOUND',
    });
  } catch (err) {
    console.error('[coach-portal/link-by-name]', err);
    res.status(500).json({ error: '綁定失敗', code: 'LINK_FAILED' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /session — 帶 30天 portal token（x-coach-token）→ 換發新 12h JWT（App 重開用）
// ─────────────────────────────────────────────────────────────
router.get('/session', async (req, res) => {
  try {
    const token = session.readToken(req);
    const row = await session.verify(token);
    if (!row) return res.status(401).json({ error: 'session 已失效', code: 'SESSION_INVALID' });
    const coach = await loadCoach(row.coach_id);
    if (!coach) return res.status(404).json({ error: '查無教練資料', code: 'COACH_NOT_FOUND' });
    const jwt = signCoachToken({ coachId: coach.id, phone: coach.phone, lineUid: coach.line_uid || null });
    const { line_uid, ragic_data_no, ...safe } = coach;
    res.json({ coach: safe, token: jwt });
  } catch (err) {
    console.error('[coach-portal/session]', err);
    res.status(500).json({ error: 'session 還原失敗', code: 'SESSION_FAILED' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /logout — 撤銷 portal session
// ─────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    await session.revoke(session.readToken(req));
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: true }); // 撤銷失敗也視為已登出
  }
});

module.exports = router;
