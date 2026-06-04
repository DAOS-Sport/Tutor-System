/**
 * coaches API（教練主檔）
 * - GET  /api/coaches                            列表（公開：家長端選擇教練）
 * - GET  /api/coaches/by-phone?phone=09xxxx      LIFF 教練端登入：回傳 coach 資訊 + JWT token
 * - GET  /api/coaches/:id                        單筆細節（公開：家長端選擇教練看 bio）
 * - PUT  /api/coaches/:id/bio                    教練自編 bio（須登入且本人）
 * - GET  /api/coaches/:id/media                  介紹媒體列表（公開）
 * - POST /api/coaches/:id/media                  新增介紹媒體（須登入且本人）
 * - PATCH /api/coaches/:id/media/reorder         排序（須登入且本人）
 * - DELETE /api/coaches/:id/media/:mediaId       刪除（須登入且本人）
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { signCoachToken, requireCoach, requireCoachOwner, byPhoneRateLimit, byLineUidRateLimit, logFailedLogin } = require('../middlewares/coachAuth');
const { verifyLineIdToken, isLineVerificationRequired } = require('../services/lineAuth');

/**
 * 將 DB 欄位 pricing_multiplier 同時對外曝露為 multiplier，
 * 維持與既有家長端 (CoachCard, useEnrollmentPricing) 的相容性。
 */
function withMultiplierAlias(row) {
  if (!row) return row;
  const pm = row.pricing_multiplier;
  return { ...row, multiplier: pm == null ? 1 : Number(pm) };
}

async function loadCoach(id) {
  const r = await pool.query(
    `SELECT c.*, COALESCE(
       (SELECT json_agg(cv.venue_id) FROM coach_venues cv WHERE cv.coach_id = c.id),
       '[]'::json
     ) AS venue_ids
     FROM coaches c WHERE c.id = $1`,
    [id]
  );
  return withMultiplierAlias(r.rows[0]) || null;
}

router.get('/', async (req, res) => {
  const { venueId } = req.query;
  try {
    const r = venueId
      ? await pool.query(
          `SELECT c.id, c.name, c.is_senior, c.pricing_multiplier, c.bio_rich_text
           FROM coaches c
           JOIN coach_venues cv ON cv.coach_id = c.id
           WHERE cv.venue_id = $1 AND c.is_active = TRUE
           ORDER BY c.name`,
          [venueId]
        )
      : await pool.query(
          `SELECT id, name, is_senior, pricing_multiplier, bio_rich_text
           FROM coaches WHERE is_active = TRUE ORDER BY name`
        );
    res.json(r.rows.map(withMultiplierAlias));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 教練端登入：手機 + （生產環境）LINE id_token 雙因素驗證
 *
 * 流程：
 *   1) 必填 phone 在 H01 (coaches.phone) 找到啟用中的教練
 *   2) 若 LINE 驗證為必要 (NODE_ENV=production 或 REQUIRE_LINE_ID_TOKEN=1)：
 *      - 必填 id_token，呼叫 LINE Verify API → 取出 sub (line_uid)
 *      - 若 coach.line_uid IS NULL → 首次綁定（寫回 DB）
 *      - 若 coach.line_uid 已存在 → 必須與 sub 完全相符；不符 → 403
 *   3) 若非生產環境且未提供 id_token → 走 phone-only 後備路徑（並 console.warn）
 *   4) 簽發短期 (12h) JWT，payload 包含 lineUid（若有）
 */
/**
 * 教練端 by-phone 登入（dev 後援 + production 未綁定提示）
 *
 * production / REQUIRE_LINE_ID_TOKEN=1：
 *   - 不允許用手機做首次綁定。教練必須先在 Ragic H01「個人LINE ID」或後台
 *     完成綁定，本端只能比對／驗證。
 *   - 手機存在但 coach.line_uid 為空 → 403 COACH_LINE_NOT_BOUND
 *   - coach.line_uid 與 verified sub 不符 → 403 COACH_LINE_MISMATCH
 * dev (NODE_ENV != production 且 REQUIRE_LINE_ID_TOKEN != 1)：
 *   - 保留 phone-only fallback，console.warn 記錄
 */
const UNBOUND_MSG = '尚未完成綁定，請截圖傳送結果至 400 官方帳號';

