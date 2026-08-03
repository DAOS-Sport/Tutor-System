/**
 * /api/auth — LIFF 端 token 簽發
 *
 *  POST /api/auth/parent-line-login    { id_token }                    → logged_in | need_phone_binding
 *  POST /api/auth/parent-bind-phone    { id_token, phone }             → bound_and_logged_in | need_registration | 409
 *  POST /api/auth/parent-register-line { id_token, parent, students[] }→ registered_and_logged_in | 409 LINE/PHONE
 *
 * （legacy phone-only `POST /api/auth/parent-login` 已刪除，P1.1 §4 決策 2026-07-07）
 * 教練端登入沿用 routes/coaches.js: POST /api/coaches/by-phone（手機 + id_token）。
 */
const crypto = require('crypto');
const express = require('express');
const { pool } = require('../models/db');
const { signParentToken } = require('../middlewares/parentAuth');
const { signCoachToken } = require('../middlewares/coachAuth');
const { signFlowToken, requireFlowToken, verifyPhoneRateLimit } = require('../middlewares/flowAuth');
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
const { cleanVenueList, COACH_STAFF_PROFILE_SELECT } = require('../services/coachVenueScope');
const {
  claimZ03Identity,
  registerNewParentLocalFirst,
  completeTrueUidRegistration,
  Z03ClaimError,
} = require('../services/z03IdentityClaim');
const { normalizePhone, normalizeStudentName } = require('../services/identityNormalizer');
const { STABILITY_FLAGS, getTrueRagicLineUid } = require('../config/ragicSchema');
const {
  requestAccountRecovery,
  completeManualAccountRecovery,
  AccountRecoveryError,
} = require('../services/parentAccountRecovery');
const { requireAdminAuth, requireAdminRole } = require('../middlewares/adminAuth');
const { captureParentLineProfile } = require('../services/parentLineProfile');
const { createParentIdentityBackofficeTask } = require('../services/parentIdentityBackoffice');
const { formatPlainDate } = require('../utils/dateTime');

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
  // 即使有人誤把 ALLOW_DEMO_LOGIN 放進 production Secrets，也絕不可開啟 demo
  // 身分。production 只接受真實的 LINE / JWT 身分流程。
  if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEMO_LOGIN !== '1') {
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
        ? { clause: 's.name = $1', params: [acct.coachName] }
        : { clause: "s.name LIKE '%測試帳號%'", params: [] };
      const r = await pool.query(
        `SELECT ${COACH_STAFF_PROFILE_SELECT}
         FROM coaches c
         JOIN admin_staff s ON s.id = c.ragic_employee_id
         WHERE s.active = TRUE
           AND c.is_active = TRUE
           AND ${filter.clause}
         ORDER BY c.ragic_employee_id ASC
         LIMIT 1`,
        filter.params
      );
      if (!r.rowCount) {
        return res.status(404).json({ error: 'Demo 教練帳號不存在（需測試帳號教練）', code: 'DEMO_COACH_MISSING' });
      }
      const coach = r.rows[0];
      coach.multiplier = Number(coach.pricing_multiplier);
      coach.venue_ids = cleanVenueList(coach.venue_ids);
      coach.venues = coach.venue_ids;
      const token = signCoachToken({ coachId: coach.id, phone: coach.phone, lineUid: coach.line_uid || null });
      const { line_uid, ragic_data_no, ...safe } = coach;
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

// 台灣手機格式：09xxxxxxxx
// 診斷 log 用手機遮蔽：比照 parentSync.auditClaim 的作法（sha256 雜湊取前段），
// 只供比對同一支手機的 log 是否為同一人，不落地明碼門號。
function _phoneHashForLog(phone) {
  return phone ? crypto.createHash('sha256').update(String(phone)).digest('hex').slice(0, 12) : null;
}

const TW_PHONE_RE = /^09\d{8}$/;
// 台灣身分證字號（保守版）
const TW_ID_RE = /^[A-Z][12]\d{8}$/;
// HTML date input / API contract：YYYY-MM-DD
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Email（寬鬆但足以擋空白 / 缺 @ / 缺網域）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STUDENT_BLOOD_TYPES = new Set(['A', 'B', 'O', 'AB', '不清楚']);

function _phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

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
  return r.rows.map((student) => ({
    ...student,
    birth_date: formatPlainDate(student.birth_date),
  }));
}

function _issue(parent) {
  const token = signParentToken({
    parentId: parent.id, phone: parent.phone, lineUid: parent.line_uid,
  });
  return {
    id: parent.id, name: parent.name, phone: parent.phone,
    // line_uid 只供後端驗證／簽 JWT 使用，不回傳給 LIFF，避免被 browser devtools、
    // 第三方 error reporter 或錯誤的前端 log 蒐集。
    primary_venue_id: parent.primary_venue_id,
    gender: parent.gender || null,
    email: parent.email || null,
    identity: parent.identity || null,
    home_phone: parent.home_phone || null,
    home_address: parent.home_address || null,
    line_id: parent.line_id || null,
    token,
  };
}

function _mapZ01ParentForIdentity(record) {
  const mapped = ragic.mapZ01Parent(record);
  return mapped ? { ...mapped, line_uid: getTrueRagicLineUid(record) } : null;
}

async function _respondExistingParentFastPath(res, lineUid, status = 'logged_in', forceLocal = false) {
  if (!forceLocal && !STABILITY_FLAGS.EXISTING_USER_LOCAL_FASTPATH) return false;
  const local = await parentSync.findActiveParentByLineUid(lineUid);
  if (!local) return false;
  const issued = _issue(local);
  const students = await loadStudents(local.id);
  res.json({
    status,
    parent: { ...issued, students },
    token: issued.token,
    local_fast_path: true,
    sync_state: 'LOCAL_LINKED',
  });
  return true;
}

async function _completeLocalZ03Claim(req, res, {
  phone,
  lineUid,
  successStatus = 'bound_and_logged_in',
  allowStudentAppend = false,
  parentProfile = null,
  studentInput = null,
  ownershipVerified = false,
} = {}) {
  const claim = req.body?.claim || {};
  const studentName = String(claim.student_name || claim.name || '').trim();
  const claimPhone = normalizePhone(claim.phone || phone);
  const canonicalPhone = normalizePhone(phone);
  if (!studentName || !claimPhone) {
    return res.json({ status: 'need_claim_verification', phone: canonicalPhone || phone });
  }
  if (claimPhone !== canonicalPhone) {
    return res.status(409).json({
      error: '登記手機與本次家庭手機不一致，已轉人工處理',
      code: 'MANUAL_REVIEW_REQUIRED',
      reason: 'CLAIM_PHONE_MISMATCH',
    });
  }
  try {
    const result = await claimZ03Identity({
      phone: canonicalPhone,
      studentName,
      studentInput,
      lineUid,
      parentName: claim.parent_name || '',
      parentProfile,
      allowStudentAppend,
      ownershipVerified,
      actor: allowStudentAppend ? 'parent-register-line' : 'parent-bind-phone',
    });
    const issued = _issue(result.parent);
    const students = await loadStudents(result.parent.id);
    return res.json({
      status: successStatus,
      parent: { ...issued, students },
      token: issued.token,
      sync_state: result.sync_state,
      sync_pending: result.sync_state !== 'SYNCED',
      replayed: result.replayed,
      correlation_id: result.correlation_id,
      parent_state: result.sync_state === 'SYNCED' ? 'AUTHENTICATED' : 'SYNC_IN_PROGRESS',
    });
  } catch (err) {
    if (err instanceof Z03ClaimError) {
      return res.status(err.http || 409).json({
        error: err.message,
        code: err.code,
        internalCode: err.code,
        retryable: false,
        correlationId: err.correlationId || crypto.randomUUID(),
        loginAllowed: false,
        syncState: err.code === 'ACCOUNT_RECOVERY_REQUIRED' ? 'ACCOUNT_RECOVERY_REQUIRED' : null,
        reason: err.reason || null,
      });
    }
    throw err;
  }
}

// 家長/學員 upsert、認領驗證與 bind conflict 型別已抽至 services/parentSync.js（見檔頭 require）。

