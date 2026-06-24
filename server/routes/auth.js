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
      `SELECT id, name, phone, line_uid, primary_venue_id FROM parents WHERE phone = $1`,
      [acct.phone]
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

async function _resolveVenueId(client, code) {
  if (!code) return null;
  const v = await client.query(`SELECT id FROM venues WHERE id = $1`, [code]);
  return v.rowCount ? code : null;
}

/**
 * Upsert parents（以 phone 為唯一鍵）
 * 安全規則：line_uid 已有不同值時，絕不覆蓋（COALESCE 保護）。
 * - 同 line_uid 視為 same identity，允許覆蓋；不同 line_uid 視為衝突，
 *   行為上以 INSERT-or-UPDATE phone-key 為基礎，line_uid 永遠用 COALESCE
 *   保留既有非空值。
 */
async function upsertLocalParent(client, mapped, lineUid) {
  const name  = mapped.name  || '未命名家長';
  const phone = mapped.phone || '';
  if (!phone) throw new Error('缺少手機，無法 upsert parent');

  const venueId = await _resolveVenueId(client, mapped.primary_venue_id);

  const up = await client.query(
    `INSERT INTO parents
       (phone, name, line_uid, primary_venue_id, gender, email, ragic_record_id,
        identity, home_phone, home_address, line_id)
     VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''),
             NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''))
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       line_uid = COALESCE(parents.line_uid, EXCLUDED.line_uid),
       primary_venue_id = COALESCE(parents.primary_venue_id, EXCLUDED.primary_venue_id),
       gender = COALESCE(NULLIF(EXCLUDED.gender,''), parents.gender),
       email  = COALESCE(NULLIF(EXCLUDED.email,''),  parents.email),
       identity = COALESCE(NULLIF(EXCLUDED.identity,''), parents.identity),
       home_phone = COALESCE(NULLIF(EXCLUDED.home_phone,''), parents.home_phone),
       home_address = COALESCE(NULLIF(EXCLUDED.home_address,''), parents.home_address),
       line_id = COALESCE(NULLIF(EXCLUDED.line_id,''), parents.line_id),
       ragic_record_id = COALESCE(parents.ragic_record_id, EXCLUDED.ragic_record_id),
       is_active = TRUE,   -- 從 Ragic 重新同步到 → 重新啟用（覆蓋先前的軟刪除）
       updated_at = NOW()
     RETURNING id, name, phone, line_uid, primary_venue_id, gender, email, identity, home_phone, home_address, line_id`,
    [phone, name, lineUid || '', venueId,
     ragic.normalizeGender(mapped.gender), mapped.email || '', mapped.ragic_record_id || '',
     mapped.identity || '', mapped.home_phone || '', mapped.home_address || '', mapped.line_id || '']
  );
  return up.rows[0];
}

/**
 * Upsert students：絕不刪除本地已有但本次 Ragic 未回傳的列。
 * 匹配規則：
 *   1) 優先 id_number（若雙方都有）
 *   2) 退而求其次：同 parent_id + name + birth_date
 *   3) 都沒匹配到 → INSERT 新列
 */
async function upsertLocalStudents(client, parentId, students) {
  for (const s of students || []) {
    if (!s || !s.name) continue;
    const idNum = s.id_number ? String(s.id_number).toUpperCase().trim() : null;
    let matched = null;

    if (idNum) {
      const r = await client.query(
        `SELECT id FROM students WHERE parent_id = $1 AND id_number = $2 LIMIT 1`,
        [parentId, idNum]
      );
      matched = r.rows[0] || null;
    }
    if (!matched) {
      const r = await client.query(
        `SELECT id FROM students
          WHERE parent_id = $1 AND name = $2
            AND ($3::date IS NULL OR birth_date = $3::date)
          LIMIT 1`,
        [parentId, s.name, s.birth_date || null]
      );
      matched = r.rows[0] || null;
    }

    if (matched) {
      await client.query(
        `UPDATE students SET
           name = $2,
           birth_date = COALESCE($3::date, birth_date),
           gender = COALESCE(NULLIF($4,''), gender),
           id_number = COALESCE(id_number, NULLIF($5,'')),
           blood_type = COALESCE(NULLIF($6,''), blood_type),
           student_code = COALESCE(NULLIF($7,''), student_code)
         WHERE id = $1`,
        [matched.id, s.name, s.birth_date || null, ragic.normalizeGender(s.gender),
         idNum || '', s.blood_type || '', s.student_code || '']
      );
    } else {
      await client.query(
        `INSERT INTO students (parent_id, name, birth_date, gender, id_number, blood_type, student_code)
         VALUES ($1, $2, $3::date, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), NULLIF($7,''))`,
        [parentId, s.name, s.birth_date || null, ragic.normalizeGender(s.gender),
         idNum || '', s.blood_type || '', s.student_code || '']
      );
    }
  }
}

