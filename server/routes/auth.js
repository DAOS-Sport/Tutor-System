/**
 * /api/auth — LIFF 端 token 簽發
 *
 *  POST /api/auth/parent-login         { phone }                       → { ... , token } | null
 *  POST /api/auth/parent-line-login    { id_token }                    → logged_in | need_phone_binding
 *  POST /api/auth/parent-bind-phone    { id_token, phone }             → bound_and_logged_in | need_registration | 409
 *  POST /api/auth/parent-register-line { id_token, parent, students[] }→ registered_and_logged_in | 409 LINE/PHONE
 *
 * 教練端登入沿用 routes/coaches.js: POST /api/coaches/by-phone（手機 + id_token）。
 */
const express = require('express');
const { pool } = require('../models/db');
const { signParentToken } = require('../middlewares/parentAuth');
const { signCoachToken } = require('../middlewares/coachAuth');
const ragic = require('../services/ragic');
const { verifyLineIdToken } = require('../services/lineAuth');
// 家長/學員 ↔ Ragic 同步語意集中於此（登入/綁定/註冊/刷新共用，避免漂移）。
const parentSync = require('../services/parentSync');
const { BindConflictError } = parentSync;
// 佔位姓名偵測 + Z03/quarantine 追蹤列即時畢業（綁定當下清洗佔位電話姓名用）。
// ragicAdmin 不 require auth.js，無循環相依。
const ragicAdmin = require('../services/ragicAdmin');
const parentRefresh = require('../services/parentRefresh');
const { refreshParentMirrorFromRagic, ParentRefreshError } = parentRefresh;

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Demo 登入（手機功能測試用，繞過 LINE）
//   POST /api/auth/demo-login  { username, password }
//     → { role:'coach',  ...coach,  token }
//     | { role:'parent', id, name, phone, students, token }
//   僅在 ALLOW_DEMO_LOGIN=1 時開放（未設則回 404，避免成為永久後門）。
//   對應到 Ragic 測試帳號：教練「(測試帳號)教練」、家長 0912345678「(測試帳號)家長」。
//   demo 完請移除此 secret。
// ─────────────────────────────────────────────────────────────
const DEMO_ACCOUNTS = {
  coach:   { password: 'coach',   role: 'coach' },
  // 第二測試教練：供 demo 測「課程轉換教練（後台改派）」與「教練端寫授課日誌」。
  // 以名稱精準比對 Ragic/DB 測試帳號「(測試帳號)教練2」（server/scripts/seed-demo-coach2.js 建立）。
  coach2:  { password: 'coach2',  role: 'coach', coachName: '(測試帳號)教練2' },
  custom:  { password: 'custom',  role: 'parent', phone: '0912345678' },
  // 第二測試家庭：供 demo 測「他人加入團報」（團主 custom + 加入者 custom2）。
  custom2: { password: 'custom2', role: 'parent', phone: '0922222222' },
};

router.post('/demo-login', async (req, res) => {
  if (process.env.ALLOW_DEMO_LOGIN !== '1') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const acct = DEMO_ACCOUNTS[username];
    if (!acct || password !== acct.password) {
      return res.status(401).json({ error: '帳號或密碼錯誤', code: 'DEMO_LOGIN_INVALID' });
    }

    if (acct.role === 'coach') {
      // 僅允許測試帳號教練。fail-closed：找不到就回 404，不退回任一真實教練，
      // 避免冒用真實教練身分/越權存取其資源。
      //   coach  → 名稱含「測試帳號」者取 ragic_employee_id 最小的一位（第一測試教練）
      //   coach2 → 以指定名稱精準比對（acct.coachName），避免與 coach 取到同一人
      const filter = acct.coachName
        ? { clause: 'c.name = $1', params: [acct.coachName] }
        : { clause: "c.name LIKE '%測試帳號%'", params: [] };
      const r = await pool.query(
        `SELECT c.*, COALESCE(
           (SELECT json_agg(cv.venue_id) FROM coach_venues cv WHERE cv.coach_id = c.id),
           '[]'::json
         ) AS venue_ids
         FROM coaches c
         WHERE c.is_active = TRUE AND ${filter.clause}
         ORDER BY c.ragic_employee_id ASC
         LIMIT 1`,
        filter.params
      );
      if (!r.rowCount) {
        return res.status(404).json({ error: 'Demo 教練帳號不存在（需測試帳號教練）', code: 'DEMO_COACH_MISSING' });
      }
      const coach = r.rows[0];
      coach.multiplier = Number(coach.pricing_multiplier);
      const token = signCoachToken({ coachId: coach.id, phone: coach.phone, lineUid: coach.line_uid || null });
      const { line_uid, ...safe } = coach;
      return res.json({ role: 'coach', ...safe, token });
    }

    // parent
    const r = await pool.query(
      `SELECT id, name, phone, line_uid, primary_venue_id
         FROM parents
        WHERE phone = $1
          AND is_active = TRUE
          AND line_uid = $2`,
      [acct.phone, `demo:${acct.phone}`]
    );
    if (!r.rowCount) {
      return res.status(500).json({ error: 'Demo 家長資料尚未建立', code: 'DEMO_PARENT_MISSING' });
    }
    const p = r.rows[0];
    const token = signParentToken({ parentId: p.id, phone: p.phone, lineUid: p.line_uid });
    const students = await loadStudents(p.id);
    return res.json({
      role: 'parent',
      id: p.id, name: p.name, phone: p.phone,
      primary_venue_id: p.primary_venue_id,
      students,
      token,
    });
  } catch (err) {
    console.error('[auth/demo-login]', err);
    res.status(500).json({ error: 'Demo 登入失敗', code: 'DEMO_LOGIN_FAILED' });
  }
});