// Ragic 呼叫失敗時統一轉成 HTTP 回應：services/ragic.js 的 _normalizeRagicError 已把
// timeout 跟其他失敗區分成不同 err.code，這裡保留該區分（而非全部壓成同一句「暫時無法連線」），
// 讓使用者知道「等一下再試就好」跟「系統本身有問題」是不同狀況。
function _ragicErrorResponse(err, fallbackMsg) {
  if (err?.code === 'RAGIC_TIMEOUT') {
    return { status: 504, code: 'RAGIC_TIMEOUT', error: 'Ragic 回應較慢，請稍候片刻再試一次。' };
  }
  if (['RAGIC_VALIDATION_ERROR', 'RAGIC_APPLICATION_ERROR', 'RAGIC_UNCONFIRMED_WRITE'].includes(err?.code)) {
    return {
      status: 422,
      code: 'RAGIC_SCHEMA_VALIDATION_FAILED',
      error: '送出的資料未通過同步欄位驗證，請確認選項與必填資料後再試。',
    };
  }
  if (err?.code === 'RAGIC_AUTH_FAILED') {
    return { status: 502, code: 'RAGIC_CONFIGURATION_ERROR', error: '同步服務驗證設定異常，請聯絡客服。' };
  }
  if (err?.code === 'RAGIC_RATE_LIMITED') {
    return { status: 503, code: 'RAGIC_RATE_LIMITED', error: '同步服務目前忙碌，請稍後再試。' };
  }
  return { status: 502, code: err?.code || 'RAGIC_UNAVAILABLE', error: fallbackMsg || '資料同步服務暫時無法連線，請稍後再試' };
}

// 註冊失敗診斷只記欄位存在性與不可逆 hash；禁止把姓名、電話、身分證、LINE UID 寫入 log。
function _registrationLogContext({ phone, venueId, students, parent }) {
  return {
    phone_hash: _phoneHashForLog(phone),
    venue_id: venueId || null,
    student_count: Array.isArray(students) ? students.length : 0,
    parent_fields: {
      name: Boolean(String(parent?.name || '').trim()),
      email: Boolean(String(parent?.email || '').trim()),
      gender: Boolean(String(parent?.gender || '').trim()),
    },
    student_fields_complete: (students || []).map((s) => ({
      name: Boolean(s.name),
      id_number: Boolean(s.id_number),
      birth_date: Boolean(s.birth_date),
      gender: Boolean(s.gender),
      blood_type: Boolean(s.blood_type),
    })),
  };
}

function _logRegistrationSyncFailure(stage, err, context) {
  console.error('[auth/parent-register-line] sync failed', {
    stage,
    code: err?.code || null,
    ragic_status: err?.ragicStatus || null,
    ragic_code: err?.ragicCode || null,
    message: err?.message || String(err),
    context,
    stack: err?.stack || null,
  });
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
    // LINE 顯示名稱是後台輔助資訊，與 parent identity 分離儲存。
    // 快取寫入失敗不得阻擋家長本地登入。
    try {
      await captureParentLineProfile({ lineUid: profile.sub, displayName: profile.name });
    } catch (profileErr) {
      console.warn('[auth] LINE display-name cache skipped:', profileErr.code || profileErr.message);
    }
    return profile.sub;
  } catch (err) {
    console.warn('[auth] verifyLineIdToken failed:', err.code || '', err.message);
    const code = err.code && LINE_VERIFY_ERROR_MESSAGES[err.code] ? err.code : 'LINE_VERIFY_FAILED';
    res.status(401).json({ error: LINE_VERIFY_ERROR_MESSAGES[code] || 'LINE 驗證失敗', code });
    return null;
  }
}

// P1.1 §4 決策（2026-07-07）：legacy `POST /api/auth/parent-login`（phone-only /
// phone+id_token 手機單因素登入）已刪除——確認全 repo 無 caller（僅 route-audit.js
// 的盤點紀錄與文件註解引用），家長登入一律走下面的 LINE-first 流程
// （parent-line-login → verify-phone/verify-student → bind，見封閉狀態機規格）。

// ─────────────────────────────────────────────────────────────
// 舊 LINE Login Channel callback 的安全相容入口。
// 這不是 OAuth callback：不讀、不驗、不轉送 code/state/token/UID，避免把舊連結
// 變成可重放的綁定端點。它只導回正式 LIFF /liff/bind，由 LIFF SDK 重新建立登入
// state，後端再以 id_token 驗 audience/sub，才會進既有 UID→手機→學員認領流程。
function redirectLegacyParentLineCallback(req, res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return res.redirect(303, '/liff/bind?source=legacy-callback');
}
router.get('/line/callback', redirectLegacyParentLineCallback);