/**
 * 從 Ragic Z01 record 同步 parent + students 到本地（單一交易）。
 *
 * 同一個 phone 上 advisory lock，避免兩支並發請求（不同 LINE UID）同時通過
 * 「conflict check 在 txn 外、upsert 在 txn 內」之間的縫，導致 loser 拿到
 * winner 的 line_uid（COALESCE 保留先到者）卻簽出 JWT。
 *
 * 流程：lock → 重做 line/phone 衝突檢查 → upsert → 斷言 local.line_uid===lineUid
 */
async function syncFromRagicRecord(z01Row, lineUid) {
  const mapped = ragic.mapZ01Parent(z01Row);
  const students = ragic.parseZ01Students(z01Row);
  return _syncWithLock({ mapped, students, lineUid });
}

class BindConflictError extends Error {
  constructor(code, message, http = 409) {
    super(message);
    this.code = code;
    this.http = http;
  }
}

async function _syncWithLock({ mapped, students, lineUid }) {
  const phone = mapped.phone;
  if (!phone) throw new Error('缺少手機');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // advisory lock：以 phone 為 key，序列化同手機上的所有 bind/register
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`parent_bind:${phone}`]);

    // txn 內重做衝突檢查（防 race）
    const dupLine = await client.query(
      `SELECT phone FROM parents WHERE line_uid = $1 LIMIT 1`, [lineUid]);
    if (dupLine.rowCount && dupLine.rows[0].phone !== phone) {
      throw new BindConflictError('LINE_ALREADY_BOUND_TO_OTHER_PHONE',
        '此 LINE 帳號已綁定其他手機，請改用原手機登入或聯絡客服');
    }
    const dupPhone = await client.query(
      `SELECT line_uid FROM parents WHERE phone = $1 LIMIT 1`, [phone]);
    if (dupPhone.rowCount && dupPhone.rows[0].line_uid && dupPhone.rows[0].line_uid !== lineUid) {
      throw new BindConflictError('PHONE_ALREADY_BOUND_TO_OTHER_LINE',
        '此手機已綁定其他 LINE 帳號，請聯絡客服處理');
    }

    const local = await upsertLocalParent(client, mapped, lineUid);

    // post-upsert guard：upsert 後若 line_uid 對不上 caller 認證的 lineUid → 拒簽 token
    if (local.line_uid && local.line_uid !== lineUid) {
      throw new BindConflictError('PHONE_ALREADY_BOUND_TO_OTHER_LINE',
        '此手機已綁定其他 LINE 帳號，請聯絡客服處理');
    }

    await upsertLocalStudents(client, local.id, students || []);
    await client.query('COMMIT');
    return local;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

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
    console.warn('[auth] verifyLineIdToken failed:', err.message);
    res.status(401).json({ error: 'LINE 驗證失敗', code: 'LINE_VERIFY_FAILED' });
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
    let ragicReachable = true;   // 區分「Ragic 查無此人(=已刪除)」與「Ragic 連不上」
    try {
      ragicRow = await ragic.getParentByLineUid(lineUid);
    } catch (err) {
      ragicReachable = false;
      console.warn('[auth/parent-line-login] ragic.getParentByLineUid failed:', err.message);
    }

    if (ragicRow) {
      try {
        const local = await syncFromRagicRecord(ragicRow, lineUid);
        const issued = _issue(local);
        const students = await loadStudents(local.id);
        return res.json({ status: 'logged_in', parent: { ...issued, students }, token: issued.token });
      } catch (err) {
        if (err instanceof BindConflictError) {
          return res.status(err.http).json({ error: err.message, code: err.code });
        }
        console.error('[auth/parent-line-login] sync failed:', err);
        return res.status(500).json({ error: '同步家長資料失敗', code: 'LOCAL_UPSERT_FAILED' });
      }
    }

    // 2) 退回本地 line_uid 比對。
    //    注意：只有在 Ragic「連不上」時才信任本地（容錯）。
    //    若 Ragic 連得上卻查無此人，代表帳號已從主庫(Ragic)刪除 —— 此時不可用本地舊資料登入，
    //    否則「在 Ragic 刪了帳號還能登入」。同時清掉本地殘留列，讓既有 session 在 requireParent
    //    的 DB 檢查下也立即失效。
    if (!ragicReachable) {
      const local = await pool.query(
        `SELECT id, name, phone, line_uid, primary_venue_id FROM parents WHERE line_uid = $1 AND is_active = TRUE`,
        [lineUid]
      );
      if (local.rowCount) {
        const p = local.rows[0];
        const issued = _issue(p);
        const students = await loadStudents(p.id);
        return res.json({ status: 'logged_in', parent: { ...issued, students }, token: issued.token });
      }
    } else {
      // Ragic 可達且查無此人 → 視為已從主庫刪除，將本地殘留列軟刪除(is_active=FALSE)。
      // 不用硬 DELETE：students.parent_id 為 ON DELETE RESTRICT，有學員時刪不掉；
      // 軟刪除可讓既有 session 在 requireParent 的 is_active 檢查下立即失效。
      try {
        await pool.query(`UPDATE parents SET is_active = FALSE, updated_at = NOW() WHERE line_uid = $1`, [lineUid]);
      } catch (err) {
        console.warn('[auth/parent-line-login] deactivate stale local parent failed:', err.message);
      }
    }

    // 3) 都找不到（或已從 Ragic 刪除）→ 需重新綁定手機
    return res.json({ status: 'need_phone_binding', line_uid: lineUid });
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

    // 1) 本地 line_uid 已綁到不同手機
    const dupLine = await pool.query(`SELECT phone FROM parents WHERE line_uid = $1 LIMIT 1`, [lineUid]);
    if (dupLine.rowCount && dupLine.rows[0].phone !== phone) {
      return res.status(409).json({
        error: '此 LINE 帳號已綁定其他手機，請改用原手機登入或聯絡客服',
        code: 'LINE_ALREADY_BOUND_TO_OTHER_PHONE',
      });
    }
    // 1b) 本地手機已綁到不同 line_uid
    const dupPhone = await pool.query(`SELECT line_uid FROM parents WHERE phone = $1 LIMIT 1`, [phone]);
    if (dupPhone.rowCount && dupPhone.rows[0].line_uid && dupPhone.rows[0].line_uid !== lineUid) {
      return res.status(409).json({
        error: '此手機已綁定其他 LINE 帳號，請聯絡客服處理',
        code: 'PHONE_ALREADY_BOUND_TO_OTHER_LINE',
      });
    }

    // 2) Ragic Z01 by phone
    let ragicRow = null;
    try {
      ragicRow = await ragic.getParentByPhone(phone);
    } catch (err) {
      console.warn('[auth/parent-bind-phone] ragic.getParentByPhone failed:', err.message);
      return res.status(502).json({ error: '資料同步服務暫時無法連線，請稍後再試', code: 'RAGIC_UNAVAILABLE' });
    }

    // 3) Ragic 也找不到 → 引導去註冊
    if (!ragicRow) {
      return res.json({ status: 'need_registration', line_uid: lineUid, phone });
    }

    const mapped = ragic.mapZ01Parent(ragicRow);

    // 4) Ragic 1006846 已被別的 LINE UID 佔用 → 拒絕
    if (mapped.line_uid && mapped.line_uid !== lineUid) {
      return res.status(409).json({
        error: '此手機已綁定其他 LINE 帳號，請聯絡客服處理',
        code: 'PHONE_ALREADY_BOUND_TO_OTHER_LINE',
      });
    }

    // 5) Ragic 1006846 空白 → 寫回 Ragic（best-effort）
    if (!mapped.line_uid && mapped.ragic_record_id) {
      try {
        await ragic.bindParentLineUidToRagic({ ragicRecordId: mapped.ragic_record_id, lineUid });
      } catch (err) {
        console.warn('[auth/parent-bind-phone] bindParentLineUidToRagic failed:', err.message);
      }
    }

    // 6) 同步 parent + students 到本地（含 advisory lock + post-upsert guard）
    try {
      const local = await syncFromRagicRecord(ragicRow, lineUid);
      const issued = _issue(local);
      const students = await loadStudents(local.id);
      return res.json({ status: 'bound_and_logged_in', parent: { ...issued, students }, token: issued.token });
    } catch (err) {
      if (err instanceof BindConflictError) {
        return res.status(err.http).json({ error: err.message, code: err.code });
      }
      console.error('[auth/parent-bind-phone] sync failed:', err);
      return res.status(500).json({ error: '綁定失敗', code: 'LOCAL_UPSERT_FAILED' });
    }
  } catch (err) {
    console.error('[auth/parent-bind-phone]', err);
    res.status(500).json({ error: '綁定失敗', code: 'BIND_FAILED' });
  }
});