/**
 * GET /api/auth/line-config-debug — 非敏感的 LINE 設定健檢
 * 只回布林與末 4 碼，不外露 channel id / secret / liff id 全值。
 * production 預設 404，需 DEBUG_LINE_AUTH=1 才開放。
 */
router.get('/line-config-debug', (req, res) => {
  const isProd = process.env.NODE_ENV === 'production';
  const debugOn = process.env.DEBUG_LINE_AUTH === '1';
  if (isProd && !debugOn) {
    return res.status(404).json({ error: 'not found' });
  }
  const cid = process.env.LINE_LOGIN_CHANNEL_ID || '';
  const parentLiff = process.env.VITE_LIFF_ID_PARENT || process.env.LIFF_ID_PARENT || '';
  const coachLiff = process.env.VITE_LIFF_ID_COACH || process.env.LIFF_ID_COACH || '';
  res.json({
    line_login_channel_id_configured: Boolean(cid),
    line_login_channel_id_tail: cid ? `***${cid.slice(-4)}` : null,
    line_login_channel_secret_configured: Boolean(process.env.LINE_LOGIN_CHANNEL_SECRET),
    node_env: process.env.NODE_ENV || 'development',
    require_line_id_token: process.env.REQUIRE_LINE_ID_TOKEN === '1'
      || process.env.NODE_ENV === 'production',
    liff_parent_configured: Boolean(parentLiff),
    liff_parent_tail: parentLiff ? `***${parentLiff.slice(-4)}` : null,
    liff_coach_configured: Boolean(coachLiff),
    liff_coach_tail: coachLiff ? `***${coachLiff.slice(-4)}` : null,
    ragic_base_url_configured: Boolean(process.env.RAGIC_BASE_URL),
    ragic_api_key_configured: Boolean(process.env.RAGIC_API_KEY),
  });
});