router.get('/by-phone', byPhoneRateLimit, async (req, res) => {
  const phone = req.query.phone;
  const idToken = req.query.id_token || req.headers['x-line-id-token'];
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  try {
    const r = await pool.query(
      `SELECT c.*, COALESCE(
         (SELECT json_agg(cv.venue_id) FROM coach_venues cv WHERE cv.coach_id = c.id),
         '[]'::json
       ) AS venue_ids
       FROM coaches c WHERE c.phone = $1 AND c.is_active = TRUE`,
      [phone]
    );
    if (r.rows.length === 0) {
      logFailedLogin(ip, phone, 'phone-not-found');
      return res.status(404).json({ error: 'not found', code: 'COACH_NOT_FOUND' });
    }
    let coach = withMultiplierAlias(r.rows[0]);

    // ── LINE id_token 驗證 ──
    let verifiedLineUid = null;
    if (idToken) {
      try {
        const lineProfile = await verifyLineIdToken(idToken);
        verifiedLineUid = lineProfile.sub;
      } catch (err) {
        logFailedLogin(ip, phone, `line-verify-failed: ${err.message}`);
        return res.status(401).json({
          error: `LINE 身分驗證失敗：${err.message}`,
          code: 'LINE_VERIFY_FAILED',
        });
      }
    } else if (isLineVerificationRequired()) {
      logFailedLogin(ip, phone, 'missing-id-token');
      return res.status(401).json({
        error: 'LINE id_token is required in this environment',
        code: 'LINE_ID_TOKEN_REQUIRED',
      });
    } else {
      // 避免 PII 落 production log：phone 只記前 4 碼
      const maskedPhone = phone ? `${String(phone).slice(0, 4)}****` : 'n/a';
      console.warn(`[coachAuth] phone-only fallback (dev): ip=${ip} phone=${maskedPhone}`);
    }

    // ── production / REQUIRE_LINE_ID_TOKEN=1：禁止 by-phone 首次綁定 ──
    if (isLineVerificationRequired()) {
      if (!coach.line_uid) {
        logFailedLogin(ip, phone, 'coach-line-not-bound (production no-first-bind)');
        return res.status(403).json({
          error: UNBOUND_MSG,
          code: 'COACH_LINE_NOT_BOUND',
        });
      }
      if (verifiedLineUid && String(coach.line_uid) !== String(verifiedLineUid)) {
        // 不可在 log 寫完整 line_uid（PII）→ 只記末 4 碼
        const mask = (v) => (v ? `***${String(v).slice(-4)}` : 'null');
        logFailedLogin(ip, phone, `line_uid-mismatch: stored=${mask(coach.line_uid)} vs verified=${mask(verifiedLineUid)}`);
        return res.status(403).json({
          error: '此手機綁定的 LINE 帳號與目前登入的 LINE 不符，請聯繫管理員',
          code: 'COACH_LINE_MISMATCH',
        });
      }
    } else if (verifiedLineUid) {
      // dev 模式：可選首次綁定（保留原有行為）
      if (coach.line_uid && String(coach.line_uid) !== String(verifiedLineUid)) {
        logFailedLogin(ip, phone, `line_uid-mismatch: stored=${coach.line_uid} vs verified=${verifiedLineUid}`);
        return res.status(403).json({
          error: '此手機已綁定不同的 LINE 帳號，請聯繫管理員',
          code: 'COACH_LINE_MISMATCH',
        });
      }
      if (!coach.line_uid) {
        await pool.query(`UPDATE coaches SET line_uid = $1, updated_at = NOW() WHERE id = $2`,
          [verifiedLineUid, coach.id]);
        coach.line_uid = verifiedLineUid;
        console.log(`[coachAuth] (dev) bound line_uid for coach=${coach.id}`);
      }
    }

    const token = signCoachToken({ coachId: coach.id, phone: coach.phone, lineUid: coach.line_uid || null });
    res.json({ ...coach, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 教練端 LIFF 自動登入（Task #34）
 *  GET /api/coaches/by-line-uid?lineUid=Uxxx  + header X-Line-Id-Token: <id_token>
 *  - 必填 lineUid + id_token；verifyLineIdToken(idToken).sub 必須等於 lineUid（防偽造）
 *  - 找 coach where line_uid=$1 AND is_active=TRUE → 簽 token；找不到回 404（讓前端 fallback 手機）
 */
router.get('/by-line-uid', byLineUidRateLimit, async (req, res) => {
  const lineUid = req.query.lineUid;
  // 安全考量：id_token 僅接受 header（X-Line-Id-Token），不接受 query string
  // — 避免在 access log / proxy / referrer 留下可重放的有效 token
  const idToken = req.headers['x-line-id-token'];
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();
  if (!lineUid) return res.status(400).json({ error: 'lineUid is required' });
  if (!idToken) {
    logFailedLogin(ip, `lineUid=${lineUid}`, 'missing-id-token');
    return res.status(401).json({ error: 'LINE id_token is required' });
  }
  try {
    let verifiedSub;
    try {
      const profile = await verifyLineIdToken(idToken);
      verifiedSub = profile.sub;
    } catch (err) {
      logFailedLogin(ip, `lineUid=${lineUid}`, `line-verify-failed: ${err.message}`);
      return res.status(401).json({ error: `LINE 身分驗證失敗：${err.message}` });
    }
    if (String(verifiedSub) !== String(lineUid)) {
      logFailedLogin(ip, `lineUid=${lineUid}`, `sub-mismatch verified=${verifiedSub}`);
      return res.status(401).json({ error: 'lineUid 與 id_token sub 不符' });
    }
    const r = await pool.query(
      `SELECT c.*, COALESCE(
         (SELECT json_agg(cv.venue_id) FROM coach_venues cv WHERE cv.coach_id = c.id),
         '[]'::json
       ) AS venue_ids
       FROM coaches c WHERE c.line_uid = $1 AND c.is_active = TRUE`,
      [lineUid]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({
        error: UNBOUND_MSG,
        code: 'COACH_LINE_NOT_BOUND',
      });
    }
    const coach = withMultiplierAlias(r.rows[0]);
    const token = signCoachToken({ coachId: coach.id, phone: coach.phone, lineUid: coach.line_uid });
    res.json({ ...coach, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    // 非 uuid（例如前端深連結帶到 /coaches/null）→ 回 404，避免 postgres 拋 uuid 語法錯誤變假性 500
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(String(req.params.id || ''))) {
      return res.status(404).json({ error: 'not found' });
    }
    const c = await loadCoach(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/bio', requireCoach, requireCoachOwner('id'), async (req, res) => {
  const { bio_rich_text } = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE coaches SET bio_rich_text = $1,
                         intro_review_status = 'pending_review',
                         intro_submitted_at = NOW(),
                         updated_at = NOW()
       WHERE id = $2 RETURNING id, bio_rich_text, intro_review_status`,
      [bio_rich_text || '', req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/media', async (req, res) => {
  const r = await pool.query(
    `SELECT id, media_type, storage_url, alt_text, sort_order
     FROM coach_bio_media WHERE coach_id = $1 ORDER BY sort_order, created_at`,
    [req.params.id]
  );
  res.json(r.rows);
});

router.post('/:id/media', requireCoach, requireCoachOwner('id'), async (req, res) => {
  const { storage_url, alt_text = '', media_type = 'image' } = req.body || {};
  if (!storage_url) return res.status(400).json({ error: 'storage_url is required' });
  const max = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM coach_bio_media WHERE coach_id = $1`,
    [req.params.id]
  );
  const r = await pool.query(
    `INSERT INTO coach_bio_media (coach_id, media_type, storage_url, alt_text, sort_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.params.id, media_type, storage_url, alt_text, max.rows[0].m + 1]
  );
  res.status(201).json(r.rows[0]);
});

router.patch('/:id/media/reorder', requireCoach, requireCoachOwner('id'), async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids[] required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        `UPDATE coach_bio_media SET sort_order = $1 WHERE id = $2 AND coach_id = $3`,
        [i, ids[i], req.params.id]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: ids.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/:id/media/:mediaId', requireCoach, requireCoachOwner('id'), async (req, res) => {
  const r = await pool.query(
    `DELETE FROM coach_bio_media WHERE id = $1 AND coach_id = $2 RETURNING id`,
    [req.params.mediaId, req.params.id]
  );
  if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

module.exports = router;