// ─────────────────────────────────────────────────────────────
// 新：家長 LINE 註冊（Ragic 都查無 → 建立 Z01 主表 + 子表格 + 本地 + 簽 JWT）
//
// Request:
//   { id_token,
//     parent:   { name, phone, gender?, email?, primary_venue_id? },
//     students: [{ name, id_number?, birth_date?, gender?, blood_type? }, ...] }
//
// Responses:
//   200 { status:'registered_and_logged_in', parent, token }
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

    // 測試用「Demo 新用戶」：ALLOW_DEMO_LOGIN=1 且 body 帶 demo:true 時，不驗 id_token，
    // 改用可辨識的 DEMOTEST_ 前綴 line_uid（仍真寫 Ragic Z01，方便事後依此前綴清除）。
    // production 未設 ALLOW_DEMO_LOGIN → 一律走正規 id_token 驗證（fail-closed，外部無法利用）。
    const demoNewUser = process.env.ALLOW_DEMO_LOGIN === '1' && req.body?.demo === true;
    let lineUid;
    if (demoNewUser) {
      lineUid = `DEMOTEST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    } else {
      lineUid = await _verifyLineUid(req, res);
      if (!lineUid) return;
    }

    // 衝突檢查 1：本地 line_uid 已綁不同手機
    const dupLine = await pool.query(`SELECT phone FROM parents WHERE line_uid = $1 LIMIT 1`, [lineUid]);
    if (dupLine.rowCount && dupLine.rows[0].phone !== phone) {
      return res.status(409).json({
        error: '此 LINE 帳號已綁定其他手機，請改用原手機登入',
        code: 'LINE_ALREADY_BOUND_TO_OTHER_PHONE',
      });
    }

    // 衝突檢查 2：Ragic 已有此 line_uid
    try {
      const existsByLine = await ragic.getParentByLineUid(lineUid);
      if (existsByLine) {
        return res.status(409).json({
          error: '此 LINE 帳號已註冊，請改走登入流程',
          code: 'LINE_ALREADY_REGISTERED',
        });
      }
    } catch (err) {
      console.warn('[auth/parent-register-line] ragic.getParentByLineUid failed:', err.message);
      return res.status(502).json({ error: '資料同步服務暫時無法連線，請稍後再試', code: 'RAGIC_UNAVAILABLE' });
    }

    // 衝突檢查 3：Ragic 已有此 phone
    let existsByPhone = null;
    try {
      existsByPhone = await ragic.getParentByPhone(phone);
    } catch (err) {
      console.warn('[auth/parent-register-line] ragic.getParentByPhone failed:', err.message);
      return res.status(502).json({ error: '資料同步服務暫時無法連線，請稍後再試', code: 'RAGIC_UNAVAILABLE' });
    }
    if (existsByPhone) {
      return res.status(409).json({
        error: '此手機已存在於系統，請改用「以手機綁定」流程',
        code: 'PHONE_EXISTS_USE_BINDING',
      });
    }

    // 寫入 Ragic Z01 主表 + 子表格
    let ragicResult;
    try {
      ragicResult = await ragic.createParentWithStudentsInRagic({
        parent: {
          name, phone,
          gender: parentIn.gender || null,
          email:  parentIn.email  || null,
          primary_venue_id: parentIn.primary_venue_id || null,
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
      console.error('[auth/parent-register-line] createParentWithStudentsInRagic failed:', err.message);
      return res.status(502).json({ error: '資料暫時無法完成同步，請稍後再試', code: 'RAGIC_WRITE_FAILED' });
    }

    // 同步 / 建立本地 parents + students
    const mapped = {
      name, phone,
      gender: parentIn.gender || null,
      email:  parentIn.email  || null,
      primary_venue_id: parentIn.primary_venue_id || null,
      ragic_record_id: ragicResult?.ragicRecordId || null,
      line_uid: lineUid,
    };
    let local;
    try {
      local = await _syncWithLock({ mapped, students: cleanStudents, lineUid });
    } catch (err) {
      if (err instanceof BindConflictError) {
        return res.status(err.http).json({ error: err.message, code: err.code });
      }
      console.error('[auth/parent-register-line] local upsert failed:', err);
      return res.status(500).json({ error: '本地建檔失敗', code: 'LOCAL_UPSERT_FAILED' });
    }

    const issued = _issue(local);
    const students = await loadStudents(local.id);

    // ── MGM ref_token 綁定（失敗不阻擋註冊；與 parents.js 行為相容）──
    let refBound = false;
    let refError = null;
    const refTokenRaw = req.body?.ref_token;
    if (refTokenRaw) {
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
