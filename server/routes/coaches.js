/**
 * coaches API（教練主檔）
 * - GET  /api/coaches                            列表（**須登入**：家長或教練 token）
 * - GET  /api/coaches/by-phone?phone=09xxxx      LIFF 教練端登入：回傳 coach 資訊 + JWT token
 * - GET  /api/coaches/:id                        單筆細節（公開：家長端選擇教練看 bio）
 * - PUT  /api/coaches/:id/bio                    教練自編 bio（須登入且本人）
 * - GET  /api/coaches/:id/media                  介紹媒體列表（公開）
 * - POST /api/coaches/:id/media                  新增介紹媒體（須登入且本人）
 * - POST /api/coaches/:id/media/upload           上傳圖片並新增介紹媒體（須登入且本人）
 * - GET  /api/coaches/:id/media                  介紹圖片清單（須登入且本人）
 * - POST /api/coaches/:id/avatar                 上傳大頭照（須登入且本人）
 * - DELETE /api/coaches/:id/avatar               移除大頭照（須登入且本人）
 * - PATCH /api/coaches/:id/media/reorder         排序（須登入且本人）
 * - DELETE /api/coaches/:id/media/:mediaId       刪除（須登入且本人）
 */
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { pool } = require('../models/db');
const { signCoachToken, requireCoach, requireCoachOwner, byPhoneRateLimit, byLineUidRateLimit, logFailedLogin } = require('../middlewares/coachAuth');
const jwt = require('jsonwebtoken');
const { getSecret: getJwtSecret } = require('../middlewares/adminAuth');
const guaiGuai = require('../middlewares/guaiGuai');
const { verifyLineIdToken, isLineVerificationRequired } = require('../services/lineAuth');
const { saveBuffer } = require('../services/objectStorage');
const {
  cleanVenueText,
  cleanVenueList,
  COACH_VENUE_SOURCE_SQL,
  COACH_STAFF_PROFILE_SELECT,
} = require('../services/coachVenueScope');

const MEDIA_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_UPLOAD_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('只接受 JPG / PNG 圖片'), { status: 400 }));
  },
});

/**
 * 將 DB 欄位 pricing_multiplier 同時對外曝露為 multiplier，
 * 維持與既有家長端 (CoachCard, useEnrollmentPricing) 的相容性。
 */
function withMultiplierAlias(row) {
  if (!row) return row;
  const pm = row.pricing_multiplier;
  const { ragic_data_no, ...safe } = row;
  const multiplier = pm == null ? 1 : Number(pm);
  return {
    ...safe,
    multiplier,
    // API 邊界再做一次衍生，確保任何舊查詢／舊資料都遵守「倍率 != 1 即資深」。
    is_senior: Number.isFinite(multiplier) && multiplier !== 1,
  };
}

function normalizeCoach(row) {
  const coach = withMultiplierAlias(row);
  if (!coach) return coach;
  const venueIds = cleanVenueList(coach.venue_ids || coach.venues || []);
  return {
    ...coach,
    bio: coach.bio || coach.bio_rich_text || '',
    venue_ids: venueIds,
    venues: venueIds,
  };
}

/**
 * 公開端點（GET /coaches、GET /coaches/:id）的欄位過濾。**白名單，不是黑名單。**
 *
 * ── 為什麼改成白名單（2026-08-11）──
 * 原本寫成 `const { line_uid, staff_active, coach_profile_active, ...safe } = coach`
 * ——只剝掉三個、其餘全放行。結果這兩支不需要登入的端點一次回出全體在職教練的
 * 手機、Email、員工編號：實測正式站 165 位教練、165 支手機、138 個 Email、
 * 165 個員工編號，未帶任何憑證即可取得。
 *
 * 更糟的是它會自己惡化：只要有人往 COACH_STAFF_PROFILE_SELECT 加一個欄位，
 * 這裡就自動多洩一個。`intro_review_note`（主管寫的內部退回原因）就是這樣混進來的。
 *
 * 白名單反過來 fail-closed：新欄位預設不外露，要露必須有人明確加進這份清單。
 *
 * ── 清單依據 ──
 * 掃過 client/liff 全部消費端（CoachListPage、RegisterPage、useEnrollmentBoot、
 * CoachScheduleWeekPage、ReferralPage）實際讀到的欄位。admin 端走自己的
 * 已認證 API，不吃這支。
 *
 * **不要**把下列加回來：phone / email / line_uid / ragic_*（個資與內部編號）、
 * intro_review_note / intro_reviewed_by（主管內部評語）。
 * 教練要看自己的退回原因，走下面那支需要登入的 GET /:id/private。
 */
