/**
 * /api/parents — 家長 + 學員建立
 *  POST /                       LIFF 註冊頁；可附 ref_token 綁定 MGM 推薦
 *
 *  （U4 資安：移除舊的公開 GET /by-phone —— 該端點可用他人電話帶出對方所有學員，屬越權查詢；
 *   同組報名改走 U5–U8 團購流程。任何 /by-phone 請求會落到下方 catch-all 回 404。）
 *
 *  回傳 shape 與 mock createParent 對齊（id/name/phone/email/students），
 *  另外帶 token（自動登入）+ ref_bound 旗標讓前端知道是否成功套用推薦。
 */
const express = require('express');
const { pool } = require('../models/db');
const { signParentToken, requireParent } = require('../middlewares/parentAuth');
const referrals = require('../services/referrals');
const ragic = require('../services/ragic');

const router = express.Router();

const TW_PHONE = /^09\d{8}$/;
const TW_ID = /^[A-Z][12]\d{8}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BLOOD_TYPES = new Set(['A', 'B', 'O', 'AB', '不清楚']);

function cleanText(v, max = 255) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : '';
}

function cleanBloodType(v) {
  const raw = cleanText(v, 10);
  if (!raw) return '不清楚';
  const upper = raw.toUpperCase();
  if (BLOOD_TYPES.has(upper)) return upper;
  if (BLOOD_TYPES.has(raw)) return raw;
  return '不清楚';
}

function cleanStudentInput(body) {
  const name = cleanText(body?.name, 100);
  const idNumber = cleanText(body?.id_number, 20).toUpperCase();
  return {
    name,
    id_number: idNumber,
    birth_date: cleanText(body?.birth_date, 20) || null,
    gender: cleanText(body?.gender, 20) || null,
    blood_type: cleanBloodType(body?.blood_type),
  };
}

async function loadMe(parentId) {
  const pr = await pool.query(
    `SELECT id, name, phone, gender, email, primary_venue_id, identity,
            home_phone, home_address, line_id, ragic_record_id
       FROM parents WHERE id = $1`,
    [parentId]
  );
  if (!pr.rowCount) return null;
  const sr = await pool.query(
    `SELECT id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id, is_active
       FROM students
      WHERE parent_id = $1 AND COALESCE(is_active, TRUE) = TRUE
      ORDER BY created_at ASC`,
    [parentId]
  );
  return { ...pr.rows[0], students: sr.rows };
}

async function assertVenueExists(venueId) {
  if (!venueId) return;
  const r = await pool.query(`SELECT 1 FROM venues WHERE id = $1`, [venueId]);
  if (!r.rowCount) {
    const err = new Error('館別不存在');
    err.code = 'VENUE_NOT_FOUND';
    throw err;
  }
}

// venueName：已由 venueLabel 把 venues.id 代碼換成 Ragic 認得的場館名稱（必填，缺則整筆 INVALID）。
function ragicParentPayload(parent, venueName) {
  return {
    [ragic.FIELD.Z01.PARENT_NAME]: parent.name || '',
    [ragic.FIELD.Z01.VENUE]: venueName || parent.primary_venue_id || '',
    [ragic.FIELD.Z01.PHONE]: parent.phone || '',
    [ragic.FIELD.Z01.IDENTITY]: parent.identity || '一般身分',
    [ragic.FIELD.Z01.GENDER]: parent.gender || '',
    [ragic.FIELD.Z01.EMAIL]: parent.email || '',
    [ragic.FIELD.Z01.HOME_PHONE]: parent.home_phone || '',
    [ragic.FIELD.Z01.LINE_ID]: parent.line_id || '',
    [ragic.FIELD.Z01.HOME_ADDRESS]: parent.home_address || '',
  };
}