// per-IP 速率限制（與 coach by-phone 同樣 5 / 5min → 429），抑制電話號碼暴搜
const _attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
function _rateLimited(ip) {
  const now = Date.now();
  const arr = (_attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  _attempts.set(ip, arr);
  if (_attempts.size > 5000) _attempts.clear();
  return arr.length > MAX_ATTEMPTS;
}

// 台灣手機格式：09xxxxxxxx
const TW_PHONE_RE = /^09\d{8}$/;
// 台灣身分證字號（保守版）
const TW_ID_RE = /^[A-Z][12]\d{8}$/;
// Email（寬鬆但足以擋空白 / 缺 @ / 缺網域）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

async function loadStudents(parentId) {
  const r = await pool.query(
    `SELECT id, name, birth_date, gender, id_number, blood_type, student_code, is_active
       FROM students
      WHERE parent_id = $1 AND COALESCE(is_active, TRUE) = TRUE
      ORDER BY created_at ASC`,
    [parentId]
  );
  return r.rows;
}

function _issue(parent) {
  const token = signParentToken({
    parentId: parent.id, phone: parent.phone, lineUid: parent.line_uid,
  });
  return {
    id: parent.id, name: parent.name, phone: parent.phone,
    primary_venue_id: parent.primary_venue_id, line_uid: parent.line_uid,
    gender: parent.gender || null,
    email: parent.email || null,
    identity: parent.identity || null,
    home_phone: parent.home_phone || null,
    home_address: parent.home_address || null,
    line_id: parent.line_id || null,
    token,
  };
}

// 家長/學員 upsert、認領驗證與 bind conflict 型別已抽至 services/parentSync.js（見檔頭 require）。

// Ragic 呼叫失敗時統一轉成 HTTP 回應：services/ragic.js 的 _normalizeRagicError 已把
// timeout 跟其他失敗區分成不同 err.code，這裡保留該區分（而非全部壓成同一句「暫時無法連線」），
// 讓使用者知道「等一下再試就好」跟「系統本身有問題」是不同狀況。
function _ragicErrorResponse(err, fallbackMsg) {
  if (err?.code === 'RAGIC_TIMEOUT') {
    return { status: 504, code: 'RAGIC_TIMEOUT', error: 'Ragic 回應較慢，請稍候片刻再試一次。' };
  }
  return { status: 502, code: 'RAGIC_UNAVAILABLE', error: fallbackMsg || '資料同步服務暫時無法連線，請稍後再試' };
}

function _refreshErrorResponse(err, fallbackMsg) {
  if (err instanceof BindConflictError) {
    return { status: err.http, code: err.code, error: err.message };
  }
  if (err?.code === 'RAGIC_TIMEOUT') {
    return { status: 504, code: 'RAGIC_TIMEOUT', error: 'Ragic 回應較慢，請稍候片刻再試一次。' };
  }
  if (err instanceof ParentRefreshError) {
    return {
      status: err.http || 500,
      code: err.code || 'PARENT_REFRESH_FAILED',
      error: err.message || fallbackMsg || '會員資料重新整理失敗，請稍後再試',
    };
  }
  return {
    status: 500,
    code: err?.code || 'PARENT_REFRESH_FAILED',
    error: fallbackMsg || '會員資料重新整理失敗，請稍後再試',
  };
}

// code → 使用者可讀訊息；services/lineAuth.js 依實際失敗原因附上對應 code，
// 這裡逐一轉成不同文案，取代原本全部落到同一句「LINE 驗證失敗」的做法。
const LINE_VERIFY_ERROR_MESSAGES = {
  LINE_TOKEN_EXPIRED:        'LINE 登入已逾時，請重新從 LINE 開啟此頁面。',
  LINE_CHANNEL_MISCONFIGURED:'系統設定異常，請聯繫客服協助處理（非您的操作問題）。',
  LINE_VERIFY_NETWORK_ERROR: '暫時無法連上 LINE 驗證服務，請稍後再試。',
  ID_TOKEN_REQUIRED:         'LINE 驗證資訊遺失，請重新從 LINE 開啟此頁面。',
};

async function _verifyLineUid(req, res) {
  const idToken = String(req.body?.id_token || '').trim();
  if (!idToken) {
    res.status(400).json({ error: 'id_token 必填', code: 'ID_TOKEN_REQUIRED' });
    return null;
  }
  try {
    const profile = await verifyLineIdToken(idToken);
    if (!profile?.sub) {
      res.status(401).json({ error: 'LINE 驗證未取得 UID', code: 'LINE_VERIFY_FAILED' });
      return null;
    }
    return profile.sub;
  } catch (err) {
    console.warn('[auth] verifyLineIdToken failed:', err.code || '', err.message);
    const code = err.code && LINE_VERIFY_ERROR_MESSAGES[err.code] ? err.code : 'LINE_VERIFY_FAILED';
    res.status(401).json({ error: LINE_VERIFY_ERROR_MESSAGES[code] || 'LINE 驗證失敗', code });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 手機單因素登入
//   U4 資安：phone-only 等於「用任意電話撈出該家長學員 + 取得登入 token」，屬越權／
//   帳號接管風險。production（或 REQUIRE_LINE_ID_TOKEN=1）下強制要求 LINE id_token 驗證，
//   且只回「該 LINE 帳號本人」綁定的家長（依 line_uid 比對），phone 僅作交叉確認、不得用來枚舉他人。
//   dev 環境保留 phone-only 後援，方便本地測試。
// ─────────────────────────────────────────────────────────────
router.post('/parent-login', async (req, res) => {
  const allowLegacyLogin = process.env.ALLOW_LEGACY_PARENT_LOGIN === '1'
    && process.env.NODE_ENV !== 'production';
  if (!allowLegacyLogin) {
    return res.status(410).json({
      error: '家長登入請改走 LINE-first 驗證流程',
      code: 'LINE_LOGIN_REQUIRED',
    });
  }

  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (_rateLimited(ip)) {
      console.warn('[auth/parent-login] rate-limited ip=', ip);
      return res.status(429).json({ error: '嘗試次數過多，請稍後再試' });
    }

    const requireLine = process.env.NODE_ENV === 'production'
      || process.env.REQUIRE_LINE_ID_TOKEN === '1';
    const phone = String(req.body?.phone || '').trim();

    let p;
    if (requireLine) {
      // 強制 LINE 驗證：以驗證後的 line_uid 查本人，phone 只做交叉確認。
      const lineUid = await _verifyLineUid(req, res);
      if (!lineUid) return; // _verifyLineUid 已寫入 4xx 回應
      const r = await pool.query(
        `SELECT id, name, phone, line_uid, primary_venue_id FROM parents WHERE line_uid = $1 AND is_active = TRUE`,
        [lineUid]
      );
      if (!r.rowCount) return res.json(null);
      p = r.rows[0];
      if (phone && p.phone && phone !== p.phone) {
        return res.status(403).json({ error: '手機與此 LINE 帳號不符', code: 'PHONE_MISMATCH' });
      }
    } else {
      // dev 後援：phone-only。
      if (!phone) return res.status(400).json({ error: '手機必填' });
      const r = await pool.query(
        `SELECT id, name, phone, line_uid, primary_venue_id FROM parents WHERE phone = $1 AND is_active = TRUE`,
        [phone]
      );
      if (!r.rowCount) return res.json(null);
      p = r.rows[0];
    }

    const token = signParentToken({ parentId: p.id, phone: p.phone, lineUid: p.line_uid });
    const s = await loadStudents(p.id);
    res.json({
      id: p.id, name: p.name, phone: p.phone,
      primary_venue_id: p.primary_venue_id,
      students: s,
      token,
    });
  } catch (err) {
    console.error('[auth/parent-login]', err);
    res.status(500).json({ error: '登入失敗', code: 'LOGIN_FAILED' });
  }
});

// ─────────────────────────────────────────────────────────────
// 家長 LINE 登入
//   200 { status:'logged_in',           parent, token }
//   200 { status:'need_phone_binding',  line_uid }
// ─────────────────────────────────────────────────────────────
router.post('/parent-line-login', async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (_rateLimited(ip)) return res.status(429).json({ error: '嘗試次數過多，請稍後再試', code: 'RATE_LIMITED' });

    const lineUid = await _verifyLineUid(req, res);
    if (!lineUid) return;

    // 1) Ragic Z01 by 家教系統uid
    let ragicRow = null;
    let ragicReachable = true;   // 區分「Ragic 查無此人」與「Ragic 連不上」
    try {
      ragicRow = await ragic.getParentByLineUid(lineUid);
    } catch (err) {
      ragicReachable = false;
      console.warn('[auth/parent-line-login] ragic.getParentByLineUid failed:', err.message);
    }

    if (ragicRow) {
      const mapped = ragic.mapZ01Parent(ragicRow);
      const missing = parentRefresh.getZ01MissingFields(mapped);
      if (missing.length) {
        return res.json({
          status: 'need_phone_binding',
          line_uid: lineUid,
          reason: 'z01_incomplete',
          missing_fields: missing.map((m) => m.key),
        });
      }
      try {
        const refreshed = await refreshParentMirrorFromRagic({
          lineUid,
          phone: mapped.phone,
          reason: 'parent-line-login',
        });
        const issued = _issue(refreshed.local);
        return res.json({ status: 'logged_in', parent: { ...issued, students: refreshed.students }, token: issued.token });
      } catch (err) {
        console.error('[auth/parent-line-login] refresh failed:', err);
        const r = _refreshErrorResponse(err, '同步家長資料失敗');
        return res.status(r.status).json({ error: r.error, code: r.code });
      }
    }

    // 2) Ragic 可達且查無此人 → 視為已從主庫移除，清掉本地殘留。
    //    Ragic 不可達時也不使用本地舊鏡像登入；改導手機備援，讓後續流程重新查 Z01。
    if (ragicReachable) {
      // Ragic 可達且查無此人 → 視為已從主庫移除，硬刪除本地殘留。
      // 有業務 FK（課程/簽到/轉讓）的學員/家長直接跳過，保留業務資料完整性。
      // 硬邊界：只動本地 DB，Ragic 端完全不碰。
      try {
        const stale = await pool.query(`SELECT id FROM parents WHERE line_uid = $1`, [lineUid]);
        for (const row of stale.rows) {
          await parentSync.hardDeleteParentIfSafe(pool, row.id);
        }
      } catch (err) {
        console.warn('[auth/parent-line-login] hard-delete stale local parent failed:', err.message);
      }
    }

    // 3) 都找不到（或已從 Ragic 刪除）→ 需重新綁定手機
    return res.json({
      status: 'need_phone_binding',
      line_uid: lineUid,
      reason: ragicReachable ? 'z01_not_found' : 'ragic_unavailable',
    });
  } catch (err) {
    console.error('[auth/parent-line-login]', err);
    res.status(500).json({ error: '登入失敗', code: 'LOGIN_FAILED' });
  }
});