const PUBLIC_COACH_FIELDS = [
  'id',
  'name',
  'specialties',
  'is_senior',
  'pricing_multiplier',
  'multiplier',          // pricing_multiplier 的別名，前端兩種都在讀
  'bio',
  'bio_rich_text',
  'avatar_url',          // 相對路徑；家長端小卡要畫，沒有就退回姓名首字
  'intro_review_status', // 只是「已發布／審核中」的狀態，不含評語內容
  'venue_ids',
  'venues',
];

function publicCoach(row) {
  const coach = normalizeCoach(row);
  if (!coach) return coach;
  const safe = {};
  for (const k of PUBLIC_COACH_FIELDS) {
    if (coach[k] !== undefined) safe[k] = coach[k];
  }
  return safe;
}

async function resolveVenueFilterCandidates(value) {
  const q = cleanVenueText(value);
  if (!q) return [];
  const r = await pool.query(
    `SELECT id
       FROM venues
      WHERE TRIM(id) = $1
         OR TRIM(name) = $1
         OR TRIM(COALESCE(full_name, '')) = $1
         OR TRIM(name) ILIKE '%' || $1 || '%'
         OR TRIM(COALESCE(full_name, '')) ILIKE '%' || $1 || '%'`,
    [q]
  );
  return cleanVenueList([q, ...r.rows.map((row) => row.id)]);
}

async function loadCoach(id) {
  const r = await pool.query(
    `SELECT ${COACH_STAFF_PROFILE_SELECT}
     FROM coaches c
     JOIN admin_staff s ON s.id = c.ragic_employee_id
     WHERE c.id = $1 AND s.active = TRUE AND c.is_active = TRUE
       AND (COALESCE(c.is_placeholder, FALSE) = TRUE
            OR TRIM(COALESCE(c.name, '')) NOT IN ('待分配', '01待分配'))`,
    [id]
  );
  return publicCoach(r.rows[0]) || null;
}

/**
 * 教練清單需要登入（家長或教練皆可）。
 *
 * 為什麼從公開改成需登入：這支會一次吐出全部在職教練的姓名、任職場館、
 * 資深標記、價格倍率與介紹審核狀態 —— 正式站實測 165 筆。任何人貼上網址
 * 就能把全公司的教練名冊連同計價資訊抓走，而且可以定時抓來看人員異動。
 * 早先那次修補只擋掉了電話與 Email（白名單），沒有處理「可以整包枚舉」這件事。
 *
 * 為什麼關掉不會弄壞前台：實際呼叫這支的兩個頁面（CoachListPage、ReferralPage）
 * 都在 <RequireAuth> + <RequireParent> 底下，本來就登入後才進得去，
 * 前端呼叫時已經帶著 token。未登入時會用到的是 GET /coaches/:id
 * （推薦連結流程），那支維持開放 —— 它要 UUID 才查得到，不能枚舉。
 */
function requireParentOrCoach(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return guaiGuai.deny(req, res, '教練清單需要登入後才能查看。');
  try {
    const payload = jwt.verify(token, getJwtSecret());
    // 只認這兩種身分。admin token 走的是 /api/admin 底下那一整套（有場館範圍與稽核），
    // 不從這裡開後門。
    // 註：這行刻意不寫成萬用字元路徑 —— 行註解裡出現區塊註解的開頭符號，
    // 會讓所有用正則剝註解的掃描工具從這裡吃掉後面一大段（本測試已踩過一次）。
    if (payload.type !== 'parent' && payload.type !== 'coach') {
      return guaiGuai.deny(req, res, '這個帳號沒有查看教練清單的權限。');
    }
    return next();
  } catch {
    return guaiGuai.deny(req, res, '登入已逾時，請重新登入。');
  }
}