// 家長 LINE 登入
//   200 { status:'logged_in',           parent, token }
//   200 { status:'need_phone_binding' }
// ─────────────────────────────────────────────────────────────
router.post('/parent-line-login', async (req, res) => {
  try {

    const lineUid = await _verifyLineUid(req, res);
    if (!lineUid) return;

    // 定案規則（2026-07-03）：登入只看本地 Z01 鏡像的 LINE UID。
    // Ragic/Z03 收斂交給註冊/電話驗證與排程；登入熱路徑不可因 Ragic 查詢失準、
    // timeout 或未同步而刪資料/擋正常使用者。
    // Even when the new cross-route fast-path flag is rolled back, preserve the
    // pre-release parent-line-login behavior: this endpoint was already local.
    if (await _respondExistingParentFastPath(res, lineUid, 'logged_in', true)) return;

    // 找不到本地 Z01 → 進電話多方驗證/註冊補資料，不在登入路徑打 Ragic。
    // 封閉狀態機（修改 PROMPT §3.2）：S1→S2 轉換時簽發 flowToken，之後
    // verify-phone/verify-student/bind/register 四端點一律憑此 token（不再重複驗證
    // LINE id_token）。
    const flowToken = signFlowToken({ lineUid });
    return res.json({
      status: 'need_phone_binding',
      reason: 'local_z01_not_found',
      flow_token: flowToken,
    });
  } catch (err) {
    console.error('[auth/parent-line-login]', err);
    res.status(500).json({ error: '登入失敗', code: 'LOGIN_FAILED' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 封閉狀態機（修改 PROMPT，2026-07-07 定案）：S2/S3/S3b 拆成三個獨立端點，
// 皆以 requireFlowToken 把關（僅接受 S1 簽發的短效 flowToken，不接受
// parent JWT，也不接受過期/其他流程的 flowToken）。
//
// 排序考量：這三支是「新增」端點，與既有 parent-bind-phone/parent-register-line
// 並存，不互相取代——現有前端尚未改接這三支新端點前，舊端點行為完全不變、
// 不會有任何既有使用者受影響。等前端完成對接封閉狀態機後，舊端點才會真正停用
// （見交付文件的「尚未完成」章節）。
// ═══════════════════════════════════════════════════════════════════════

// S2 PHONE_VERIFY：電話存在與否判斷。命中一律**不回傳任何學員資料**（防列舉，
// 修改 PROMPT §3.5）；學員清單只在 S3 姓名命中後才出現。防列舉加 rate limit
// （比照 coachAuth.js byPhoneRateLimit 既有寫法，5 分鐘 5 次；鍵值為 UID+IP，
// 故 requireFlowToken 必須排在 verifyPhoneRateLimit 之前，讓 req.flow.lineUid
// 先就緒）。found/not_found 各分支原本執行路徑長短不一（有無打 Ragic），會構成
// 時序側信道；一律拉平到固定下限（VERIFY_PHONE_MIN_MS）後才回應。
const VERIFY_PHONE_MIN_MS = 400;
router.post('/verify-phone', requireFlowToken, verifyPhoneRateLimit, async (req, res) => {
  const _startedAt = Date.now();
  const respond = async (status, body) => {
    const elapsed = Date.now() - _startedAt;
    const wait = VERIFY_PHONE_MIN_MS - elapsed;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return res.status(status).json(body);
  };
  try {
    const lineUid = req.flow.lineUid;
    if (await _respondExistingParentFastPath(res, lineUid)) return;
    const phone = String(req.body?.phone || '').trim();
    if (!phone) return respond(400, { error: '手機必填', code: 'PHONE_REQUIRED' });
    if (!TW_PHONE_RE.test(phone)) {
      return respond(400, { error: '手機格式錯誤（需 09xxxxxxxx）', code: 'PHONE_FORMAT_INVALID' });
    }
    // 本地 Z03 已有殘缺記錄（未綁定/未開通）→ 電話存在但資料不完整，
    // 導去 S4 REGISTER_NEW 由註冊表單補齊（與現有 parent-bind-phone 的
    // local_z03_pending 分支同語意）。
    let z03ByPhone = null;
    let multipleZ03Families = false;
    try {
      z03ByPhone = await ragicAdmin.findZ03RecordByPhone(phone);
    } catch (err) {
      if (err.code !== 'MANUAL_REVIEW_REQUIRED') throw err;
      multipleZ03Families = true;
    }
    if (z03ByPhone || multipleZ03Families) {
      const newToken = signFlowToken({
        lineUid, phone, attempts: 0, studentName: normalizeStudentName(studentName),
      });
      return respond(200, { status: 'found', reason: 'z03_pending', flow_token: newToken });
    }

    let ragicRow;
    try {
      ragicRow = await ragic.getParentByPhone(phone);
    } catch (err) {
      console.warn('[auth/verify-phone] ragic.getParentByPhone failed:', err.code || '', err.message);
      const r = _ragicErrorResponse(err);
      return respond(r.status, { error: r.error, code: r.code });
    }
    if (!ragicRow) {
      return respond(200, { status: 'not_found' });
    }

    // 命中：簽發帶 phone 的新 flowToken 供 S3 使用；刻意不揭露任何學員資料，
    // 也不在此區分「電話已綁其他 LINE 帳號」——一律視為 found，交給 S3 的姓名+
    // 登記電話認領驗證把關（與既有 parent-bind-phone 的 needsClaimVerification
    // 同一套邏輯），避免用電話存在與否本身洩漏「這支電話已被誰綁定」的資訊。
    const newToken = signFlowToken({ lineUid, phone, attempts: 0 });
    return respond(200, { status: 'found', flow_token: newToken });
  } catch (err) {
    console.error('[auth/verify-phone]', err);
    return respond(500, { error: '查詢失敗', code: 'VERIFY_PHONE_FAILED' });
  }
});

// S3 STUDENT_VERIFY：姓名正規化（NFKC 全半形/大小寫/空白，見 parentSync.js
// _normalizeStudentName）後與登記電話一併比對。3 次內未中即轉入 S4 並帶
// phone_collision 旗標（修改 PROMPT §1/§5：預設重試次數 3 次）；命中回傳
// 該家長名下**完整學員姓名清單**供 S3b 確認畫面顯示，不再像舊 parent-bind-phone
// 那樣一次比對成功就直接靜默綁定。
router.post('/verify-student', requireFlowToken, async (req, res) => {
  try {
    const { phone, lineUid, attempts } = req.flow;
    if (await _respondExistingParentFastPath(res, lineUid)) return;
    if (!phone) return res.status(400).json({ error: '請先完成電話驗證', code: 'PHONE_NOT_VERIFIED' });

    const claim = req.body?.claim || {};
    const studentName = String(claim.student_name || '').trim();
    const claimPhone = String(claim.phone || '').trim();
    if (!studentName || !claimPhone) {
      return res.status(400).json({ error: '學員姓名與登記電話必填', code: 'CLAIM_REQUIRED' });
    }

    let z03ByPhone = null;
    let multipleZ03Families = false;
    try {
      z03ByPhone = await ragicAdmin.findZ03RecordByPhone(phone);
    } catch (err) {
      if (err.code !== 'MANUAL_REVIEW_REQUIRED') throw err;
      multipleZ03Families = true;
    }
    if (z03ByPhone || multipleZ03Families) {
      req.body.claim = { ...claim, student_name: studentName, phone: claimPhone };
      return _completeLocalZ03Claim(req, res, { phone, lineUid });
    }

    let ragicRow;
    try {
      ragicRow = await ragic.getParentByPhone(phone);
    } catch (err) {
      console.warn('[auth/verify-student] ragic.getParentByPhone failed:', err.code || '', err.message);
      const r = _ragicErrorResponse(err);
      return res.status(r.status).json({ error: r.error, code: r.code });
    }
    if (!ragicRow) {
      // 兩次呼叫之間電話記錄消失（極罕見）：回到 S2 重新查詢，不歸類為驗證失敗。
      return res.status(409).json({ error: '資料異動，請重新查詢電話', code: 'PHONE_STATE_CHANGED' });
    }
    const mapped = _mapZ01ParentForIdentity(ragicRow);
    if (!String(mapped.line_uid || '').trim()) {
      try {
        await ragicAdmin.hydrateZ03RecordFromRagicRow(ragicRow);
      } catch (err) {
        console.error('[auth/verify-student] local Z03 hydrate failed:', err.code || '', err.message);
        return res.status(500).json({ error: '本地認領佇列建立失敗', code: 'LOCAL_TRANSACTION_FAILED' });
      }
      req.body.claim = { ...claim, student_name: studentName, phone: claimPhone };
      return _completeLocalZ03Claim(req, res, { phone, lineUid });
    }
    const ragicStudents = ragic.parseZ01Students(ragicRow);

    const verdict = parentSync.classifyStudentPhoneClaim(
      ragicStudents, { student_name: studentName, phone: claimPhone }, mapped.phone || phone
    );
    parentSync.auditClaim({
      phone, lineUid,
      result: verdict === 'matched' ? 'passed' : (verdict === 'not_on_file' ? 'not_on_file_blocked' : 'failed'),
    });

    if (verdict === 'matched') {
      const newToken = signFlowToken({ lineUid, phone, attempts: 0 });
      return res.json({
        status: 'matched',
        flow_token: newToken,
        students: ragicStudents.map((s) => s.name),
      });
    }

    const nextAttempts = attempts + 1;
    if (nextAttempts >= 3) {
      console.warn(
        '[auth/verify-student] 3 次驗證失敗，轉入 S4(phone_collision) phoneHash=%s',
        _phoneHashForLog(phone)
      );
      return res.json({ status: 'exhausted', reason: 'phone_collision' });
    }
    const retryToken = signFlowToken({ lineUid, phone, attempts: nextAttempts });
    return res.status(409).json({
      error: '學員姓名或登記手機號碼與資料不符，請確認後再試',
      code: 'CLAIM_VERIFICATION_FAILED',
      flow_token: retryToken,
      attempts_remaining: 3 - nextAttempts,
    });
  } catch (err) {
    console.error('[auth/verify-student]', err);
    res.status(500).json({ error: '驗證失敗', code: 'VERIFY_STUDENT_FAILED' });
  }
});

// S3b CONFIRM_BIND：交易性綁定（修改 PROMPT §3.4）。Ragic 寫入 + 本地 mirror
// 屬於兩個無法用單一 DB transaction 涵蓋的異質系統操作（HTTP API + Postgres），
// 用「先 Ragic 寫入、成功才本地 refresh、refresh 失敗則補償性清空 Ragic 剛寫入的
// line_uid」模擬整體回滾，避免半套（Ragic 已綁但本地查無對應 parent）。
// uid_conflict（記錄已綁其他真實 LINE UID）不自動改綁，直接分流 Z03 → S5。
router.post('/bind', requireFlowToken, async (req, res) => {
  try {
    const { phone, lineUid, studentName: verifiedStudentName } = req.flow;
    if (await _respondExistingParentFastPath(res, lineUid, 'bound_and_logged_in')) return;
    if (!phone) return res.status(400).json({ error: '請先完成電話與學員驗證', code: 'FLOW_INCOMPLETE' });

    let localZ03 = null;
    let localZ03Multiple = false;
    try {
      localZ03 = await ragicAdmin.findZ03RecordByPhone(phone);
    } catch (err) {
      if (err.code !== 'MANUAL_REVIEW_REQUIRED') throw err;
      localZ03Multiple = true;
    }
    if (localZ03 || localZ03Multiple) {
      if (!req.body?.claim?.student_name) {
        return res.status(400).json({
          error: 'Z03 認領需帶入已驗證的學員姓名',
          code: 'CLAIM_REQUIRED',
        });
      }
      req.body.claim.phone = req.body.claim.phone || phone;
      return _completeLocalZ03Claim(req, res, { phone, lineUid });
    }

    let ragicRow;
    try {
      ragicRow = await ragic.getParentByPhone(phone);
    } catch (err) {
      console.warn('[auth/bind] ragic.getParentByPhone failed:', err.code || '', err.message);
      const r = _ragicErrorResponse(err);
      return res.status(r.status).json({ error: r.error, code: r.code });
    }
    if (!ragicRow) {
      return res.status(409).json({ error: '資料異動，請重新查詢電話', code: 'PHONE_STATE_CHANGED' });
    }
    const mapped = _mapZ01ParentForIdentity(ragicRow);

    const hasOtherRealUid = Boolean(
      mapped.line_uid && mapped.line_uid !== lineUid
      && !mapped.line_uid.startsWith('demo:') && !mapped.line_uid.startsWith('DEMOTEST_')
    );
    if (hasOtherRealUid) {
      parentSync.auditClaim({ phone, lineUid, result: 'uid_conflict' });
      if (!verifiedStudentName) {
        const duplicateUidCorrelationId = crypto.randomUUID();
        await createParentIdentityBackofficeTask({
          phone,
          sourceRecordIds: sourceIds,
          reasonCode: 'MULTIPLE_UID_SOURCE_NO_WINNER',
          suggestedAction: 'Review source links/student evidence, select one primary Z01, and retain the others as aliases.',
          correlationId: duplicateUidCorrelationId,
        });
        return res.status(409).json({
          error: '帳號恢復前必須重新完成學員驗證',
          code: 'ACCOUNT_RECOVERY_VERIFYING',
          internalCode: 'ACCOUNT_RECOVERY_VERIFYING',
          retryable: false,
          loginAllowed: false,
          syncState: 'ACCOUNT_RECOVERY_VERIFYING',
        });
      }
      let recovery;
      try {
        recovery = await requestAccountRecovery({
          phone,
          studentName: verifiedStudentName,
          newLineUid: lineUid,
          ragicRecordId: mapped.ragic_record_id,
          initiatedBy: 'parent-bind',
        });
      } catch (err) {
        if (err instanceof AccountRecoveryError) {
          return res.status(err.http || 409).json({
            error: err.message,
            code: err.code,
            internalCode: err.code,
            retryable: false,
            loginAllowed: false,
            syncState: err.code,
          });
        }
        throw err;
      }
      return res.status(409).json({
        error: '此手機已綁定其他 LINE 帳號，請完成帳號恢復驗證',
        code: 'ACCOUNT_RECOVERY_REQUIRED',
        internalCode: 'ACCOUNT_RECOVERY_REQUIRED',
        retryable: false,
        correlationId: recovery.correlation_id,
        loginAllowed: false,
        syncState: 'ACCOUNT_RECOVERY_REQUIRED',
        recovery_request_id: recovery.recovery_request_id,
        recovery_token: recovery.recovery_token,
        recovery_expires_at: recovery.expires_at,
        replayed: recovery.replayed,
      });
    }
    if (!mapped.line_uid) {
      try {
        await ragicAdmin.hydrateZ03RecordFromRagicRow(ragicRow);
      } catch (err) {
        return res.status(500).json({
          error: '來源已找到，但本地 staging 建立失敗', code: 'LOCAL_LINK_FAILED',
          internalCode: 'LOCAL_LINK_FAILED', retryable: false,
          correlationId: crypto.randomUUID(), loginAllowed: false, syncState: null,
        });
      }
      if (!req.body?.claim?.student_name) {
        return res.status(400).json({ error: '請帶入已驗證的學員姓名', code: 'CLAIM_REQUIRED' });
      }
      req.body.claim.phone = req.body.claim.phone || phone;
      return _completeLocalZ03Claim(req, res, { phone, lineUid });
    }

    const local = await parentSync.linkFromRagicRecordLocalFirst(ragicRow, lineUid);
    const issued = _issue(local);
    const students = await loadStudents(local.id);
    return res.json({
      status: 'bound_and_logged_in', parent: { ...issued, students }, token: issued.token,
      sync_state: 'SYNCED', loginAllowed: true,
    });
  } catch (err) {
    console.error('[auth/bind]', err);
    res.status(500).json({ error: '綁定失敗', code: 'BIND_FAILED' });
  }
});

// No OTP provider is configured in this project. Account recovery therefore
// uses the approved manual path only: an admin must cite evidence and present
// the parent's short-lived, single-use recovery token. The service performs
// verification, local rebind, audit, and outbox enqueue in one DB transaction.
router.post(
  '/parent-account-recovery/manual-complete',
  requireAdminAuth,
  requireAdminRole('admin'),
  async (req, res) => {
    try {
      const result = await completeManualAccountRecovery({
        recoveryRequestId: req.body?.recovery_request_id,
        recoveryToken: req.body?.recovery_token,
        approvedBy: req.adminUser?.username || req.adminUser?.sub,
        reason: req.body?.reason,
        evidenceReference: req.body?.evidence_reference,
      });
      return res.json({
        ok: true,
        state: result.state,
        sync_state: result.sync_state || 'ACCOUNT_REBIND_SYNC_PENDING',
        replayed: result.replayed,
        canonical_parent_id: result.parent?.id,
        correlation_id: result.correlation_id,
      });
    } catch (err) {
      if (err instanceof AccountRecoveryError) {
        return res.status(err.http || 409).json({ error: err.message, code: err.code });
      }
      console.error('[auth/account-recovery] failed:', err.code || err.message);
      return res.status(500).json({ error: '帳號恢復失敗', code: 'ACCOUNT_RECOVERY_FAILED' });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// 家長手機綁定（legacy 一次到位版；封閉狀態機請改用上面 verify-phone/
// verify-student/bind 三支。此端點暫保留供現行前端相容，見交付文件說明）
//   200 { status:'bound_and_logged_in', parent, token }
//   200 { status:'need_registration',   phone }
//   409 LINE_ALREADY_BOUND_TO_OTHER_PHONE / PHONE_ALREADY_BOUND_TO_OTHER_LINE
// ─────────────────────────────────────────────────────────────
router.post('/parent-bind-phone', async (req, res) => {
  try {
    const lineUid = await _verifyLineUid(req, res);
    if (!lineUid) return;
    if (await _respondExistingParentFastPath(res, lineUid, 'bound_and_logged_in')) return;

    const phone = String(req.body?.phone || '').trim();
    if (!phone) return res.status(400).json({ error: '手機必填', code: 'PHONE_REQUIRED' });
    if (!TW_PHONE_RE.test(phone)) {
      return res.status(400).json({ error: '手機格式錯誤（需 09xxxxxxxx）', code: 'PHONE_FORMAT_INVALID' });
    }

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
    if (dupPhone.rowCount && dupPhone.rows[0].line_uid === lineUid) {
      const local = (await pool.query(
        `SELECT id,name,phone,line_uid,primary_venue_id,gender,email,identity,
                home_phone,home_address,line_id
           FROM parents WHERE phone=$1 AND line_uid=$2 AND is_active=TRUE`,
        [phone, lineUid]
      )).rows[0];
      if (local) {
        const issued = _issue(local);
        const students = await loadStudents(local.id);
        return res.json({
          status: 'bound_and_logged_in',
          parent: { ...issued, students },
          token: issued.token,
          replayed: true,
        });
      }
    }

    // 2) 本地 Z03 已有此電話：必須在該家庭的子表內用 normalized exact
    // student name 認領。不能導去「找不到就註冊」，否則 retry 會重新建立 identity。
    let z03ByPhone = null;
    let multipleZ03Families = false;
    try {
      z03ByPhone = await ragicAdmin.findZ03RecordByPhone(phone);
    } catch (err) {
      if (err.code !== 'MANUAL_REVIEW_REQUIRED') throw err;
      multipleZ03Families = true;
    }
    if (z03ByPhone || multipleZ03Families) {
      if (z03ByPhone?.parent?.line_uid && z03ByPhone.parent.line_uid !== lineUid) {
        return res.status(409).json({
          error: '此手機已綁定其他 LINE 帳號，請聯絡客服處理',
          code: 'PHONE_ALREADY_BOUND_TO_OTHER_LINE',
        });
      }
      if (req.body?.claim) {
        return _completeLocalZ03Claim(req, res, { phone, lineUid });
      }
      return res.json({ status: 'need_claim_verification', phone, reason: 'local_z03_pending' });
    }
    // 3) Ragic Z01 by phone
    let ragicRow = null;
    try {
      ragicRow = await ragic.getParentByPhone(phone);
    } catch (err) {
      console.warn('[auth/parent-bind-phone] ragic.getParentByPhone failed:', err.code || '', err.message);
      const r = _ragicErrorResponse(err);
      return res.status(r.status).json({ error: r.error, code: r.code });
    }

    // 4) Ragic 也找不到 → 引導去註冊
    if (!ragicRow) {
      return res.json({ status: 'need_registration', phone });
    }

    const mapped = _mapZ01ParentForIdentity(ragicRow);

    // Reconciliation lag safety: a blank true UID record should already be in
    // local Z03. If it is not, hydrate the exact source record read-only, then
    // use the same local-first claim. Never write Ragic in this auth request.
    if (!String(mapped.line_uid || '').trim()) {
      try {
        await ragicAdmin.hydrateZ03RecordFromRagicRow(ragicRow);
      } catch (err) {
        console.error('[auth/parent-bind-phone] local Z03 hydrate failed:', err.code || '', err.message);
        return res.status(500).json({
          error: '舊資料已找到，但本地認領佇列建立失敗，已停止重試流程',
          code: 'LOCAL_TRANSACTION_FAILED',
        });
      }
      if (req.body?.claim) {
        return _completeLocalZ03Claim(req, res, { phone, lineUid });
      }
      return res.json({ status: 'need_claim_verification', phone, reason: 'ragic_z01_blank_uid' });
    }
    const needsAccountRecovery = mapped.line_uid !== lineUid || localPhoneHasOtherUid;
    if (needsAccountRecovery) {
      const ragicStudents = ragic.parseZ01Students(ragicRow);
      const claim = req.body?.claim || null;
      if (!claim?.student_name || !claim?.phone) {
        parentSync.auditClaim({ phone, lineUid, result: 'need_verification', reason: 'account_recovery' });
        return res.json({ status: 'need_claim_verification', phone, reason: 'account_recovery' });
      }
      const verdict = parentSync.classifyStudentPhoneClaim(ragicStudents, claim, mapped.phone || phone);
      if (verdict !== 'matched') {
        parentSync.auditClaim({ phone, lineUid, result: 'failed', reason: verdict });
        return res.status(409).json({
          error: verdict === 'not_on_file'
            ? '既有家庭中找不到此學員，資料已停止自動認領'
            : '學員姓名或登記手機號碼與資料不符，無法啟動帳號恢復。',
          code: verdict === 'not_on_file' ? 'DATA_RECONCILIATION_PENDING' : 'CLAIM_VERIFICATION_FAILED',
          internalCode: verdict === 'not_on_file' ? 'IDENTITY_NOT_FOUND' : 'CLAIM_VERIFICATION_FAILED',
          retryable: false,
          loginAllowed: false,
          syncState: verdict === 'not_on_file' ? 'DATA_RECONCILIATION_PENDING' : null,
        });
      }
      let recovery;
      try {
        recovery = await requestAccountRecovery({
          phone,
          studentName: claim.student_name,
          newLineUid: lineUid,
          ragicRecordId: mapped.ragic_record_id,
          initiatedBy: 'parent-bind-phone',
        });
      } catch (err) {
        if (err instanceof AccountRecoveryError) {
          return res.status(err.http || 409).json({
            error: err.message,
            code: err.code,
            internalCode: err.code,
            retryable: false,
            loginAllowed: false,
            syncState: err.code,
          });
        }
        throw err;
      }
      parentSync.auditClaim({ phone, lineUid, result: 'recovery_required', reason: 'verified_uid_conflict' });
      return res.status(409).json({
        error: '此家庭已綁定其他 LINE 帳號，請完成帳號恢復驗證',
        code: 'ACCOUNT_RECOVERY_REQUIRED',
        internalCode: 'ACCOUNT_RECOVERY_REQUIRED',
        retryable: false,
        loginAllowed: false,
        syncState: 'ACCOUNT_RECOVERY_REQUIRED',
        correlationId: recovery.correlation_id,
        recovery_request_id: recovery.recovery_request_id,
        recovery_token: recovery.recovery_token,
        recovery_expires_at: recovery.expires_at,
        replayed: recovery.replayed,
      });
    }

    // 5) Z01 不完整不可登入/綁定，改導註冊補齊。line_uid 會在本流程寫入，故此處不列入缺欄。
    const missing = parentRefresh.getZ01MissingFields(mapped, { requireLineUid: false });
    if (missing.length) {
      return res.json({
        status: 'need_registration',
        phone,
        reason: 'z01_incomplete',
        missing_fields: missing.map((m) => m.key),
      });
    }

    // 1006846 已等於本次 UID：只用目前已讀到的來源完成本地 transaction，
    // 不在 auth hot path 再讀／寫 Ragic。
    const local = await parentSync.linkFromRagicRecordLocalFirst(ragicRow, lineUid);
    const issued = _issue(local);
    const students = await loadStudents(local.id);
    return res.json({
      status: 'bound_and_logged_in', parent: { ...issued, students }, token: issued.token,
      sync_state: 'SYNCED', loginAllowed: true,
    });
  } catch (err) {
    console.error('[auth/parent-bind-phone]', err);
    res.status(500).json({ error: '綁定失敗', code: 'BIND_FAILED' });
  }
});

// ─────────────────────────────────────────────────────────────
// 家長 LINE 註冊（以電話號碼為冪等鍵，永不重複建立同號 Z01）
//   · Ragic 查無此電話            → 建立 Z01 主表 + Z02 學員 + 本地 + 簽 JWT
//   · 已有此電話且「未綁 LINE UID」（未開通，Z03 清洗池）→ found→update 就地開通：
//     名下有學員先過認領驗證（用表單學員姓名+身分證比對）→ 表單學員入 Z02 →
//     既有 Z01 一次 PATCH（回寫 UID＋清洗佔位姓名＋補空欄）→ 本地 + Z03 畢業 + 簽 JWT
//   · 已有此電話且已綁「其他」LINE UID（已開通）→ 409 擋下（防帳號搶占）
//
// 核心邏輯抽成共用函式（lineUid 由呼叫端決定如何取得），供下面兩支端點共用：
//   · POST /parent-register-line（legacy，id_token 版，暫留供現行前端相容）
//   · POST /register（封閉狀態機 S4 REGISTER_NEW，flowToken 版，見下方定義）
// 避免兩支各維護一份、行為漂移。
//
// Request:
//   { id_token,
//     parent:   { name, phone, gender?, email?, primary_venue_id? },
//     students: [{ name, id_number, birth_date, gender, blood_type }, ...] }
//
// Responses:
//   200 { status:'registered_and_logged_in', parent, token, linked_existing? }
//   400 INPUT_INVALID / PHONE_FORMAT_INVALID / ID_NUMBER_INVALID
//   401 LINE_VERIFY_FAILED
//   409 LINE_ALREADY_BOUND_TO_OTHER_PHONE / LINE_ALREADY_REGISTERED / PHONE_EXISTS_USE_BINDING
//   502 RAGIC_UNAVAILABLE / RAGIC_WRITE_FAILED
// ─────────────────────────────────────────────────────────────
// 先驗證 LINE token 並走本地 active line_uid fast path；命中時不讀表單、
// 不查 Ragic，因此舊 token/session 不會因 profile 或學員缺欄被導回註冊。
// resolveLineUid 回傳 null/undefined 時視為已自行寫好回應。
async function _registerParentCore(req, res, resolveLineUid) {
    const lineUid = await resolveLineUid();
    if (!lineUid) return;
    if (await _respondExistingParentFastPath(res, lineUid, 'registered_and_logged_in')) return;

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
    // Email 於 2026-08-03 改為註冊必填（使用者決策）。
    // 原設計把 Email 視為「資料完整度」而非身分，留空由 outbox 事後補回寫；但 outbox 的
    // RAGIC_PARENT_OUTBOX 旗標實際是關閉的，Ragic Z01「(報)Email」又是必填欄，於是留空的
    // 家長寫不回 Ragic（INVALID 202），連帶讓該家長之後每次 /parents/me/sync 都失敗。
    // 在入口擋住，是為了不再產生新的無解資料；既有留空者仍需另行補齊。
    const email  = String(parentIn.email  || '').trim();
    const gender = String(parentIn.gender || '').trim();
    if (!email)                        return res.status(400).json({ error: 'Email 必填',     code: 'EMAIL_REQUIRED' });
    if (!EMAIL_RE.test(email))         return res.status(400).json({ error: 'Email 格式錯誤', code: 'EMAIL_FORMAT_INVALID' });
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
        return res.status(400).json({ error: `第 ${i + 1} 位學員姓名必填`, code: 'STUDENT_NAME_REQUIRED' });
      }
      let idNum = String(s.id_number || '').trim().toUpperCase();
      if (!idNum) {
        return res.status(400).json({ error: `第 ${i + 1} 位學員身分證字號必填`, code: 'STUDENT_ID_REQUIRED' });
      }
      if (!TW_ID_RE.test(idNum)) {
        return res.status(400).json({ error: `第 ${i + 1} 位學員身分證字號格式錯誤`, code: 'ID_NUMBER_INVALID' });
      }
      const birthDate = String(s.birth_date || '').trim();
      if (!birthDate) {
        return res.status(400).json({ error: `第 ${i + 1} 位學員出生年月日必填`, code: 'STUDENT_BIRTH_DATE_REQUIRED' });
      }
      if (!ISO_DATE_RE.test(birthDate) || Number.isNaN(new Date(`${birthDate}T00:00:00+08:00`).getTime())) {
        return res.status(400).json({ error: `第 ${i + 1} 位學員出生年月日格式錯誤`, code: 'STUDENT_BIRTH_DATE_INVALID' });
      }
      const studentGender = String(s.gender || '').trim();
      if (!studentGender) {
        return res.status(400).json({ error: `第 ${i + 1} 位學員性別必填`, code: 'STUDENT_GENDER_REQUIRED' });
      }
      const bloodType = String(s.blood_type || '').trim();
      if (!bloodType) {
        return res.status(400).json({ error: `第 ${i + 1} 位學員血型必填`, code: 'STUDENT_BLOOD_TYPE_REQUIRED' });
      }
      if (!STUDENT_BLOOD_TYPES.has(bloodType)) {
        return res.status(400).json({ error: `第 ${i + 1} 位學員血型格式錯誤`, code: 'STUDENT_BLOOD_TYPE_REQUIRED' });
      }
      cleanStudents.push({
        name: sName,
        id_number:  idNum,
        birth_date: birthDate,
        gender:     studentGender,
        blood_type: bloodType,
      });
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

    const GENERIC_PHONE_CONFLICT = {
      error: '此手機已存在於系統，請改用「以手機綁定」流程',
      code: 'PHONE_EXISTS_USE_BINDING',
    };
    if (dupPhoneLocal.rowCount && dupPhoneLocal.rows[0].line_uid === lineUid) {
      return res.status(409).json({
        error: '此 LINE 帳號已註冊，請改走登入流程',
        code: 'LINE_ALREADY_REGISTERED',
      });
    }

    if (STABILITY_FLAGS.PARENT_IDENTITY_RESOLVER_V2) {
      const uidSources = await ragicAdmin.findZ01SourcesByTrueLineUid(lineUid);
      if (uidSources.length > 1) {
        const sourceIds = uidSources.map((source) => String(source._ragicId || '')).filter(Boolean);
        const links = (await pool.query(
          `SELECT source_record_id,canonical_parent_id,link_method FROM source_record_links
            WHERE source_system='RAGIC' AND source_table='Z01' AND source_record_id=ANY($1::text[])
            ORDER BY source_record_id`, [sourceIds]
        )).rows;
        const primaryLinks = links.filter((row) => row.link_method !== 'MULTIPLE_SOURCE_ALIAS');
        let winnerId = primaryLinks.length === 1 ? String(primaryLinks[0].source_record_id) : '';
        if (!winnerId) {
          const persisted = (await pool.query(
            `SELECT ragic_record_id FROM parents WHERE ragic_record_id=ANY($1::text[]) ORDER BY id`,
            [sourceIds]
          )).rows.map((row) => String(row.ragic_record_id));
          if ([...new Set(persisted)].length === 1) winnerId = persisted[0];
        }
        if (!winnerId) {
          const wanted = normalizeStudentName(cleanStudents[0].name);
          const studentEvidence = uidSources.filter((source) =>
            normalizePhone(ragic.mapZ01Parent(source)?.phone) === normalizePhone(phone)
            && ragic.parseZ01StudentsRaw(source).some((student) => normalizeStudentName(student.name_raw) === wanted));
          if (studentEvidence.length === 1) winnerId = String(studentEvidence[0]._ragicId || '');
        }
        const winner = uidSources.find((source) => String(source._ragicId || '') === winnerId);
        if (winner) {
          const completed = await completeTrueUidRegistration({
            source: winner,
            parentProfile: { ...parentIn, name, phone, email },
            students: cleanStudents,
            lineUid,
            ownershipVerified: true,
          });
          await parentSync.linkSourceAliases({
            parentId: completed.parent.id,
            sourceRecordIds: sourceIds.filter((id) => id !== winnerId),
            studentName: cleanStudents[0].name,
          });
          const issued = _issue(completed.parent);
          const localStudents = await loadStudents(completed.parent.id);
          return res.json({ status: 'registered_and_logged_in', parent: { ...issued, students: localStudents },
            token: issued.token, linked_existing: true, sync_state: completed.sync_state,
            sync_pending: completed.sync_state !== 'SYNCED', loginAllowed: true,
            parent_state: completed.sync_state === 'SYNCED' ? 'AUTHENTICATED' : 'SYNC_IN_PROGRESS',
            correlationId: completed.correlation_id });
        }
        return res.status(409).json({
          error: '同一 LINE 帳號有多筆歷史來源，需完成帳號確認',
          code: 'ACCOUNT_CONFIRMATION_REQUIRED', internalCode: 'MULTIPLE_UID_SOURCE_NO_WINNER',
          retryable: false, correlationId: duplicateUidCorrelationId, loginAllowed: false,
          syncState: 'DATA_RECONCILIATION_PENDING', parent_state: 'ACCOUNT_CONFIRMATION_REQUIRED',
        });
      }
      if (uidSources.length === 1) {
        const source = uidSources[0];
        const mappedSource = _mapZ01ParentForIdentity(source);
        if (normalizePhone(mappedSource.phone) !== normalizePhone(phone)) {
          return res.status(409).json({
            error: '此 LINE UID 的來源手機與本次輸入不一致，需完成帳號恢復驗證',
            code: 'ACCOUNT_RECOVERY_REQUIRED', internalCode: 'ACCOUNT_RECOVERY_REQUIRED',
            retryable: false, correlationId: crypto.randomUUID(), loginAllowed: false,
            syncState: 'ACCOUNT_RECOVERY_REQUIRED',
          });
        }
        const completed = await completeTrueUidRegistration({
          source,
          parentProfile: { ...parentIn, name, phone, email },
          students: cleanStudents,
          lineUid,
          ownershipVerified: true,
        });
        const local = completed.parent;
        const issued = _issue(local);
        const localStudents = await loadStudents(local.id);
        return res.json({ status: 'registered_and_logged_in', parent: { ...issued, students: localStudents },
          token: issued.token, linked_existing: true, sync_state: completed.sync_state,
          sync_pending: completed.sync_state !== 'SYNCED', loginAllowed: true,
          parent_state: completed.sync_state === 'SYNCED' ? 'AUTHENTICATED' : 'SYNC_IN_PROGRESS',
          correlationId: completed.correlation_id });
      }

      const phoneSources = await ragicAdmin.findZ01SourcesByPhone(phone);
      const conflictingPhoneUid = phoneSources.find((source) => {
        const sourceUid = getTrueRagicLineUid(source);
        return sourceUid && sourceUid !== lineUid;
      });
      if (conflictingPhoneUid) {
        return res.status(409).json({
          error: '既有家庭已綁定其他 LINE UID，需完成帳號恢復驗證',
          code: 'ACCOUNT_RECOVERY_REQUIRED', internalCode: 'ACCOUNT_RECOVERY_REQUIRED',
          retryable: false, correlationId: crypto.randomUUID(), loginAllowed: false,
          syncState: 'ACCOUNT_RECOVERY_REQUIRED', parent_state: 'ACCOUNT_CONFIRMATION_REQUIRED',
        });
      }
      const wantedStudent = normalizeStudentName(cleanStudents[0].name);
      const sourceMatches = phoneSources.filter((source) =>
        ragic.parseZ01StudentsRaw(source).some((student) =>
          normalizeStudentName(student.name_raw) === wantedStudent));
      if (sourceMatches.length) {
        const conflictingUid = sourceMatches.find((source) => {
          const uid = getTrueRagicLineUid(source);
          return uid && uid !== lineUid;
        });
        if (conflictingUid) {
          return res.status(409).json({
            error: '既有家庭已綁定其他 LINE UID，需完成帳號恢復驗證',
            code: 'ACCOUNT_RECOVERY_REQUIRED', internalCode: 'ACCOUNT_RECOVERY_REQUIRED',
            retryable: false, correlationId: crypto.randomUUID(), loginAllowed: false,
            syncState: 'ACCOUNT_RECOVERY_REQUIRED',
          });
        }
        const currentUidSource = sourceMatches.find((source) => getTrueRagicLineUid(source) === lineUid);
        if (currentUidSource) {
          const completed = await completeTrueUidRegistration({
            source: currentUidSource,
            parentProfile: { ...parentIn, name, phone, email },
            students: cleanStudents,
            lineUid,
            ownershipVerified: true,
          });
          const local = completed.parent;
          await parentSync.linkSourceAliases({
            parentId: local.id,
            sourceRecordIds: sourceMatches.map((source) => source._ragicId),
            studentName: cleanStudents[0].name,
          });
          const issued = _issue(local);
          const localStudents = await loadStudents(local.id);
          return res.json({ status: 'registered_and_logged_in', parent: { ...issued, students: localStudents },
            token: issued.token, linked_existing: true, sync_state: completed.sync_state,
            sync_pending: completed.sync_state !== 'SYNCED', loginAllowed: true,
            parent_state: completed.sync_state === 'SYNCED' ? 'AUTHENTICATED' : 'SYNC_IN_PROGRESS',
            correlationId: completed.correlation_id });
        }
        for (const source of sourceMatches) {
          if (!getTrueRagicLineUid(source)) await ragicAdmin.hydrateZ03RecordFromRagicRow(source);
        }
        req.body.claim = {
          student_name: cleanStudents[0].name,
          phone,
          parent_name: name,
        };
        return _completeLocalZ03Claim(req, res, {
          phone,
          lineUid,
          successStatus: 'registered_and_logged_in',
          allowStudentAppend: true,
          parentProfile: { ...parentIn, name, phone, email },
          studentInput: cleanStudents[0],
          ownershipVerified: true,
        });
      }
      // Phone exists but the submitted child is new (including zero-student
      // legacy rows). Hydrate every blank-UID source, then let the multi-source
      // claim resolver append under one canonical parent.
      for (const source of phoneSources) {
        if (!getTrueRagicLineUid(source)) await ragicAdmin.hydrateZ03RecordFromRagicRow(source);
      }
    }

    // 註冊分流定案（2026-07-03）：
    //   1. 先比對本地 Z01（上面的 local phone/uid guard）；
    //   2. 本地 Z01 無可登入資料 → 用電話比對本地 Z03；
    //   3. Z03 命中 → 註冊表單補欄、回寫 Ragic Z01/Z02、標記 Z03 resolved、refresh 回本地 Z01；
    //   4. Z03 尚未被排程拉入時，才以 phone 對 Ragic 做一次 read-only hydrate，避免使用者被迫手動同步；
    //   5. 仍查無 → 全新電話，建立新的 Ragic Z01/Z02。
    let linkedExisting = false;
    let z03Match = null;
    try {
      z03Match = await ragicAdmin.findZ03RecordByPhone(phone);
    } catch (err) {
      if (err.code !== 'MANUAL_REVIEW_REQUIRED') throw err;
      // Do not LIMIT 1 and do not create a duplicate family. The claim service
      // evaluates source-link / parent Ragic ID / student evidence across all
      // candidates, preserving aliases or routing an unresolved primary to the
      // reconciliation queue while still keeping one local identity.
      z03Match = { multiple_candidates: true, z03_ids: err.z03Ids || [] };
    }
    if (z03Match) {
      req.body.claim = { student_name: cleanStudents[0].name, phone, parent_name: name };
      return _completeLocalZ03Claim(req, res, {
        phone,
        lineUid,
        successStatus: 'registered_and_logged_in',
        allowStudentAppend: true,
        parentProfile: { ...parentIn, name, phone, email },
        studentInput: cleanStudents[0],
        ownershipVerified: true,
      });
    }
    let ragicRowByPhone = null;

    // Ragic same-UID guard：註冊前的防重複建檔保險。登入仍只看本地 Z01；
    // 這裡只避免「本地鏡像缺失 + 同 UID 換電話註冊」時在 Ragic 建出第二筆 Z01。
    try {
      const existsByLine = await ragic.getParentByLineUid(lineUid);
      if (existsByLine) {
        const byLine = _mapZ01ParentForIdentity(existsByLine);
        if (byLine.phone && byLine.phone !== phone) {
          return res.status(409).json({
            error: '此 LINE 帳號已綁定其他手機，請改用原手機登入',
            code: 'LINE_ALREADY_BOUND_TO_OTHER_PHONE',
          });
        }
        if (!byLine.phone) {
          return res.status(409).json({
            error: '此 LINE 帳號已有未完成資料，請聯絡客服協助補齊手機資料',
            code: 'LINE_ALREADY_REGISTERED',
          });
        }
        ragicRowByPhone = existsByLine;
        if (!z03Match) {
          try {
            z03Match = await ragicAdmin.hydrateZ03RecordFromRagicRow(existsByLine);
          } catch (err) {
            console.error('[auth/parent-register-line] hydrate Z03 from Ragic UID failed:', err.code || '', err.message);
            const r = _ragicErrorResponse(err, '資料暫時無法完成同步，請稍後再試');
            return res.status(r.status).json({ error: r.error, code: r.code === 'RAGIC_UNAVAILABLE' ? 'RAGIC_WRITE_FAILED' : r.code });
          }
        }
      }
    } catch (err) {
      console.warn('[auth/parent-register-line] ragic.getParentByLineUid guard failed:', err.code || '', err.message);
      const r = _ragicErrorResponse(err);
      return res.status(r.status).json({ error: r.error, code: r.code });
    }

    if (!z03Match) {
      try {
        ragicRowByPhone = ragicRowByPhone || await ragic.getParentByPhone(phone);
      } catch (err) {
        console.warn('[auth/parent-register-line] ragic.getParentByPhone hydrate failed:', err.code || '', err.message);
        const r = _ragicErrorResponse(err);
        return res.status(r.status).json({ error: r.error, code: r.code });
      }
      if (ragicRowByPhone) {
        const existing = _mapZ01ParentForIdentity(ragicRowByPhone);
        if (existing.line_uid && existing.line_uid !== lineUid) {
          return res.status(409).json(GENERIC_PHONE_CONFLICT);
        }
        try {
          z03Match = await ragicAdmin.hydrateZ03RecordFromRagicRow(ragicRowByPhone);
        } catch (err) {
          console.error('[auth/parent-register-line] hydrate Z03 from Ragic failed:', err.code || '', err.message);
          const r = _ragicErrorResponse(err, '資料暫時無法完成同步，請稍後再試');
          return res.status(r.status).json({ error: r.error, code: r.code === 'RAGIC_UNAVAILABLE' ? 'RAGIC_WRITE_FAILED' : r.code });
        }
        if (!z03Match) {
          return res.status(409).json(GENERIC_PHONE_CONFLICT);
        }
      }
    }

    if (z03Match) {
      // Registration is the ownership-confirmed completion path for legacy
      // families. Exact-name students are linked; a missing student is appended
      // under the same canonical parent/source record through the local-first
      // transaction and outbox. No synchronous Ragic failure can block login.
      req.body.claim = {
        student_name: cleanStudents[0].name,
        phone,
        parent_name: name,
      };
      return _completeLocalZ03Claim(req, res, {
        phone,
        lineUid,
        successStatus: 'registered_and_logged_in',
        allowStudentAppend: true,
        parentProfile: { ...parentIn, name, phone, email },
        studentInput: cleanStudents[0],
        ownershipVerified: true,
      });
      /* istanbul ignore next -- frozen rollback-only legacy code */
      const existing = z03Match.parent || {};
      if (z03Match.row?.status === 'dismissed') {
        return res.status(409).json(GENERIC_PHONE_CONFLICT);
      }
      // pending 是正常註冊候選；resolved 只作「Ragic 已完成但本地鏡像缺失」的恢復路徑，
      // 必須仍是同電話，不能拿歷史 resolved row 認領到另一支手機。
      if (z03Match.row?.status === 'resolved' && _phoneDigits(existing.phone) !== _phoneDigits(phone)) {
        return res.status(409).json(GENERIC_PHONE_CONFLICT);
      }
      if (existing.line_uid && existing.line_uid !== lineUid) {
        return res.status(409).json(GENERIC_PHONE_CONFLICT);
      }

      // 認領驗證：既有家庭名下有學員才需要。表單任一位學員與既有 Z03 學員
      // （姓名＋身分證）對上即放行。
      // ★ no_id_on_file 也放行（2026-07-03 政策調整）：上線前匯入的舊生資料 2/3 的
      //   學員端沒有身分證字號可比對，硬要求「姓名＋身分證都對上」等於把這批
      //   老客戶永遠擋在 409（資料缺口不是使用者打錯）。改為「姓名精確對上、且該筆
      //   Z03 學員本來就沒存身分證」即視為通過（電話＋學員姓名雙要素）；
      //   Z03 有存身分證但對不上的仍一律擋（防冒用）。audit 以 passed_no_id_on_file
      //   區分記錄，供事後稽核。
      const z03Students = z03Match.students || [];
      if (!existing.line_uid && z03Students.length > 0) {
        // At least one submitted student must prove membership. not_on_file is
        // never automatic ownership evidence; matched/no_id_on_file retain the
        // frozen phone + exact-name compatibility path.
        let verdict = 'not_on_file';
        let sawMismatch = false;
        for (const s of cleanStudents) {
          const v = parentSync.classifyStudentClaim(z03Students, { student_name: s.name, id_number: s.id_number || '' });
          if (v === 'matched') { verdict = 'matched'; sawMismatch = false; break; }
          if (v === 'no_id_on_file') { verdict = 'no_id_on_file'; continue; }
          if (v === 'mismatch') { sawMismatch = true; continue; }
          // v === 'not_on_file'：維持目前 verdict，除非還沒有更好的結果
        }
        if (verdict !== 'matched' && verdict !== 'no_id_on_file' && sawMismatch) verdict = 'mismatch';

        if (verdict === 'mismatch' || verdict === 'not_on_file') {
          console.warn(
            '[auth/parent-register-line] GENERIC_PHONE_CONFLICT phoneHash=%s submittedNames=%j onFileNames=%j',
            _phoneHashForLog(phone), cleanStudents.map((s) => s.name), z03Students.map((s) => s.name)
          );
          parentSync.auditClaim({ phone, lineUid, result: 'failed', reason: verdict });
          if (verdict === 'not_on_file') {
            return res.status(409).json({
              error: '既有家庭中找不到此學員，資料已停止自動認領並進入整理流程。',
              code: 'DATA_RECONCILIATION_PENDING',
              internalCode: 'IDENTITY_NOT_FOUND',
              retryable: false,
              loginAllowed: false,
              syncState: 'DATA_RECONCILIATION_PENDING',
            });
          }
          return res.status(409).json(GENERIC_PHONE_CONFLICT);
        }
        parentSync.auditClaim({
          phone, lineUid,
          result: verdict === 'matched' ? 'passed' : 'passed_no_id_on_file',
          reason: 'register_z03_update',
        });
      }

      try {
        await ragicAdmin.completeZ03Registration({
          z03: z03Match,
          parent: {
            name,
            phone,
            gender: parentIn.gender || null,
            email: parentIn.email || null,
            primary_venue_id: venueId,
            identity: parentIn.identity || '一般身分',
          },
          students: cleanStudents,
          lineUid,
          actor: 'parent-register-line',
        });
      } catch (err) {
        if (err.code === 'STUDENT_ID_NUMBER_EXISTS') {
          return res.status(409).json({
            error: `學員身分證字號 ${err.idNumber || ''} 已被系統內其他學員使用，請確認是否填錯；若確為本人請聯絡客服協助處理。`,
            code: 'STUDENT_ID_NUMBER_EXISTS',
          });
        }
        _logRegistrationSyncFailure('complete_existing_z01_z02', err,
          _registrationLogContext({ phone, venueId, students: cleanStudents, parent: parentIn }));
        const r = _ragicErrorResponse(err, '資料暫時無法完成同步，請稍後再試');
        return res.status(r.status).json({ error: r.error, code: r.code === 'RAGIC_UNAVAILABLE' ? 'RAGIC_WRITE_FAILED' : r.code });
      }
      linkedExisting = true;
    } else {
      if (STABILITY_FLAGS.PARENT_LOCAL_FIRST) {
        try {
          const localFirst = await registerNewParentLocalFirst({
            parent: {
              ...parentIn,
              name,
              phone,
              primary_venue_id: venueId,
              gender,
              email,
            },
            students: cleanStudents,
            lineUid,
            idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotency_key || null,
          });
          const issued = _issue(localFirst.parent);
          const localStudents = await loadStudents(localFirst.parent.id);
          return res.json({
            status: 'registered_and_logged_in',
            parent: { ...issued, students: localStudents },
            token: issued.token,
            linked_existing: false,
            sync_state: localFirst.sync_state,
            sync_pending: true,
            internalCode: 'RAGIC_UID_WRITE_PENDING',
            retryable: true,
            correlationId: localFirst.correlation_id,
            loginAllowed: true,
            replayed: localFirst.replayed,
            ref_bound: false,
            ref_error: req.body?.ref_token ? 'REF_SYNC_PENDING' : null,
          });
        } catch (err) {
          if (err instanceof Z03ClaimError) {
            return res.status(err.http || 409).json({
              error: err.message,
              code: err.code,
              internalCode: err.code,
              retryable: false,
              correlationId: err.correlationId || crypto.randomUUID(),
              loginAllowed: false,
              syncState: err.code,
            });
          }
          throw err;
        }
      }

      // Rollback-only legacy path when PARENT_LOCAL_FIRST=false.
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
        _logRegistrationSyncFailure('create_new_z01_z02', err,
          _registrationLogContext({ phone, venueId, students: cleanStudents, parent: parentIn }));
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
}

router.post('/parent-register-line', async (req, res) => {
  try {
    await _registerParentCore(req, res, async () => {
      // 測試用「Demo 新用戶」已停用：Z01 只允許真實 LINE UID，demo 註冊不得再寫
      // DEMOTEST_ 假 UID 到 Ragic。固定測試帳號請走 /api/auth/demo-login（本地 demo:<phone> sentinel）。
      const demoNewUser = process.env.ALLOW_DEMO_LOGIN === '1' && req.body?.demo === true;
      if (demoNewUser) {
        res.status(410).json({
          error: 'Demo 新用戶註冊已停用；請使用固定測試帳號登入',
          code: 'DEMO_REGISTER_DISABLED',
        });
        return null;
      }
      return _verifyLineUid(req, res);
    });
  } catch (err) {
    console.error('[auth/parent-register-line]', err);
    res.status(500).json({ error: '註冊失敗', code: 'REGISTER_FAILED' });
  }
});

// S4 REGISTER_NEW（封閉狀態機，flowToken 版）：與上面 legacy 差別僅在如何取得
// lineUid（flowToken 而非 id_token），業務邏輯完全共用 _registerParentCore。
// 唯一分支：flowToken 帶有 phone 時，代表是從 S3 verify-student 三次驗證失敗的
// phone_collision 轉入（見 /verify-student），而非 S2 not_found 的全新電話——這支
// 電話已在 Ragic 對到一個既有家庭，但使用者三次都無法證明自己是該家庭成員，屬
// 可疑行為。不論這次表單填了什麼，都不可完成正式註冊或建立第二筆同電話 parent
// 記錄，一律導入 Z03 待審（S5），交由人工複核（規格 §5/§7 明定的刻意行為，非疏漏）。
router.post('/register', requireFlowToken, async (req, res) => {
  try {
    const { lineUid, phone } = req.flow;
    if (await _respondExistingParentFastPath(res, lineUid, 'registered_and_logged_in')) return;
    if (phone) {
      let ragicRow = null;
      try {
        ragicRow = await ragic.getParentByPhone(phone);
      } catch (err) {
        console.warn('[auth/register] phone_collision lookup failed:', err.code || '', err.message);
        const r = _ragicErrorResponse(err);
        return res.status(r.status).json({ error: r.error, code: r.code });
      }
      if (ragicRow) {
        try {
          await ragicAdmin.hydrateZ03RecordFromRagicRow(ragicRow);
        } catch (err) {
          console.error('[auth/register] phone_collision Z03 hydrate failed:', err.message);
        }
      }
      parentSync.auditClaim({ phone, lineUid, result: 'phone_collision_blocked', reason: 'register_phone_collision' });
      return res.json({ status: 'pending_review', reason: 'phone_collision' });
    }
    await _registerParentCore(req, res, async () => lineUid);
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: '註冊失敗', code: 'REGISTER_FAILED' });
  }
});

router.all('*', (req, res) => {
  res.status(404).json({ error: 'auth endpoint not found', path: req.path });
});

module.exports = router;
