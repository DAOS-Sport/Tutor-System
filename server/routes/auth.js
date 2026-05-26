/**
 * /api/auth — LIFF 端 token 簽發
 *
 *  POST /api/auth/parent-login        { phone }            → { id, name, phone, token } | null
 *  POST /api/auth/parent-line-login   { id_token }         → 三種狀態見下
 *  POST /api/auth/parent-bind-phone   { id_token, phone }  → 四種狀態見下
 *
 * 教練端登入沿用 routes/coaches.js: POST /api/coaches/by-phone（手機 + id_token）。
 * 後續教練端會改為「只能 LINE UID 登入」，目前不在本檔案範圍。
 */
const express = require('express');
const { pool } = require('../models/db');
const { signParentToken } = require('../middlewares/parentAuth');
const ragic = require('../services/ragic');
const { verifyLineIdToken } = require('../services/lineAuth');

const router = express.Router();

// per-IP 速率限制（與 coach by-phone 同樣 5 / 5min → 429），抑制電話號碼暴搜
const _attempts = new Map(); // ip → [ts...]
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
function _rateLimited(ip) {
  const now = Date.now();
  const arr = (_attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  _attempts.set(ip, arr);
  if (_attempts.size > 5000) _attempts.clear(); // crude GC
  return arr.length > MAX_ATTEMPTS;
}

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

/**
 * 從 Ragic Z01 列粗略拉出本地 parents 需要的欄位
 * （子表格「學員」目前不在這支 API 範圍：等後續任務再做 students 同步）
 */
function _parentFromRagic(z01Row) {
  if (!z01Row) return null;
  const f = ragic.FIELD.Z01;
  const get = (k) => (z01Row[k] != null ? String(z01Row[k]).trim() : '');
  return {
    ragicRecordId: z01Row._ragicId || z01Row['_ragicId'] || null,
    name:          get(f.PARENT_NAME) || get('家長姓名'),
    phone:         get(f.PHONE)       || get('(報)行動電話'),
    venueCode:     get(f.VENUE)       || get('館別'),
    lineUid:       get(f.LINE_UID),
  };
}

/**
 * 把 Ragic Z01 家長同步 / upsert 到本地 parents 表，回傳本地 row。
 * - 以 line_uid 為唯一識別優先；找不到再用 phone。
 * - 衝突解決：phone unique，所以使用 phone-key 的 upsert + 再補 line_uid。
 * - venue 對應：Ragic 館別代碼若不在本地 venues 內，先寫 null（不阻擋登入）。
 * TODO(students): Ragic Z01 子表格（學員）解析尚未實作，本函式僅同步家長主檔；
 *                 完整 student sync 留待下一個任務（連同 Z02 對齊）。
 */
async function upsertLocalParentFromRagic(client, ragicParent, lineUid) {
  const name  = ragicParent.name  || '未命名家長';
  const phone = ragicParent.phone || '';
  if (!phone) throw new Error('Ragic Z01 缺少手機號碼，無法 upsert');

  // venue：本地 venues 不存在就寫 null（不阻擋登入；admin 可後續補對應）
  let venueId = null;
  if (ragicParent.venueCode) {
    const v = await client.query(`SELECT id FROM venues WHERE id = $1`, [ragicParent.venueCode]);
    if (v.rowCount) venueId = ragicParent.venueCode;
  }

  // 先 upsert by phone（schema：phone UNIQUE）
  const up = await client.query(
    `INSERT INTO parents (phone, name, line_uid, primary_venue_id)
     VALUES ($1, $2, NULLIF($3, ''), $4)
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       line_uid = COALESCE(parents.line_uid, EXCLUDED.line_uid),
       primary_venue_id = COALESCE(parents.primary_venue_id, EXCLUDED.primary_venue_id),
       updated_at = NOW()
     RETURNING id, name, phone, line_uid, primary_venue_id`,
    [phone, name, lineUid || '', venueId]
  );
  return up.rows[0];
}

async function loadStudents(parentId) {
  const r = await pool.query(
    `SELECT id, name, birth_date FROM students WHERE parent_id = $1`,
    [parentId]
  );
  return r.rows;
}

function _issue(parent) {
  const token = signParentToken({
    parentId: parent.id, phone: parent.phone, lineUid: parent.line_uid,
  });
  return { id: parent.id, name: parent.name, phone: parent.phone,
           primary_venue_id: parent.primary_venue_id, token };
}

// ─────────────────────────────────────────────────────────────
// 既有：手機單因素登入（保留以免舊前端壞）
// ─────────────────────────────────────────────────────────────
router.post('/parent-login', async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (_rateLimited(ip)) {
      console.warn('[auth/parent-login] rate-limited ip=', ip);
      return res.status(429).json({ error: '嘗試次數過多，請稍後再試' });
    }
    const phone = String(req.body?.phone || '').trim();
    if (!phone) return res.status(400).json({ error: '手機必填' });
    const r = await pool.query(
      `SELECT id, name, phone, line_uid, primary_venue_id FROM parents WHERE phone = $1`,
      [phone]
    );
    if (!r.rowCount) return res.json(null);
    const p = r.rows[0];
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
// 新：家長 LINE 登入（先查 Z01 家教系統uid，再查本地 line_uid，再走手機綁定）
// 三種回應：
//   200 { status:'logged_in',           parent, token }
//   200 { status:'need_phone_binding',  line_uid }
//   4xx { error, code }
// ─────────────────────────────────────────────────────────────
router.post('/parent-line-login', async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (_rateLimited(ip)) return res.status(429).json({ error: '嘗試次數過多，請稍後再試', code: 'RATE_LIMITED' });

    const idToken = String(req.body?.id_token || '').trim();
    if (!idToken) return res.status(400).json({ error: 'id_token 必填', code: 'ID_TOKEN_REQUIRED' });

    let lineUid;
    try {
      const profile = await verifyLineIdToken(idToken);
      lineUid = profile.sub;
    } catch (err) {
      console.warn('[auth/parent-line-login] verifyLineIdToken failed:', err.message);
      return res.status(401).json({ error: 'LINE 驗證失敗', code: 'LINE_VERIFY_FAILED' });
    }
    if (!lineUid) return res.status(401).json({ error: 'LINE 驗證未取得 UID', code: 'LINE_VERIFY_FAILED' });

    // 1) 先打 Ragic Z01 by 家教系統uid
    let ragicParent = null;
    try {
      const row = await ragic.getParentByLineUid(lineUid);
      ragicParent = _parentFromRagic(row);
    } catch (err) {
      console.warn('[auth/parent-line-login] ragic.getParentByLineUid failed:', err.message);
      // Ragic 故障不該擋登入：fallback 走本地 line_uid 比對
    }

    // 2) 找到 → upsert 本地 + 簽 token
    if (ragicParent && ragicParent.phone) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const local = await upsertLocalParentFromRagic(client, ragicParent, lineUid);
        await client.query('COMMIT');
        const issued = _issue(local);
        const students = await loadStudents(local.id);
        return res.json({ status: 'logged_in', parent: { ...issued, students }, token: issued.token });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[auth/parent-line-login] upsert local failed:', err);
        return res.status(500).json({ error: '同步家長資料失敗', code: 'LOCAL_UPSERT_FAILED' });
      } finally {
        client.release();
      }
    }

    // 3) Ragic 沒找到 → 退回查本地 parents.line_uid（已綁定的舊家長走 happy path）
    const local = await pool.query(
      `SELECT id, name, phone, line_uid, primary_venue_id FROM parents WHERE line_uid = $1`,
      [lineUid]
    );
    if (local.rowCount) {
      const p = local.rows[0];
      const issued = _issue(p);
      const students = await loadStudents(p.id);
      return res.json({ status: 'logged_in', parent: { ...issued, students }, token: issued.token });
    }

    // 4) 都找不到 → 請前端引導去輸入手機
    return res.json({ status: 'need_phone_binding', line_uid: lineUid });
  } catch (err) {
    console.error('[auth/parent-line-login]', err);
    res.status(500).json({ error: '登入失敗', code: 'LOGIN_FAILED' });
  }
});