function ragicError(res, err) {
  if (err.code === 'VENUE_NOT_FOUND') {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  if (err.code === 'STUDENT_ID_DUPLICATED') {
    return res.status(409).json({ error: '此身分證字號已有學員資料，請確認後再試；若需協助請聯絡客服。', code: err.code });
  }
  if (err.code === '23505') {
    return res.status(409).json({ error: '資料已存在，請確認後再試；若需協助請聯絡客服。', code: 'DUPLICATED_VALUE' });
  }
  const status = err.code === 'PARENT_RAGIC_NOT_FOUND' ? 409 : 502;
  return res.status(status).json({
    error: '資料暫時無法完成同步，請稍後再試。',
    code: err.code || 'RAGIC_SYNC_FAILED',
  });
}

// 「擇一儲存」：學員已寫進本地 DB、但 Ragic 同步暫緩時，給前端一句可讀提醒。
// 多半是家長資料（館別／性別／Email）未補齊 → Z02 必填 INVALID；也可能 Ragic 暫時連線失敗。
function studentSyncDeferredMsg(err) {
  return '學員已儲存；系統同步稍後會再處理。';
}

router.get('/me', requireParent, async (req, res) => {
  try {
    const me = await loadMe(req.parent.id);
    if (!me) return res.status(404).json({ error: '找不到家長帳號' });
    res.json(me);
  } catch (err) {
    console.error('[parents.me]', err);
    res.status(500).json({ error: 'load failed' });
  }
});

router.patch('/me', requireParent, async (req, res) => {
  const b = req.body || {};
  const patch = {
    name: cleanText(b.name, 100),
    primary_venue_id: cleanText(b.primary_venue_id, 10) || null,
    // 身分欄位已從家長端 UI 移除，未帶入時一律預設「一般身分」（與 Ragic Z01 預設一致）。
    identity: cleanText(b.identity, 50) || '一般身分',
    gender: cleanText(b.gender, 20) || null,
    email: cleanText(b.email, 255) || null,
    home_phone: cleanText(b.home_phone, 30) || null,
    line_id: cleanText(b.line_id, 100) || null,
    home_address: cleanText(b.home_address, 1000) || null,
  };
  // Ragic Z01 必填欄位（缺一即整筆 INVALID）：姓名 / 館別 / 身分 / 性別 / Email。
  // 前端已用紅框＊擋一道，後端再驗一次（防直接打 API / 舊頁面），回傳明確缺哪欄。
  // 身分不再由前端送出（已固定為「一般身分」預設），故不列入必填檢核。
  const REQUIRED = [
    ['name', '家長姓名'], ['primary_venue_id', '館別'],
    ['gender', '性別'], ['email', 'Email'],
  ];
  for (const [key, label] of REQUIRED) {
    if (!patch[key]) return res.status(400).json({ error: `「${label}」為必填欄位`, code: 'FIELD_REQUIRED', field: key });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) {
    return res.status(400).json({ error: 'Email 格式有誤', code: 'EMAIL_INVALID', field: 'email' });
  }

  try {
    const cur = await loadMe(req.parent.id);
    if (!cur) return res.status(404).json({ error: '找不到家長帳號' });
    await assertVenueExists(patch.primary_venue_id);
    const merged = { ...cur, ...patch };
    // 館別代碼 → Ragic 認得的場館名稱（這是「館別 為必填」同步失敗的真因）。
    const venueName = await ragic.venueLabel(merged.primary_venue_id);
    console.log('[parent-sync] 編輯家長 start', {
      parent: cur.name, phone: cur.phone, ragicId: cur.ragic_record_id || null,
      venueId: merged.primary_venue_id, venueName,
    });
    // 自我修復：本地 ragic_record_id 失效（後台刪除）時會改用手機重查 / 新建，
    // 回傳實際寫入的 record id（可能與本地不同 → 直接覆蓋校正，不再 COALESCE 留舊值）。
    const ragicRecordId = await ragic.syncParentProfileStrict(merged, ragicParentPayload(merged, venueName));
    console.log('[parent-sync] 編輯家長 Ragic 同步完成', { ragicId: ragicRecordId });
    const r = await pool.query(
      `UPDATE parents SET
         name = $2, primary_venue_id = $3, identity = $4, gender = $5, email = $6,
         home_phone = $7, line_id = $8, home_address = $9,
         ragic_record_id = $10,
         last_synced_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, phone, gender, email, primary_venue_id, identity,
                 home_phone, home_address, line_id, ragic_record_id`,
      [req.parent.id, patch.name, patch.primary_venue_id, patch.identity, patch.gender, patch.email,
       patch.home_phone, patch.line_id, patch.home_address, ragicRecordId]
    );
    const me = await loadMe(r.rows[0].id);
    res.json(me);
  } catch (err) {
    console.error('[parent-sync] 編輯家長 失敗', { code: err.code, msg: err.message });
    return ragicError(res, err);
  }
});

router.post('/me/students', requireParent, async (req, res) => {
  const s = cleanStudentInput(req.body || {});
  if (!s.name || !s.birth_date || !ISO_DATE.test(s.birth_date) || !TW_ID.test(s.id_number)) {
    return res.status(400).json({ error: '學員資料不完整或身分證格式錯誤' });
  }
  try {
    const parent = await loadMe(req.parent.id);
    if (!parent) return res.status(404).json({ error: '找不到家長帳號' });
    const dup = await pool.query(
      `SELECT id, parent_id, is_active FROM students
        WHERE id_number = $1
        LIMIT 1`,
      [s.id_number]
    );
    if (dup.rowCount) {
      const existing = dup.rows[0];
      if (String(existing.parent_id) !== String(req.parent.id)) {
        return res.status(409).json({
          error: '此身分證字號已有學員資料，請確認後再試；若需協助請聯絡客服。',
          code: 'STUDENT_ID_DUPLICATED',
        });
      }

      const up = await pool.query(
        `UPDATE students SET
           name = $3, id_number = $4, birth_date = $5::date, gender = $6, blood_type = $7,
           is_active = TRUE, last_synced_at = NULL, updated_at = NOW()
         WHERE id = $1 AND parent_id = $2
         RETURNING id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id, is_active`,
        [existing.id, req.parent.id, s.name, s.id_number, s.birth_date, s.gender, s.blood_type]
      );
      let row = up.rows[0];
      let syncWarning = null;
      try {
        console.log('[student-sync] 新增學員比對到既有資料，改為更新', { parent: parent.name, phone: parent.phone, student: s.name });
        const sync = await ragic.updateStudentZ01Z02Strict({ parent, student: { ...row, ...s }, status: '啟用' });
        const up2 = await pool.query(
          `UPDATE students SET ragic_record_id = COALESCE(ragic_record_id, $2), last_synced_at = NOW()
            WHERE id = $1
            RETURNING id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id, is_active`,
          [row.id, sync.z02.ragicRecordId]
        );
        row = up2.rows[0];
        await pool.query(
          `UPDATE parents SET ragic_record_id = COALESCE(ragic_record_id, $2), updated_at = NOW() WHERE id = $1`,
          [req.parent.id, sync.parentRagicRecordId]
        );
      } catch (err) {
        console.warn('[student-sync] 既有學員更新 Ragic 同步暫緩（本地已存）', { code: err.code, msg: err.message });
        syncWarning = studentSyncDeferredMsg(err);
      }
      return res.json({ ...row, sync_warning: syncWarning, merged_existing: true });
    }

    // 擇一儲存：學員欄位齊就先寫進本地 DB（last_synced_at = NULL = 尚未同步），
    // 不被「家長資料未補齊 → Z02 必填 INVALID」整筆擋掉。
    const startIndex = Number(
      (await pool.query(`SELECT COUNT(*)::int AS n FROM students WHERE parent_id = $1`, [req.parent.id])).rows[0]?.n || 0
    );
    const ins = await pool.query(
      `INSERT INTO students
         (parent_id, name, id_number, birth_date, gender, blood_type, is_active, last_synced_at)
       VALUES ($1, $2, $3, $4::date, $5, $6, TRUE, NULL)
       RETURNING id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id, is_active`,
      [req.parent.id, s.name, s.id_number, s.birth_date, s.gender, s.blood_type]
    );
    let row = ins.rows[0];

    // Ragic 同步（best-effort）：成功 → 補 ragic_record_id + last_synced_at；失敗 → 保留本地、回提醒
    let syncWarning = null;
    try {
      console.log('[student-sync] 新增學員 start', { parent: parent.name, phone: parent.phone, student: s.name });
      const sync = await ragic.createStudentZ01Z02Strict({ parent, student: s, startIndex });
      const up = await pool.query(
        `UPDATE students SET ragic_record_id = COALESCE(ragic_record_id, $2), last_synced_at = NOW()
          WHERE id = $1
          RETURNING id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id, is_active`,
        [row.id, sync.z02.ragicRecordId]
      );
      row = up.rows[0];
      await pool.query(
        `UPDATE parents SET ragic_record_id = COALESCE(ragic_record_id, $2), updated_at = NOW() WHERE id = $1`,
        [req.parent.id, sync.parentRagicRecordId]
      );
      console.log('[student-sync] 新增學員 Ragic 同步完成', { z02: sync?.z02?.ragicRecordId });
    } catch (err) {
      console.warn('[student-sync] 新增學員 Ragic 同步暫緩（本地已存）', { code: err.code, msg: err.message });
      syncWarning = studentSyncDeferredMsg(err);
    }
    res.status(201).json({ ...row, sync_warning: syncWarning });
  } catch (err) {
    console.error('[student-sync] 新增學員 失敗', { code: err.code, msg: err.message });
    return ragicError(res, err);
  }
});

router.patch('/me/students/:id', requireParent, async (req, res) => {
  const s = cleanStudentInput(req.body || {});
  if (!s.name || !s.birth_date || !ISO_DATE.test(s.birth_date) || !TW_ID.test(s.id_number)) {
    return res.status(400).json({ error: '學員資料不完整或身分證格式錯誤' });
  }
  try {
    const parent = await loadMe(req.parent.id);
    if (!parent) return res.status(404).json({ error: '找不到家長帳號' });
    const cur = await pool.query(
      `SELECT id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id
         FROM students
        WHERE id = $1 AND parent_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
      [req.params.id, req.parent.id]
    );
    if (!cur.rowCount) return res.status(404).json({ error: '找不到學員' });
    const dup = await pool.query(
      `SELECT id FROM students
        WHERE id_number = $1 AND id <> $2
        LIMIT 1`,
      [s.id_number, req.params.id]
    );
    if (dup.rowCount) {
      return res.status(409).json({
        error: '此身分證字號已有學員資料，請確認後再試；若需協助請聯絡客服。',
        code: 'STUDENT_ID_DUPLICATED',
      });
    }

    // 擇一儲存：先把學員欄位寫進本地 DB（last_synced_at 清成 NULL = 待同步），
    // 不被「家長資料未補齊 → Z02 必填 INVALID」整筆擋掉。
    const up = await pool.query(
      `UPDATE students SET
         name = $3, id_number = $4, birth_date = $5::date, gender = $6, blood_type = $7,
         last_synced_at = NULL, updated_at = NOW()
       WHERE id = $1 AND parent_id = $2
       RETURNING id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id, is_active`,
      [req.params.id, req.parent.id, s.name, s.id_number, s.birth_date, s.gender, s.blood_type]
    );
    let row = up.rows[0];

    // Ragic 同步（best-effort）：成功 → 補 ragic_record_id + last_synced_at；失敗 → 保留本地、回提醒
    let syncWarning = null;
    const syncStudent = { ...cur.rows[0], ...s };
    try {
      console.log('[student-sync] 編輯學員 start', { parent: parent.name, phone: parent.phone, student: s.name, studentId: req.params.id });
      const sync = await ragic.updateStudentZ01Z02Strict({ parent, student: syncStudent, status: '啟用' });
      const up2 = await pool.query(
        `UPDATE students SET ragic_record_id = COALESCE(ragic_record_id, $2), last_synced_at = NOW()
          WHERE id = $1
          RETURNING id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id, is_active`,
        [req.params.id, sync.z02.ragicRecordId]
      );
      row = up2.rows[0];
      await pool.query(
        `UPDATE parents SET ragic_record_id = COALESCE(ragic_record_id, $2), updated_at = NOW() WHERE id = $1`,
        [req.parent.id, sync.parentRagicRecordId]
      );
      console.log('[student-sync] 編輯學員 Ragic 同步完成', { z02: sync?.z02?.ragicRecordId });
    } catch (err) {
      console.warn('[student-sync] 編輯學員 Ragic 同步暫緩（本地已存）', { code: err.code, msg: err.message });
      syncWarning = studentSyncDeferredMsg(err);
    }
    res.json({ ...row, sync_warning: syncWarning });
  } catch (err) {
    console.error('[student-sync] 編輯學員 失敗', { code: err.code, msg: err.message });
    return ragicError(res, err);
  }
});

router.delete('/me/students/:id', requireParent, async (req, res) => {
  try {
    const parent = await loadMe(req.parent.id);
    if (!parent) return res.status(404).json({ error: '找不到家長帳號' });
    const cur = await pool.query(
      `SELECT id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id
         FROM students
        WHERE id = $1 AND parent_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
      [req.params.id, req.parent.id]
    );
    if (!cur.rowCount) return res.status(404).json({ error: '找不到學員' });
    console.log('[student-sync] 停用學員 start', { parent: parent.name, phone: parent.phone, student: cur.rows[0].name, studentId: req.params.id });
    const sync = await ragic.deactivateStudentZ02Strict({ parent, student: cur.rows[0] });
    console.log('[student-sync] 停用學員 Ragic 同步完成', { parentRagicId: sync?.parentRagicRecordId });
    await pool.query(
      `UPDATE students SET is_active = FALSE, ragic_record_id = COALESCE(ragic_record_id, $3),
              last_synced_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND parent_id = $2`,
      [req.params.id, req.parent.id, sync.z02.ragicRecordId]
    );
    await pool.query(
      `UPDATE parents SET ragic_record_id = COALESCE(ragic_record_id, $2), updated_at = NOW() WHERE id = $1`,
      [req.parent.id, sync.parentRagicRecordId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[student-sync] 停用學員 失敗', { code: err.code, msg: err.message });
    return ragicError(res, err);
  }
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const phone = String(b.phone || '').trim();
  const name = String(b.name || '').trim();
  if (!name || !TW_PHONE.test(phone)) {
    return res.status(400).json({ error: '姓名與手機格式必填（手機 09xxxxxxxx）' });
  }
  const students = Array.isArray(b.students) ? b.students : [];
  if (!students.length) return res.status(400).json({ error: '至少需新增 1 位學員' });
  for (const s of students) {
    if (!s.name || !s.birth_date || !TW_ID.test(String(s.id_number || '').toUpperCase())) {
      return res.status(400).json({ error: '學員資料不完整或身分證格式錯誤' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 已存在相同手機 → 拒絕（前端應改走登入流程）
    const dup = await client.query(`SELECT id FROM parents WHERE phone = $1`, [phone]);
    if (dup.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此手機已有家長帳號，請改用登入' });
    }
    const pIns = await client.query(
      `INSERT INTO parents (name, phone, gender, email, primary_venue_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, phone, primary_venue_id`,
      [name, phone, b.gender || null, b.email || null, b.primary_venue_id || null]
    );
    const parent = pIns.rows[0];
    const studentRows = [];
    for (const s of students) {
      const sIns = await client.query(
        `INSERT INTO students (parent_id, name, id_number, birth_date, gender)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, id_number, birth_date, gender`,
        [parent.id, s.name.trim(), String(s.id_number).toUpperCase(), s.birth_date, s.gender || null]
      );
      studentRows.push(sIns.rows[0]);
    }
    await client.query('COMMIT');

    // ── MGM ref_token 綁定（失敗不阻擋註冊；交易外進行以隔離 UNIQUE 衝突）──
    let refBound = false;
    let refError = null;
    if (b.ref_token) {
      try {
        await referrals.bindReferee({
          token: String(b.ref_token).trim(),
          refereeParentId: parent.id,
          refereePhone: parent.phone,
        });
        refBound = true;
      } catch (e) {
        refError = e.code || 'REF_FAILED';
      }
    }

    const token = signParentToken({ parentId: parent.id, phone: parent.phone });
    res.status(201).json({
      id: parent.id, name: parent.name, phone: parent.phone,
      primary_venue_id: parent.primary_venue_id,
      students: studentRows, token,
      ref_bound: refBound, ref_error: refError,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[parents.create]', err);
    res.status(500).json({ error: 'create failed' });
  } finally {
    client.release();
  }
});

router.all('*', (req, res) => {
  res.status(404).json({ error: 'parents endpoint not found', path: req.path });
});

module.exports = router;
