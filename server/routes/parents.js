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

function cleanText(v, max = 255) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : '';
}

function cleanStudentInput(body) {
  const name = cleanText(body?.name, 100);
  const idNumber = cleanText(body?.id_number, 20).toUpperCase();
  return {
    name,
    id_number: idNumber,
    birth_date: cleanText(body?.birth_date, 20) || null,
    gender: cleanText(body?.gender, 20) || null,
    blood_type: cleanText(body?.blood_type, 5) || null,
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

function ragicParentPayload(parent) {
  return {
    [ragic.FIELD.Z01.PARENT_NAME]: parent.name || '',
    [ragic.FIELD.Z01.VENUE]: parent.primary_venue_id || '',
    [ragic.FIELD.Z01.PHONE]: parent.phone || '',
    [ragic.FIELD.Z01.IDENTITY]: parent.identity || '',
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
    return res.status(409).json({ error: '此身分證字號已存在', code: err.code });
  }
  const status = err.code === 'PARENT_RAGIC_NOT_FOUND' ? 409 : 502;
  return res.status(status).json({
    error: 'Ragic 同步失敗，請稍後再試',
    code: err.code || 'RAGIC_SYNC_FAILED',
  });
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
    identity: cleanText(b.identity, 50) || null,
    gender: cleanText(b.gender, 20) || null,
    email: cleanText(b.email, 255) || null,
    home_phone: cleanText(b.home_phone, 30) || null,
    line_id: cleanText(b.line_id, 100) || null,
    home_address: cleanText(b.home_address, 1000) || null,
  };
  if (!patch.name) return res.status(400).json({ error: '家長姓名必填' });

  try {
    const cur = await loadMe(req.parent.id);
    if (!cur) return res.status(404).json({ error: '找不到家長帳號' });
    await assertVenueExists(patch.primary_venue_id);
    const merged = { ...cur, ...patch };
    const ragicRecordId = await ragic.resolveParentRagicRecord(cur);
    await ragic.upsertParentStrict(ragicParentPayload(merged), ragicRecordId);
    const r = await pool.query(
      `UPDATE parents SET
         name = $2, primary_venue_id = $3, identity = $4, gender = $5, email = $6,
         home_phone = $7, line_id = $8, home_address = $9,
         ragic_record_id = COALESCE(ragic_record_id, $10),
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
    console.error('[parents.updateMe]', err);
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
      `SELECT id FROM students
        WHERE id_number = $1
        LIMIT 1`,
      [s.id_number]
    );
    if (dup.rowCount) return res.status(409).json({ error: '此學員已存在', code: 'STUDENT_ID_DUPLICATED' });

    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM students WHERE parent_id = $1`, [req.parent.id]);
    const sync = await ragic.createStudentZ01Z02Strict({
      parent,
      student: s,
      startIndex: Number(cnt.rows[0]?.n || 0),
    });
    const ins = await pool.query(
      `INSERT INTO students
         (parent_id, name, id_number, birth_date, gender, blood_type, ragic_record_id, is_active, last_synced_at)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, TRUE, NOW())
       RETURNING id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id, is_active`,
      [req.parent.id, s.name, s.id_number, s.birth_date, s.gender, s.blood_type, sync.z02.ragicRecordId]
    );
    await pool.query(
      `UPDATE parents SET ragic_record_id = COALESCE(ragic_record_id, $2), updated_at = NOW() WHERE id = $1`,
      [req.parent.id, sync.parentRagicRecordId]
    );
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    console.error('[parents.createStudent]', err);
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
    if (dup.rowCount) return res.status(409).json({ error: '此身分證字號已存在', code: 'STUDENT_ID_DUPLICATED' });
    const syncStudent = { ...cur.rows[0], ...s };
    const sync = await ragic.updateStudentZ01Z02Strict({ parent, student: syncStudent, status: '啟用' });
    const up = await pool.query(
      `UPDATE students SET
         name = $3, id_number = $4, birth_date = $5::date, gender = $6, blood_type = $7,
         ragic_record_id = COALESCE(ragic_record_id, $8),
         last_synced_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND parent_id = $2
       RETURNING id, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id, is_active`,
      [req.params.id, req.parent.id, s.name, s.id_number, s.birth_date, s.gender, s.blood_type, sync.z02.ragicRecordId]
    );
    await pool.query(
      `UPDATE parents SET ragic_record_id = COALESCE(ragic_record_id, $2), updated_at = NOW() WHERE id = $1`,
      [req.parent.id, sync.parentRagicRecordId]
    );
    res.json(up.rows[0]);
  } catch (err) {
    console.error('[parents.updateStudent]', err);
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
    const sync = await ragic.deactivateStudentZ02Strict({ parent, student: cur.rows[0] });
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
    console.error('[parents.deleteStudent]', err);
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