// ─────────────────────────────────────────────────────────────
// 家長手機綁定
//   200 { status:'bound_and_logged_in', parent, token }
//   200 { status:'need_registration',   line_uid, phone }
//   409 LINE_ALREADY_BOUND_TO_OTHER_PHONE / PHONE_ALREADY_BOUND_TO_OTHER_LINE
// ─────────────────────────────────────────────────────────────
router.post('/parent-bind-phone', async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (_rateLimited(ip)) return res.status(429).json({ error: '嘗試次數過多，請稍後再試', code: 'RATE_LIMITED' });

    const phone = String(req.body?.phone || '').trim();
    if (!phone) return res.status(400).json({ error: '手機必填', code: 'PHONE_REQUIRED' });
    if (!TW_PHONE_RE.test(phone)) {
      return res.status(400).json({ error: '手機格式錯誤（需 09xxxxxxxx）', code: 'PHONE_FORMAT_INVALID' });
    }

    const lineUid = await _verifyLineUid(req, res);
    if (!lineUid) return;

    // 1) 本地 line_uid 已綁到不同手機（只看 active 記錄；inactive 舊列不應擋重新綁定）
    const dupLine = await pool.query(`SELECT phone FROM parents WHERE line_uid = $1 AND is_active = TRUE LIMIT 1`, [lineUid]);
    if (dupLine.rowCount && dupLine.rows[0].phone !== phone) {
      return res.status(409).json({
        error: '此 LINE 帳號已綁定其他手機，請改用原手機登入或聯絡客服',
        code: 'LINE_ALREADY_BOUND_TO_OTHER_PHONE',
      });
    }
    // 1b) 本地手機已綁到不同 line_uid：先記錄，不在查 Ragic 前直接擋。
    // 以 Ragic Z01 為權威；若後續 Z01 完整且 UID 寫回成功，refresh 階段會覆蓋本地舊 UID。
    const dupPhone = await pool.query(`SELECT line_uid FROM parents WHERE phone = $1 AND is_active = TRUE LIMIT 1`, [phone]);
    const localPhoneHasOtherUid = Boolean(dupPhone.rowCount && dupPhone.rows[0].line_uid && dupPhone.rows[0].line_uid !== lineUid);

    // 2) Ragic Z01 by phone
    let ragicRow = null;
    try {
      ragicRow = await ragic.getParentByPhone(phone);
    } catch (err) {
      console.warn('[auth/parent-bind-phone] ragic.getParentByPhone failed:', err.code || '', err.message);
      const r = _ragicErrorResponse(err);
      return res.status(r.status).json({ error: r.error, code: r.code });
    }

    // 3) Ragic 也找不到 → 引導去註冊
    if (!ragicRow) {
      return res.json({ status: 'need_registration', line_uid: lineUid, phone });
    }

    const mapped = ragic.mapZ01Parent(ragicRow);

    // 4) Z01 不完整不可登入/綁定，改導註冊補齊。line_uid 會在本流程寫入，故此處不列入缺欄。
    const missing = parentRefresh.getZ01MissingFields(mapped, { requireLineUid: false });
    if (missing.length) {
      return res.json({
        status: 'need_registration',
        line_uid: lineUid,
        phone,
        reason: 'z01_incomplete',
        missing_fields: missing.map((m) => m.key),
      });
    }

    if (mapped.line_uid && mapped.line_uid !== lineUid) {
      parentSync.auditClaim({ phone, lineUid, result: 'rebind_requested', reason: 'z01_uid_changed' });
    }
    if (localPhoneHasOtherUid) {
      parentSync.auditClaim({ phone, lineUid, result: 'local_rebind_requested', reason: 'local_uid_changed' });
    }

    // 4b) 認領驗證（資安）：此門號在 Ragic 已有家庭資料、且本次會建立/更換 LINE 綁定時，
    //     不可只憑「知道門號」就綁定並繼承其學員與身分證等 PII（門號可能被回收）。
    //     要求「學員姓名 + 身分證字號」與該家庭某位學員一致（= 電話 + 姓名 + 身分證 三者一致）才放行。
    //     全新門號 / 無學員者 → 視為單純綁定，免驗證。在寫回 line_uid 到 Ragic「之前」就攔。
    const needsClaimVerification = mapped.line_uid !== lineUid;
    if (needsClaimVerification) {
      const ragicStudents = ragic.parseZ01Students(ragicRow);
      if (ragicStudents.length > 0) {
        const claim = req.body?.claim || null;
        if (!claim || !claim.student_name || !claim.id_number) {
          parentSync.auditClaim({
            phone,
            lineUid,
            result: 'need_verification',
            reason: mapped.line_uid ? 'rebind_requires_claim' : 'unbound_requires_claim',
          });
          return res.json({ status: 'need_claim_verification', line_uid: lineUid, phone });
        }
        const verdict = parentSync.classifyStudentClaim(ragicStudents, claim);
        if (verdict === 'no_id_on_file') {
          // 姓名對上了，但 Ragic 該筆學員身分證字號欄位本來就是空的（常見於舊系統資料匯入不完整）。
          // 這不是「家長打錯」，是資料缺口，用自助表單永遠比對不過，需請櫃檯人工核對後手動綁定。
          parentSync.auditClaim({ phone, lineUid, result: 'no_id_on_file' });
          return res.status(409).json({
            error: '系統資料不完整，無法自動核對身分證字號，請透過本館 LINE 官方帳號聯繫櫃檯協助綁定。',
            code: 'CLAIM_NO_ID_ON_FILE',
          });
        }
        if (verdict !== 'matched') {
          parentSync.auditClaim({ phone, lineUid, result: 'failed' });
          return res.status(409).json({
            error: '學員姓名或身分證字號與資料不符，無法認領。請確認後再試，或洽櫃臺 / LINE 客服協助。',
            code: 'CLAIM_VERIFICATION_FAILED',
          });
        }
        parentSync.auditClaim({ phone, lineUid, result: 'passed' });
      }
    }

    // 5) 回寫 Ragic：一律用「電話查到的既有 Z01 record」直接 UPDATE，永不新建（避免同號重複列）。
    //    · 佔位電話姓名（Tier-1/1b）且本人已提供真實姓名 → 一次 partial PATCH 同時清洗姓名 + 綁 UID。
    //    · 否則（姓名已正常或未提供真名）→ 僅在 line_uid 空白時綁 UID（維持原行為）。
    //    只在「現有姓名是佔位電話」時才覆蓋姓名——認領雖已通過，仍不容許用自助表單改掉一個已正常的姓名。
    //    以 Ragic 為權威：姓名回寫成功才把清洗後姓名帶進本地同步，避免「Ragic 寫失敗、本地卻先改名」的漂移。
    const parentNameIn = String(req.body?.claim?.parent_name || req.body?.parent_name || '').trim();
    const wantNameFix = !mapped.name || ragicAdmin.isPlaceholderParentName(mapped.name);
    const cleanedName = (parentNameIn && !ragicAdmin.isPlaceholderParentName(parentNameIn)) ? parentNameIn : '';
    const nameToWrite = wantNameFix && cleanedName ? cleanedName : '';
    const needsUidWrite = mapped.line_uid !== lineUid;
    if (mapped.ragic_record_id && (nameToWrite || needsUidWrite)) {
      try {
        const payload = { [ragic.FIELD.Z01.LINE_UID]: lineUid };
        if (nameToWrite) payload[ragic.FIELD.Z01.PARENT_NAME] = nameToWrite;
        await ragic.upsertParentStrict(payload, mapped.ragic_record_id);
      } catch (err) {
        console.error('[auth/parent-bind-phone] Ragic 回寫（姓名/UID）失敗:', err.message);
        const r = _ragicErrorResponse(err, '資料暫時無法完成同步，請稍後再試');
        return res.status(r.status).json({ error: r.error, code: r.code === 'RAGIC_UNAVAILABLE' ? 'RAGIC_WRITE_FAILED' : r.code });
      }
    }

    // 6) 重新拉 Z01/Z02 → 同步 parent + students 到本地；成功後才簽 token。
    try {
      const refreshed = await refreshParentMirrorFromRagic({
        lineUid,
        phone,
        allowRebind: Boolean(mapped.line_uid && mapped.line_uid !== lineUid) || localPhoneHasOtherUid,
        reason: 'parent-bind-phone',
      });
      const issued = _issue(refreshed.local);
      return res.json({ status: 'bound_and_logged_in', parent: { ...issued, students: refreshed.students }, token: issued.token });
    } catch (err) {
      console.error('[auth/parent-bind-phone] refresh failed:', err);
      const r = _refreshErrorResponse(err, '綁定後重新整理會員資料失敗');
      return res.status(r.status).json({ error: r.error, code: r.code });
    }
  } catch (err) {
    console.error('[auth/parent-bind-phone]', err);
    res.status(500).json({ error: '綁定失敗', code: 'BIND_FAILED' });
  }
});