// ─────────────────────────────────────────────────────────────
// 新：家長手機綁定（LINE 已驗證但 Ragic 找不到 UID，使用者輸入手機）
// 四種回應：
//   200 { status:'bound_and_logged_in', parent, token }
//   200 { status:'need_registration',   line_uid, phone }
//   409 { error, code:'LINE_ALREADY_BOUND_TO_OTHER_PHONE' }
//   409 { error, code:'PHONE_ALREADY_BOUND_TO_OTHER_LINE' }
// ─────────────────────────────────────────────────────────────
router.post('/parent-bind-phone', async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (_rateLimited(ip)) return res.status(429).json({ error: '嘗試次數過多，請稍後再試', code: 'RATE_LIMITED' });

    const idToken = String(req.body?.id_token || '').trim();
    const phone   = String(req.body?.phone || '').trim();
    if (!idToken) return res.status(400).json({ error: 'id_token 必填', code: 'ID_TOKEN_REQUIRED' });
    if (!phone)   return res.status(400).json({ error: '手機必填',     code: 'PHONE_REQUIRED' });

    let lineUid;
    try {
      const profile = await verifyLineIdToken(idToken);
      lineUid = profile.sub;
    } catch (err) {
      console.warn('[auth/parent-bind-phone] verifyLineIdToken failed:', err.message);
      return res.status(401).json({ error: 'LINE 驗證失敗', code: 'LINE_VERIFY_FAILED' });
    }
    if (!lineUid) return res.status(401).json({ error: 'LINE 驗證未取得 UID', code: 'LINE_VERIFY_FAILED' });

    // 1) 本地已用同 line_uid 綁到「不同」電話 → 拒絕（防一支 LINE 綁多家長）
    const dupLine = await pool.query(
      `SELECT id, phone FROM parents WHERE line_uid = $1 LIMIT 1`,
      [lineUid]
    );
    if (dupLine.rowCount && dupLine.rows[0].phone !== phone) {
      return res.status(409).json({
        error: '此 LINE 帳號已綁定其他手機，請改用原手機登入或聯絡客服',
        code: 'LINE_ALREADY_BOUND_TO_OTHER_PHONE',
      });
    }

    // 1b) 本地該手機已綁到「不同」line_uid → 拒絕（即使 Ragic 還沒同步）
    //     這層檢查防止「Ragic 暫時為空 → 誤判可綁」的 race / stale window。
    const dupPhone = await pool.query(
      `SELECT id, line_uid FROM parents WHERE phone = $1 LIMIT 1`,
      [phone]
    );
    if (dupPhone.rowCount && dupPhone.rows[0].line_uid && dupPhone.rows[0].line_uid !== lineUid) {
      return res.status(409).json({
        error: '此手機已綁定其他 LINE 帳號，請聯絡客服處理',
        code: 'PHONE_ALREADY_BOUND_TO_OTHER_LINE',
      });
    }

    // 2) Ragic Z01 by phone
    let ragicParent = null;
    try {
      const row = await ragic.getParentByPhone(phone);
      ragicParent = _parentFromRagic(row);
      // 把原始 row 留著用來拿欄位 1006846 既有值（可能不在 _parentFromRagic 取出的欄位裡）
      if (ragicParent) ragicParent._raw = row;
    } catch (err) {
      console.warn('[auth/parent-bind-phone] ragic.getParentByPhone failed:', err.message);
      return res.status(502).json({ error: 'Ragic 暫時無法連線，請稍後再試', code: 'RAGIC_UNAVAILABLE' });
    }

    // 3) Ragic 也找不到 → 引導去註冊
    if (!ragicParent) {
      return res.json({ status: 'need_registration', line_uid: lineUid, phone });
    }

    // 4) Ragic 找到，但 1006846 已被別的 LINE UID 佔用 → 拒絕
    if (ragicParent.lineUid && ragicParent.lineUid !== lineUid) {
      return res.status(409).json({
        error: '此手機已綁定其他 LINE 帳號，請聯絡客服處理',
        code: 'PHONE_ALREADY_BOUND_TO_OTHER_LINE',
      });
    }

    // 5) Ragic 找到且 1006846 空白 → 寫回 Ragic
    if (!ragicParent.lineUid) {
      try {
        await ragic.bindParentLineUidToRagic({
          ragicRecordId: ragicParent.ragicRecordId,
          lineUid,
        });
      } catch (err) {
        console.warn('[auth/parent-bind-phone] bindParentLineUidToRagic failed:', err.message);
        // Ragic 寫回失敗不阻擋本地登入；admin 之後可從待審核重新對齊
      }
    }

    // 6) upsert 本地 + 發 token
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const local = await upsertLocalParentFromRagic(client, ragicParent, lineUid);
      await client.query('COMMIT');
      const issued = _issue(local);
      const students = await loadStudents(local.id);
      return res.json({ status: 'bound_and_logged_in', parent: { ...issued, students }, token: issued.token });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[auth/parent-bind-phone] upsert local failed:', err);
      return res.status(500).json({ error: '綁定失敗', code: 'LOCAL_UPSERT_FAILED' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[auth/parent-bind-phone]', err);
    res.status(500).json({ error: '綁定失敗', code: 'BIND_FAILED' });
  }
});

router.all('*', (req, res) => {
  res.status(404).json({ error: 'auth endpoint not found', path: req.path });
});

module.exports = router;