router.get('/', requireParentOrCoach, async (req, res) => {
  try {
    const venueIds = await resolveVenueFilterCandidates(req.query.venueId);
    const params = [];
    let venueWhere = '';
    if (venueIds.length) {
      params.push(venueIds);
      venueWhere = `AND EXISTS (
        SELECT 1
          FROM (${COACH_VENUE_SOURCE_SQL}) match_venues
         WHERE match_venues.venue_id = ANY($${params.length}::text[])
      )`;
    }
    const r = await pool.query(
      `SELECT ${COACH_STAFF_PROFILE_SELECT}
         FROM coaches c
         JOIN admin_staff s ON s.id = c.ragic_employee_id
        WHERE s.active = TRUE
          AND c.is_active = TRUE
          -- 有且只有 canonical placeholder 可供選擇；歷史同名列保留供訂單追查，
          -- 不刪除也不再出現在新的選擇器中。
          AND (COALESCE(c.is_placeholder, FALSE) = TRUE
               OR TRIM(COALESCE(c.name, '')) NOT IN ('待分配', '01待分配'))
          ${venueWhere}
        ORDER BY COALESCE(c.is_placeholder, FALSE) DESC, s.name`,
      params
    );
    res.json(r.rows.map(publicCoach));
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
  const phone = String(req.query.phone || '').trim();
  const idToken = req.query.id_token || req.headers['x-line-id-token'];
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  try {
    const r = await pool.query(
      `SELECT ${COACH_STAFF_PROFILE_SELECT}
       FROM coaches c
       JOIN admin_staff s ON s.id = c.ragic_employee_id
       WHERE TRIM(s.phone) = $1
         AND s.active = TRUE
         AND c.is_active = TRUE
         AND COALESCE(c.is_placeholder, FALSE) = FALSE`,
      [phone]
    );
    if (r.rows.length === 0) {
      logFailedLogin(ip, phone, 'phone-not-found');
      return res.status(404).json({ error: 'not found', code: 'COACH_NOT_FOUND' });
    }
    let coach = normalizeCoach(r.rows[0]);

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
      `SELECT ${COACH_STAFF_PROFILE_SELECT}
       FROM coaches c
       JOIN admin_staff s ON s.id = c.ragic_employee_id
       WHERE (c.line_uid = $1 OR s.line_uid = $1)
         AND s.active = TRUE
         AND c.is_active = TRUE`,
      [lineUid]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({
        error: UNBOUND_MSG,
        code: 'COACH_LINE_NOT_BOUND',
      });
    }
    const coach = normalizeCoach(r.rows[0]);
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

/**
 * 教練看自己的私有欄位。**需要登入，而且只能看自己的**（requireCoachOwner）。
 *
 * 為什麼另開一支：主管寫的退回原因（intro_review_note）本來混在公開的
 * GET /coaches/:id 裡回出去，等於任何人都讀得到內部評語。公開端點已改成白名單
 * 把它擋掉了，但教練自己「要改什麼」得看得到，所以搬到這裡。
 *
 * 只回審核相關的三個欄位。手機／Email 教練登入時本來就拿得到（by-phone /
 * by-line-uid 的回傳），不必在這裡重複一份。
 */
router.get('/:id/private', requireCoach, requireCoachOwner('id'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.intro_review_status, c.intro_review_note,
              c.intro_submitted_at, c.intro_reviewed_at
         FROM coaches c
        WHERE c.id = $1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[coaches/:id/private]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 家長端小卡的自介只有 line-clamp-2（client/liff/src/components/CoachCard.jsx），
// 約兩行、40 字 —— 但那是「建議」不是「規定」：前端超過 40 只給警語，照樣存得進去
// （owner 2026-08-17）。後端如果還擋 40，畫面說可以存、送出卻被打回，那是最難查的
// 那種不一致。
//
// 這裡擋的是防呆上限。正式庫現存最長 268 字，訂 500 讓既有資料重新儲存時不會卡住，
// 同時擋掉整篇文章貼進來的情況。要改的話前端的 BIO_HARD_MAX 必須同步。
const BIO_MAX = 500;

router.put('/:id/bio', requireCoach, requireCoachOwner('id'), async (req, res) => {
  const { bio_rich_text } = req.body || {};
  // 前端的 maxLength 只是引導，繞過去就沒了。上限必須在這裡也擋一次。
  // 不做靜默截斷 —— 那是替教練決定砍掉哪一段，錯了他也不會知道。
  const bio = typeof bio_rich_text === 'string' ? bio_rich_text : '';
  if (bio.length > BIO_MAX) {
    return res.status(400).json({
      error: `個人介紹最多 ${BIO_MAX} 字（目前 ${bio.length} 字）`,
      code: 'BIO_TOO_LONG',
      max: BIO_MAX,
      length: bio.length,
    });
  }
  try {
    const r = await pool.query(
      `UPDATE coaches SET bio_rich_text = $1,
                         intro_review_status = 'pending_review',
                         intro_submitted_at = NOW(),
                         updated_at = NOW()
       WHERE id = $2 RETURNING id, bio_rich_text, intro_review_status`,
      [bio, req.params.id]   // 已在上面正規化過（非字串一律當空字串）
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 介紹圖片清單。
 *
 * 2026-08-17：補上權限。原本這支完全沒有 middleware —— 隔壁的 GET /coaches 與
 * GET /coaches/:id 在 8/11 就改成白名單＋須登入了（那次外洩 165 位教練的手機與
 * Email），這支漏掉。任何人帶一個 coach id 就拿得到照片網址，而 /uploads/* 本身
 * 也不需要登入。
 *
 * 唯一的消費者是教練自己的個人頁（CoachProfilePage）。主管審核走的是
 * admin/learn.js 的 /intros，不經過這裡。家長端從頭到尾沒有拿過 media。
 */
router.get('/:id/media', requireCoach, requireCoachOwner('id'), async (req, res) => {
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

/**
 * 大頭照：上傳（multipart, field: file）與移除。
 *
 * 走的是與介紹圖片完全相同的一條路 —— multer memoryStorage → objectStorage.saveBuffer
 * → 存「相對路徑」。這不是省事，是刻意的：
 *   ・saveBuffer 在 production 只會落 bucket 或 PostgreSQL，本機磁碟被 fail closed 擋掉
 *     （Autoscale 換實例就沒了；2026-07-13 那張介紹圖就是這樣變成 404 的）
 *   ・存相對路徑，dev 與正式各自解析自己的網域，不可能交叉汙染
 * 要改這裡之前先讀 server/services/objectStorage.js 的檔頭。
 */
router.post('/:id/avatar', requireCoach, requireCoachOwner('id'), mediaUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '請選擇圖片' });
    const saved = await saveBuffer({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
    });
    const r = await pool.query(
      `UPDATE coaches SET avatar_url = $1, updated_at = NOW() WHERE id = $2 RETURNING id, avatar_url`,
      [saved.url, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    const status = Number(err.status) || 500;
    console.error('[coaches/avatar]', err.message);
    res.status(status).json({ error: err.message || '上傳失敗' });
  }
});

router.delete('/:id/avatar', requireCoach, requireCoachOwner('id'), async (req, res) => {
  try {
    // 只清欄位，不刪 object —— 同一個 key 可能被別處引用，而且刪錯了救不回來。
    const r = await pool.query(
      `UPDATE coaches SET avatar_url = NULL, updated_at = NOW() WHERE id = $1 RETURNING id, avatar_url`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 上傳圖片檔（multipart, field: file）→ 存檔後直接建立 media 列並回傳
router.post('/:id/media/upload', requireCoach, requireCoachOwner('id'), mediaUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '請選擇圖片' });
    const alt_text = (req.body?.alt_text || '').slice(0, 200);
    const saved = await saveBuffer({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
    });
    const max = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) AS m FROM coach_bio_media WHERE coach_id = $1`,
      [req.params.id]
    );
    const r = await pool.query(
      `INSERT INTO coach_bio_media (coach_id, media_type, storage_url, alt_text, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, 'image', saved.url, alt_text, max.rows[0].m + 1]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    const status = Number(err.status) || 500;
    console.error('[coaches/media/upload]', err.message);
    res.status(status).json({ error: err.message || '上傳失敗' });
  }
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
