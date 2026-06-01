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
const { signParentToken } = require('../middlewares/parentAuth');
const referrals = require('../services/referrals');

const router = express.Router();

const TW_PHONE = /^09\d{8}$/;
const TW_ID = /^[A-Z][12]\d{8}$/;

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