// ─────────────────────────────────────────────────────────────
// 新：家長 LINE 註冊（以電話號碼為冪等鍵，永不重複建立同號 Z01）
//   · Ragic 查無此電話            → 建立 Z01 主表 + Z02 學員 + 本地 + 簽 JWT
//   · 已有此電話且「未綁 LINE UID」（未開通，Z03 清洗池）→ found→update 就地開通：
//     名下有學員先過認領驗證（用表單學員姓名+身分證比對）→ 表單學員入 Z02 →
//     既有 Z01 一次 PATCH（回寫 UID＋清洗佔位姓名＋補空欄）→ 本地 + Z03 畢業 + 簽 JWT
//   · 已有此電話且已綁「其他」LINE UID（已開通）→ 409 擋下（防帳號搶占）
//
// Request:
//   { id_token,
//     parent:   { name, phone, gender?, email?, primary_venue_id? },
//     students: [{ name, id_number?, birth_date?, gender?, blood_type? }, ...] }
//
// Responses:
//   200 { status:'registered_and_logged_in', parent, token, linked_existing? }
//   400 INPUT_INVALID / PHONE_FORMAT_INVALID / ID_NUMBER_INVALID
//   401 LINE_VERIFY_FAILED
//   409 LINE_ALREADY_BOUND_TO_OTHER_PHONE / LINE_ALREADY_REGISTERED / PHONE_EXISTS_USE_BINDING
//   502 RAGIC_UNAVAILABLE / RAGIC_WRITE_FAILED
// ─────────────────────────────────────────────────────────────
router.post('/parent-register-line', async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (_rateLimited(ip)) return res.status(429).json({ error: '嘗試次數過多，請稍後再試', code: 'RATE_LIMITED' });

    const parentIn   = req.body?.parent   || {};
    const studentsIn = Array.isArray(req.body?.students) ? req.body.students : [];

    // 基本驗證
    const name  = String(parentIn.name || '').trim();
    const phone = String(parentIn.phone || '').trim();
    if (!name)  return res.status(400).json({ error: '家長姓名必填', code: 'INPUT_INVALID' });
    if (!phone) return res.status(400).json({ error: '手機必填',     code: 'INPUT_INVALID' });
    if (!TW_PHONE_RE.test(phone)) {
      return res.status(400).json({ error: '手機格式錯誤（需 09xxxxxxxx）', code: 'PHONE_FORMAT_INVALID' });
    }
    // Ragic Z01 必填欄位：家長 Email + 性別。缺一 Ragic 會回 INVALID 202、整筆寫不進去。
    // 在打 Ragic 前先 server-side 驗證，回明確錯誤碼，而非難解的 502 RAGIC_WRITE_FAILED。
    const email  = String(parentIn.email  || '').trim();
    const gender = String(parentIn.gender || '').trim();
    if (!email)                return res.status(400).json({ error: 'Email 必填',     code: 'EMAIL_REQUIRED' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email 格式錯誤', code: 'EMAIL_FORMAT_INVALID' });
    if (!gender)               return res.status(400).json({ error: '家長性別必填',   code: 'GENDER_REQUIRED' });
    const venueId = String(parentIn.primary_venue_id || '').trim();
    if (!venueId) {
      return res.status(400).json({ error: '館別必填', code: 'VENUE_REQUIRED' });
    }
    const venueExists = await pool.query(`SELECT 1 FROM venues WHERE id = $1 AND is_active = TRUE`, [venueId]);
    if (!venueExists.rowCount) {
      return res.status(400).json({ error: '館別不存在，請重新選擇', code: 'VENUE_NOT_FOUND' });
    }
    if (studentsIn.length === 0) {
      return res.status(400).json({ error: '至少需要一位學員', code: 'INPUT_INVALID' });
    }
    const cleanStudents = [];
    for (let i = 0; i < studentsIn.length; i++) {
      const s = studentsIn[i] || {};
      const sName = String(s.name || '').trim();
      if (!sName) {
        return res.status(400).json({ error: `第 ${i + 1} 位學員姓名必填`, code: 'INPUT_INVALID' });
      }
      let idNum = String(s.id_number || '').trim().toUpperCase();
      if (idNum && !TW_ID_RE.test(idNum)) {
        return res.status(400).json({ error: `第 ${i + 1} 位學員身分證字號格式錯誤`, code: 'ID_NUMBER_INVALID' });
      }
      cleanStudents.push({
        name: sName,
        id_number:  idNum || null,
        birth_date: s.birth_date || null,
        gender:     s.gender || null,
        blood_type: s.blood_type || null,
      });
    }

    // 測試用「Demo 新用戶」已停用：Z01 只允許真實 LINE UID，demo 註冊不得再寫
    // DEMOTEST_ 假 UID 到 Ragic。固定測試帳號請走 /api/auth/demo-login（本地 demo:<phone> sentinel）。
    const demoNewUser = process.env.ALLOW_DEMO_LOGIN === '1' && req.body?.demo === true;
    let lineUid;
    if (demoNewUser) {
      return res.status(410).json({
        error: 'Demo 新用戶註冊已停用；請使用固定測試帳號登入',
        code: 'DEMO_REGISTER_DISABLED',
      });
    } else {
      lineUid = await _verifyLineUid(req, res);
      if (!lineUid) return;
    }

    // 衝突檢查 1：本地 line_uid 已綁不同手機（只看 active；inactive 舊列不擋重新綁定）
    const dupLine = await pool.query(`SELECT phone FROM parents WHERE line_uid = $1 AND is_active = TRUE LIMIT 1`, [lineUid]);
    if (dupLine.rowCount && dupLine.rows[0].phone !== phone) {
      return res.status(409).json({
        error: '此 LINE 帳號已綁定其他手機，請改用原手機登入',
        code: 'LINE_ALREADY_BOUND_TO_OTHER_PHONE',
      });
    }

    // 衝突檢查 1b：本地手機已綁到不同 line_uid（鏡像 bind-phone 的檢查 1b）。
    // ★ 必須在任何 Ragic 寫入「之前」擋：found→update 分支會直接改寫既有 Z01 的 UID 與新增
    //   Z02 學員且無回滾；若等到 _syncWithLock 內的同款 guard 才擋，Ragic 已被污染——
    //   在「本地已綁 UID、Ragic 端 UID 空白」的漂移狀態下（bind 的 Ragic 回寫是 best-effort，
    //   可能失敗），知道電話的人可搶綁 Ragic UID 把原用戶鎖在門外。
    const dupPhoneLocal = await pool.query(`SELECT line_uid FROM parents WHERE phone = $1 AND is_active = TRUE LIMIT 1`, [phone]);
    if (dupPhoneLocal.rowCount && dupPhoneLocal.rows[0].line_uid && dupPhoneLocal.rows[0].line_uid !== lineUid) {
      return res.status(409).json({
        error: '此手機已綁定其他 LINE 帳號，請聯絡客服處理',
        code: 'PHONE_ALREADY_BOUND_TO_OTHER_LINE',
      });
    }

    // 衝突檢查 2：Ragic 已有此 line_uid
    let incompleteByLine = null;
    try {
      const existsByLine = await ragic.getParentByLineUid(lineUid);
      if (existsByLine) {
        const byLine = ragic.mapZ01Parent(existsByLine);
        const missing = parentRefresh.getZ01MissingFields(byLine);
        if (!missing.length) {
          return res.status(409).json({
            error: '此 LINE 帳號已註冊，請改走登入流程',
            code: 'LINE_ALREADY_REGISTERED',
          });
        }
        if (byLine.phone && byLine.phone !== phone) {
          return res.status(409).json({
            error: '此 LINE 帳號已綁定其他手機，請改用原手機登入',
            code: 'LINE_ALREADY_BOUND_TO_OTHER_PHONE',
          });
        }
        incompleteByLine = existsByLine;
      }
    } catch (err) {
      console.warn('[auth/parent-register-line] ragic.getParentByLineUid failed:', err.code || '', err.message);
      const r = _ragicErrorResponse(err);
      return res.status(r.status).json({ error: r.error, code: r.code });
    }

    // 衝突檢查 3 ／ 開通分流：Ragic 已有此 phone？
    // ★ found→update：同號既有 Z01「未綁任何 LINE UID」（= 尚未開通，Z03 清洗池）時不再擋 409，
    //   改在既有 record 上就地開通——回寫 UID、清洗佔位姓名、補齊空欄、表單學員入 Z02——
    //   永不重複建立同號記錄。「登入驗證處是 Z01（已開通）、註冊驗證處是 Z03（未開通）」。
    // ★ 資安底線（維持不變）：
    //   · 既有記錄已綁「其他」LINE UID（= 已開通）→ 一律擋，防止知道電話的人搶占既有帳號。
    //     （不可能是「自己的 UID」：衝突檢查 2 已先以本 lineUid 查過 Ragic 並擋 LINE_ALREADY_REGISTERED。）
    //   · 既有家庭名下有學員 → 沿用 bind-phone 同一套認領驗證（電話＋學員姓名＋身分證三要素），
    //     以註冊表單本來就必填的學員資料比對，對不上仍擋 409，不讓人繼承他人學員 PII。
    //   · 家長姓名只在既有值為「電話佔位」時才覆蓋（isPlaceholderParentName），
    //     不容許自助表單改掉一個已正常的姓名。
    let existsByPhone = null;
    try {
      existsByPhone = await ragic.getParentByPhone(phone);
    } catch (err) {
      console.warn('[auth/parent-register-line] ragic.getParentByPhone failed:', err.code || '', err.message);
      const r = _ragicErrorResponse(err);
      return res.status(r.status).json({ error: r.error, code: r.code });
    }
    if (!existsByPhone && incompleteByLine) existsByPhone = incompleteByLine;

    let linkedExisting = false;

    if (existsByPhone) {
      const existing = ragic.mapZ01Parent(existsByPhone);

      // ★ 反枚舉：以下所有「電話已存在但不放行」的出口一律回同一組文案＋代碼
      //   （與改動前相同），不讓掃電話的人從回應差異推斷「已開通與否／有無學員／比對錯在哪」。
      //   差異細節只進伺服器端 log / auditClaim。
      const GENERIC_PHONE_CONFLICT = {
        error: '此手機已存在於系統，請改用「以手機綁定」流程',
        code: 'PHONE_EXISTS_USE_BINDING',
      };

      const existingMissing = parentRefresh.getZ01MissingFields(existing);

      // 已開通且不是本次 LINE UID → 擋下。同一 UID 但資料不完整時允許走註冊補齊。
      if (existing.line_uid && existing.line_uid !== lineUid) {
        return res.status(409).json(GENERIC_PHONE_CONFLICT);
      }
      if (existing.line_uid === lineUid && !existingMissing.length) {
        return res.status(409).json(GENERIC_PHONE_CONFLICT);
      }

      // 認領驗證：既有家庭名下有學員才需要（0 學員 = 單純開通，與 bind-phone 語意一致）。
      // 表單任一位學員與既有 Ragic 學員（姓名＋身分證）對上即放行。
      const ragicStudents = ragic.parseZ01Students(existsByPhone);
      if (!existing.line_uid && ragicStudents.length > 0) {
        let verdict = 'mismatch';
        for (const s of cleanStudents) {
          const v = parentSync.classifyStudentClaim(ragicStudents, { student_name: s.name, id_number: s.id_number || '' });
          if (v === 'matched') { verdict = 'matched'; break; }
          if (v === 'no_id_on_file') verdict = 'no_id_on_file';
        }
        if (verdict !== 'matched') {
          parentSync.auditClaim({
            phone, lineUid,
            result: verdict === 'no_id_on_file' ? 'no_id_on_file' : 'failed',
            reason: 'register_found_update',
          });
          return res.status(409).json(GENERIC_PHONE_CONFLICT);
        }
        parentSync.auditClaim({ phone, lineUid, result: 'passed', reason: 'register_found_update' });
      }

      // 只把「不在既有家庭名單上」的學員寫進 Z02（身分證字號或姓名對上任一既有學員 = 已存在）。
      // ★ 既有學員一律不動：表單只帶得出註冊預設值（學員編號=身分證頂替、學員身分 01.一般生、
      //   血型「不清楚」、可能空白的生日），拿去更新既有 Z02 列會覆蓋掉 Ragic 真實資料；
      //   而「Ragic 學員缺身分證字號、表單有填」時用身分證查重會查無 → 同一位小孩重複建檔。
      //   Ragic 為權威，自助註冊不更新既有學員資料。
      const famIds   = new Set(ragicStudents.map((s) => String(s.id_number || '').toUpperCase()).filter(Boolean));
      const famNames = new Set(ragicStudents.map((s) => s.name));
      const newStudents = cleanStudents.filter((s) =>
        !(s.id_number && famIds.has(s.id_number)) && !famNames.has(s.name));

      // 找到就更新：全新學員入 Z02 → 既有 Z01 一次 PATCH 開通（UID＋佔位姓名清洗＋補空欄）。
      const wantNameFix  = !existing.name || ragicAdmin.isPlaceholderParentName(existing.name);
      const nameToWrite  = (wantNameFix && !ragicAdmin.isPlaceholderParentName(name)) ? name : '';
      try {
        // parent 物件同時供 Z02 學員列的家長欄位使用：既有非空值優先、表單只補缺，
        // 避免「更新既有學員的 Z02 列」時用表單空值/新值蓋掉 Ragic 原有館別、性別、Email。
        // （venueLabel 對「名稱」直通、對「代碼」轉名稱，兩種來源皆可安全傳入。）
        await ragic.completeParentOnRegisterInRagic({
          existing,
          parent: {
            name: nameToWrite || existing.name || name,
            phone,
            gender: existing.gender || parentIn.gender || null,
            email:  existing.email  || parentIn.email  || null,
            primary_venue_id: (existing.primary_venue_id && existing.primary_venue_id !== '待補登')
              ? existing.primary_venue_id
              : (parentIn.primary_venue_id || null),
            identity: existing.identity || parentIn.identity || '一般身分',
          },
          students: newStudents,
          lineUid,
          nameToWrite,
        });
      } catch (err) {
        if (err.code === 'STUDENT_ID_NUMBER_EXISTS') {
          return res.status(409).json({
            error: `學員身分證字號 ${err.idNumber || ''} 已被系統內其他學員使用，請確認是否填錯；若確為本人請聯絡客服協助處理。`,
            code: 'STUDENT_ID_NUMBER_EXISTS',
          });
        }
        console.error('[auth/parent-register-line] completeParentOnRegisterInRagic failed:', err.code || '', err.message);
        const r = _ragicErrorResponse(err, '資料暫時無法完成同步，請稍後再試');
        return res.status(r.status).json({ error: r.error, code: r.code === 'RAGIC_UNAVAILABLE' ? 'RAGIC_WRITE_FAILED' : r.code });
      }
      linkedExisting = true;
    } else {
      // 全新電話 → 建立 Ragic Z01 主表 + Z02 學員（原行為）
      try {
        await ragic.createParentWithStudentsInRagic({
          parent: {
            name, phone,
            gender: parentIn.gender || null,
            email:  parentIn.email  || null,
            primary_venue_id: venueId,
          },
          students: cleanStudents,
          lineUid,
        });
      } catch (err) {
        if (err.code === 'STUDENT_ID_NUMBER_EXISTS') {
          return res.status(409).json({
            error: `學員身分證字號 ${err.idNumber || ''} 已被系統內其他學員使用，請確認是否填錯；若確為本人請聯絡客服協助處理。`,
            code: 'STUDENT_ID_NUMBER_EXISTS',
          });
        }
        console.error('[auth/parent-register-line] createParentWithStudentsInRagic failed:', err.code || '', err.message);
        const r = _ragicErrorResponse(err, '資料暫時無法完成同步，請稍後再試');
        return res.status(r.status).json({ error: r.error, code: r.code === 'RAGIC_UNAVAILABLE' ? 'RAGIC_WRITE_FAILED' : r.code });
      }
    }

    // 重新拉 Z01/Z02 → 建立/更新本地 parents + students（兩分支共用）；成功後才簽 token。
    let refreshed;
    try {
      refreshed = await refreshParentMirrorFromRagic({
        lineUid,
        phone,
        minStudents: cleanStudents.length,
        reason: linkedExisting ? 'parent-register-line-existing' : 'parent-register-line-new',
      });
    } catch (err) {
      console.error('[auth/parent-register-line] refresh failed:', err);
      const r = _refreshErrorResponse(err, '註冊後重新整理會員資料失敗');
      return res.status(r.status).json({ error: r.error, code: r.code });
    }

    const local = refreshed.local;
    const issued = _issue(local);
    const students = refreshed.students;

    // ── MGM ref_token 綁定（失敗不阻擋註冊；與 parents.js 行為相容）──
    // ★ 僅限全新客戶：found→update（舊客開通）不綁推薦。TRIAL50 是「新客戶體驗課 5 折」，
    //   改動前既有電話必 409、推薦人不可能因舊客得到獎勵，維持此業務語意。
    let refBound = false;
    let refError = null;
    const refTokenRaw = req.body?.ref_token;
    if (refTokenRaw && linkedExisting) {
      refError = 'REF_EXISTING_CUSTOMER';
    } else if (refTokenRaw) {
      try {
        const referrals = require('../services/referrals');
        await referrals.bindReferee({
          token: String(refTokenRaw).trim(),
          refereeParentId: local.id,
          refereePhone: local.phone,
        });
        refBound = true;
      } catch (e) {
        refError = e.code || 'REF_FAILED';
        console.warn('[auth/parent-register-line] bindReferee failed:', refError);
      }
    }

    return res.json({
      status: 'registered_and_logged_in',
      parent: { ...issued, students },
      token: issued.token,
      linked_existing: linkedExisting,
      ref_bound: refBound,
      ref_error: refError,
    });
  } catch (err) {
    console.error('[auth/parent-register-line]', err);
    res.status(500).json({ error: '註冊失敗', code: 'REGISTER_FAILED' });
  }
});

router.all('*', (req, res) => {
  res.status(404).json({ error: 'auth endpoint not found', path: req.path });
});

module.exports = router;
