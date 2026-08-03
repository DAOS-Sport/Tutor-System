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
const { refreshParentMirrorFromRagic, ParentRefreshError, assertZ01Complete } = require('../services/parentRefresh');
const { diffChanges, writeStudentAudit } = require('./admin/_customerShared');

const router = express.Router();

// 開場同步節流：近 N 分鐘內已成功同步過 → 直接回 DB 鏡像，不再打 Ragic（預設 5 分）。
const SYNC_THROTTLE_MS = Number(process.env.PARENT_SYNC_THROTTLE_MS) || 5 * 60 * 1000;

const TW_PHONE = /^09\d{8}$/;
const TW_ID = /^[A-Z][12]\d{8}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BLOOD_TYPES = new Set(['A', 'B', 'O', 'AB', '不清楚']);
const STUDENT_REFRESH_PENDING_CODES = new Set([
  'RAGIC_REFRESH_FAILED',
  'RAGIC_REFRESH_NOT_FOUND',
  'RAGIC_Z02_REFRESH_FAILED',
  'RAGIC_TIMEOUT',
  'RAGIC_HTTP_ERROR',
  'RAGIC_REFRESH_STUDENTS_INCOMPLETE',
  'LOCAL_STUDENT_REFRESH_FAILED',
]);

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

function isoDate(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10).replace(/\//g, '-');
  try { return new Date(v).toISOString().slice(0, 10); } catch { return ''; }
}

function sameStudentValue(a, b) {
  return String(a || '').trim() === String(b || '').trim();
}

function ragicStudentMatchesExpected(rows, expected, ragicRecordId = null) {
  if (!expected) return true;
  const idNum = String(expected.id_number || '').trim().toUpperCase();
  const rid = ragicRecordId ? String(ragicRecordId).trim() : '';
  const found = (rows || []).find((row) => (
    (rid && String(row?.ragic_record_id || '').trim() === rid) ||
    (idNum && String(row?.id_number || '').trim().toUpperCase() === idNum)
  ));
  if (!found) return false;
  if (!sameStudentValue(found.name, expected.name)) return false;
  if (idNum && String(found.id_number || '').trim().toUpperCase() !== idNum) return false;
  if (expected.birth_date && isoDate(found.birth_date) !== isoDate(expected.birth_date)) return false;
  if (expected.gender && ragic.normalizeGender(found.gender) !== ragic.normalizeGender(expected.gender)) return false;
  if (expected.blood_type && String(found.blood_type || '').trim() !== String(expected.blood_type || '').trim()) return false;
  return true;
}

function isStudentRefreshPendingError(err) {
  return STUDENT_REFRESH_PENDING_CODES.has(err?.code || '');
}

async function loadMe(parentId) {
  const pr = await pool.query(
    `SELECT id, name, phone, line_uid, gender, email, primary_venue_id, identity,
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
  const payload = {
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
  if (parent.line_uid) payload[ragic.FIELD.Z01.LINE_UID] = parent.line_uid;
  return payload;
}

function ragicError(res, err) {
  if (err.code === 'VENUE_NOT_FOUND') {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  if (err instanceof ParentRefreshError) {
    return res.status(err.http || 500).json({
      error: err.message || '會員資料重新整理失敗，請稍後再試。',
      code: err.code || 'PARENT_REFRESH_FAILED',
    });
  }
  if (err.code === 'RAGIC_TIMEOUT') {
    return res.status(504).json({ error: 'Ragic 回應較慢，請稍候片刻再試一次。', code: 'RAGIC_TIMEOUT' });
  }
  if (err.code === 'STUDENT_ID_DUPLICATED' || err.code === 'STUDENT_ID_NUMBER_EXISTS') {
    return res.status(409).json({
      error: '此身分證字號已有學員資料，請確認後再試；若需協助請聯絡客服。',
      code: err.code,
    });
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

function assertParentReadyForStrictSync(parent, lineUid) {
  assertZ01Complete({
    ...parent,
    line_uid: parent.line_uid || lineUid || null,
    identity: parent.identity || '一般身分',
  });
}

async function parentForStrictStudentSync(parent, lineUid) {
  const base = { ...parent, line_uid: parent.line_uid || lineUid || null };
  try {
    assertParentReadyForStrictSync(base, lineUid);
    return base;
  } catch (err) {
    if (!(err instanceof ParentRefreshError) || err.code !== 'Z01_INCOMPLETE') throw err;
  }

  let z01Row = null;
  try {
    if (base.line_uid) z01Row = await ragic.getParentByLineUid(base.line_uid);
    if (!z01Row && base.phone) z01Row = await ragic.getParentByPhone(base.phone);
  } catch (lookupErr) {
    console.warn('[student-sync] 本地家長資料不完整，Ragic 補查失敗', {
      phone: base.phone,
      code: lookupErr.code,
      msg: lookupErr.message,
    });
  }

  const mapped = ragic.mapZ01Parent(z01Row);
  if (!mapped) {
    assertParentReadyForStrictSync(base, lineUid);
    return base;
  }
  if (base.phone && mapped.phone !== base.phone) {
    const e = new ParentRefreshError('RAGIC_REFRESH_PHONE_MISMATCH', 'Ragic Z01 手機與目前登入帳號不一致', 502);
    throw e;
  }
  if (base.line_uid && mapped.line_uid && mapped.line_uid !== base.line_uid) {
    const e = new ParentRefreshError('RAGIC_REFRESH_UID_MISMATCH', 'Ragic Z01 LINE UID 與目前登入帳號不一致', 502);
    throw e;
  }

  const merged = {
    ...base,
    ...mapped,
    id: parent.id,
    line_uid: mapped.line_uid || base.line_uid || null,
    phone: mapped.phone || base.phone,
    primary_venue_id: mapped.primary_venue_id || base.primary_venue_id,
  };
  assertParentReadyForStrictSync(merged, lineUid);
  return merged;
}

async function persistStudentMirrorAfterRagic({ parentId, studentId = null, student, sync = null, markSynced = false }) {
  const z02Id = sync?.z02?.ragicRecordId ? String(sync.z02.ragicRecordId) : null;
  const parentRagicId = sync?.parentRagicRecordId ? String(sync.parentRagicRecordId) : null;
  let savedId = studentId;
  const syncedSql = markSynced ? 'NOW()' : 'NULL';
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (savedId) {
      const current = await client.query(
        `SELECT id FROM students WHERE id = $1 AND parent_id = $2 LIMIT 1`,
        [savedId, parentId]
      );
      if (!current.rowCount) savedId = null;
    }
    if (!savedId && student.id_number) {
      const existing = await client.query(
        `SELECT id FROM students
          WHERE parent_id = $1 AND id_number = $2 AND COALESCE(is_active, TRUE) = TRUE
          LIMIT 1`,
        [parentId, student.id_number]
      );
      if (existing.rowCount) savedId = existing.rows[0].id;
    }
    if (!savedId && z02Id) {
      const existing = await client.query(
        `SELECT id FROM students
          WHERE parent_id = $1 AND ragic_record_id = $2 AND COALESCE(is_active, TRUE) = TRUE
          LIMIT 1`,
        [parentId, z02Id]
      );
      if (existing.rowCount) savedId = existing.rows[0].id;
    }

    if (z02Id) {
      await client.query(
        `UPDATE students
            SET ragic_record_id = NULL, updated_at = NOW()
          WHERE ragic_record_id = $1
            AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [z02Id, savedId || null]
      );
    }

    if (savedId) {
      const updated = await client.query(
        `UPDATE students SET
            name = $3,
            id_number = $4,
            birth_date = $5,
            gender = $6,
            blood_type = NULLIF($7, ''),
            ragic_record_id = COALESCE($8, ragic_record_id),
            last_synced_at = ${syncedSql},
            updated_at = NOW()
          WHERE id = $1 AND parent_id = $2`,
        [savedId, parentId, student.name, student.id_number, student.birth_date, student.gender || null, student.blood_type || '', z02Id]
      );
      if (!updated.rowCount) savedId = null;
    }
    if (!savedId) {
      const inserted = await client.query(
        `INSERT INTO students
           (parent_id, name, id_number, birth_date, gender, blood_type, ragic_record_id, is_active, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,TRUE,${syncedSql})
         RETURNING id`,
        [parentId, student.name, student.id_number, student.birth_date, student.gender || null, student.blood_type || '', z02Id]
      );
      savedId = inserted.rows[0]?.id || null;
    }

    if (parentRagicId) {
      await client.query(
        `UPDATE parents SET ragic_record_id = COALESCE($2, ragic_record_id), updated_at = NOW()
          WHERE id = $1`,
        [parentId, parentRagicId]
      );
    }
    await client.query('COMMIT');
    return savedId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function refreshAfterStudentWrite(req, parent, {
  minStudents,
  reason,
  expectedStudent = null,
  studentId = null,
  sync = null,
} = {}) {
  const pendingResponse = async (err) => {
    if (expectedStudent) {
      await persistStudentMirrorAfterRagic({
        parentId: req.parent.id,
        studentId,
        student: expectedStudent,
        sync,
        markSynced: false,
      });
    }
    const me = await loadMe(req.parent.id);
    if (!me) throw err;
    return {
      ...me,
      sync_status: 'refresh_pending',
      sync_warning: err.code || 'PARENT_REFRESH_FAILED',
    };
  };

  try {
    const refreshed = await refreshParentMirrorFromRagic({
      lineUid: req.parent.lineUid || parent.line_uid,
      phone: parent.phone,
      minStudents,
      preservePending: true,
      reason,
    });
    if (expectedStudent && !ragicStudentMatchesExpected(
      refreshed.ragicStudents || [],
      expectedStudent,
      sync?.z02?.ragicRecordId || expectedStudent.ragic_record_id || null
    )) {
      throw new ParentRefreshError(
        'RAGIC_REFRESH_STUDENTS_INCOMPLETE',
        '重新讀取 Ragic 學員資料尚未收斂',
        502
      );
    }
    if (expectedStudent) {
      await persistStudentMirrorAfterRagic({
        parentId: req.parent.id,
        studentId,
        student: expectedStudent,
        sync,
        markSynced: true,
      });
      return await loadMe(refreshed.local.id);
    }
    return await loadMe(refreshed.local.id);
  } catch (err) {
    if (!isStudentRefreshPendingError(err)) throw err;
    console.warn('[student-sync] Ragic 寫入成功，但刷新本地鏡像失敗；先回本地鏡像待下次收斂', {
      reason,
      phone: parent.phone,
      code: err.code,
      msg: err.message,
    });
    return pendingResponse(err);
  }
}

// demo 哨兵帳號（bootstrap coreSchema seed：line_uid = 'demo:<phone>'，供 /liff/demo 帳密測試）：
// /me 系列一律走「本地鏡像 only」——不寫 Ragic、不做嚴格刷新。理由：
//  (1) 政策「Z01 不收未綁/測試資料」，demo 異動不得寫進 Ragic；
//  (2) 嚴格刷新會比對 Ragic 端 line_uid 與哨兵值 → 必然 UID_MISMATCH，整個編輯流程會壞掉。
function isDemoParent(parentRow, tokenLineUid) {
  return String(parentRow?.line_uid || tokenLineUid || '').startsWith('demo:');
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

// 開場/進個資頁 → 主動向 Ragic 拉名單（Ragic 為名單權威，本地為鏡像）。
//   - 節流：last_synced_at 在 SYNC_THROTTLE_MS 內 → 直接回 DB，不打 Ragic。
//   - 刷新：reactivate=false（不重新啟用被移除的家長）+ id-stable upsert；
//     權威移除的學員只硬刪無業務 FK 殘留，有 FK 者保留本地關聯避免斷鏈。
//   - 讀取可靠性：Ragic 失敗/逾時 → 保留既有鏡像、回 sync_status='stale'，絕不清空、絕不回空名單。
//   活動紀錄（課程/堂數/簽到）一律讀本地，與本同步無關。
router.post('/me/sync', requireParent, async (req, res) => {
  try {
    const meRow = await pool.query(
      `SELECT id, phone, line_uid, last_synced_at FROM parents WHERE id = $1`,
      [req.parent.id]
    );
    if (!meRow.rowCount) return res.status(404).json({ error: '找不到家長帳號' });
    const p = meRow.rows[0];

    const last = p.last_synced_at ? new Date(p.last_synced_at).getTime() : 0;
    const fresh = last > 0 && (Date.now() - last) < SYNC_THROTTLE_MS;

    let syncStatus = fresh ? 'fresh' : 'synced';
    if (!fresh && p.line_uid && !String(p.line_uid).startsWith('demo:')) {
      try {
        await refreshParentMirrorFromRagic({
          lineUid: p.line_uid,
          phone: p.phone,
          reactivate: false,
          requireComplete: false,
          preservePending: true,
          // 開頁刷新不是安全門檻（本地 UID 已由登入時驗過），Z01 UID 尚未回寫不該讓同步整個失敗。
          // 仍會擋「Z01 已綁到別的 UID」的真衝突。
          strictUidMatch: false,
          reason: 'parents-me-sync',
        });
      } catch (err) {
        // 開頁同步不是簽 token 的安全門檻；失敗時保留既有鏡像，避免使用者進不了個資頁。
        console.warn('[parents/me/sync] refresh 失敗，保留既有鏡像：', err.message);
        syncStatus = err.code === 'RAGIC_REFRESH_NOT_FOUND' ? 'not_found_in_ragic' : 'stale';
      }
    }

    const me = await loadMe(req.parent.id);
    if (!me) return res.status(404).json({ error: '找不到家長帳號' });
    res.json({ ...me, sync_status: syncStatus });
  } catch (err) {
    console.error('[parents/me/sync]', err);
    // 同步出錯也盡量回 DB 鏡像，不讓前端拿不到資料。
    try {
      const me = await loadMe(req.parent.id);
      if (me) return res.json({ ...me, sync_status: 'error' });
    } catch { /* noop */ }
    res.status(500).json({ error: 'sync failed' });
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

    // demo 帳號：只更新本地鏡像（含場館），不寫 Ragic、不做嚴格刷新。
    if (isDemoParent(cur, req.parent.lineUid)) {
      await pool.query(
        `UPDATE parents SET name = $2, primary_venue_id = $3, identity = $4, gender = $5,
                email = $6, home_phone = $7, line_id = $8, home_address = $9, updated_at = NOW()
          WHERE id = $1`,
        [req.parent.id, patch.name, patch.primary_venue_id, patch.identity, patch.gender,
         patch.email, patch.home_phone, patch.line_id, patch.home_address]
      );
      console.log('[parent-sync] demo 帳號編輯：僅更新本地鏡像', { parent: patch.name, venue: patch.primary_venue_id });
      return res.json(await loadMe(req.parent.id));
    }

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

    // 嚴格刷新：Ragic 寫入成功後，重新拉 Z01/Z02，更新本地 parents/students，
    // 並同步標記 Z03/quarantine resolved。任一步失敗都不回成功，避免本地與 Ragic 漂移。
    const refreshed = await refreshParentMirrorFromRagic({
      lineUid: req.parent.lineUid,
      phone: cur.phone,
      reason: 'parent-profile-update',
    });
    const me = await loadMe(refreshed.local.id);
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

    // demo 帳號：學員直接寫本地（僅查重），不進 Ragic。
    if (isDemoParent(parent, req.parent.lineUid)) {
      const dupDemo = await pool.query(
        `SELECT id, parent_id FROM students WHERE id_number = $1 LIMIT 1`, [s.id_number]);
      if (dupDemo.rowCount && String(dupDemo.rows[0].parent_id) !== String(req.parent.id)) {
        return res.status(409).json({ error: '此身分證字號已有學員資料', code: 'STUDENT_ID_DUPLICATED' });
      }
      if (!dupDemo.rowCount) {
        await pool.query(
          `INSERT INTO students (parent_id, name, id_number, birth_date, gender, blood_type)
           VALUES ($1,$2,$3,$4,$5,NULLIF($6,''))`,
          [req.parent.id, s.name, s.id_number, s.birth_date, s.gender || null, s.blood_type || '']
        );
      }
      return res.status(201).json(await loadMe(req.parent.id));
    }

    // 場館可能在家長註冊後被停用/改代碼（五大場館重構期間風險最高）；不先擋，
    // 交給 Ragic 才會回一個含糊的 502「資料暫時無法完成同步」，使用者無從得知是館別問題。
    await assertVenueExists(parent.primary_venue_id);

    const parentForSync = await parentForStrictStudentSync(parent, req.parent.lineUid);
    const activeCount = Number(
      (await pool.query(
        `SELECT COUNT(*)::int AS n FROM students WHERE parent_id = $1 AND COALESCE(is_active, TRUE) = TRUE`,
        [req.parent.id]
      )).rows[0]?.n || 0
    );
    const dup = await pool.query(
      `SELECT id, parent_id, is_active, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id
         FROM students
        WHERE id_number = $1
        LIMIT 1`,
      [s.id_number]
    );
    let expectedMin = activeCount + 1;
    let mergedExisting = false;
    let sync = null;
    let fallbackStudentId = null;
    if (dup.rowCount) {
      const existing = dup.rows[0];
      if (String(existing.parent_id) !== String(req.parent.id)) {
        return res.status(409).json({
          error: '此身分證字號已有學員資料，請確認後再試；若需協助請聯絡客服。',
          code: 'STUDENT_ID_DUPLICATED',
        });
      }
      if (existing.is_active === false) {
        return res.status(409).json({
          error: '此學員曾由櫃台停用或移除，請聯絡客服協助恢復或重新建檔。',
          code: 'STUDENT_INACTIVE_CONTACT_COUNTER',
        });
      }

      mergedExisting = true;
      fallbackStudentId = existing.id;
      expectedMin = activeCount;
      console.log('[student-sync] 新增學員比對到既有資料，改為嚴格更新', { parent: parent.name, phone: parent.phone, student: s.name });
      sync = await ragic.updateStudentZ01Z02Strict({
        parent: parentForSync,
        student: { ...existing, ...s, _match_id_number: existing.id_number },
      });
    } else {
      console.log('[student-sync] 新增學員 start', { parent: parent.name, phone: parent.phone, student: s.name });
      sync = await ragic.createStudentZ01Z02Strict({ parent: parentForSync, student: s, startIndex: activeCount });
      console.log('[student-sync] 新增學員 Ragic 同步完成', { z02: sync?.z02?.ragicRecordId });
    }
    await persistStudentMirrorAfterRagic({
      parentId: req.parent.id,
      studentId: fallbackStudentId,
      student: s,
      sync,
    });

    const me = await refreshAfterStudentWrite(req, parentForSync, {
      minStudents: expectedMin,
      reason: mergedExisting ? 'parent-student-merge-existing' : 'parent-student-create',
      expectedStudent: s,
      studentId: fallbackStudentId,
      sync,
    });
    const saved = (me?.students || []).find((row) => String(row.id_number || '').toUpperCase() === s.id_number);
    if (saved && !mergedExisting) {
      writeStudentAudit(pool, saved.id, 'create', { byUser: parent.name, byRole: 'parent' })
        .catch((err) => console.warn('[student-audit] 家長新增稽核寫入失敗:', err.message));
    }
    res.status(mergedExisting ? 200 : 201).json(me);
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

    // demo 帳號：學員直接改本地，不進 Ragic。
    if (isDemoParent(parent, req.parent.lineUid)) {
      await pool.query(
        `UPDATE students SET name = $2, id_number = $3, birth_date = $4,
                gender = $5, blood_type = NULLIF($6,''), updated_at = NOW()
          WHERE id = $1`,
        [req.params.id, s.name, s.id_number, s.birth_date, s.gender || null, s.blood_type || '']
      );
      return res.json(await loadMe(req.parent.id));
    }

    // 場館可能在家長註冊後被停用/改代碼（五大場館重構期間風險最高）；不先擋，
    // 交給 Ragic 才會回一個含糊的 502「資料暫時無法完成同步」，使用者無從得知是館別問題。
    await assertVenueExists(parent.primary_venue_id);

    const parentForSync = await parentForStrictStudentSync(parent, req.parent.lineUid);
    const before = cur.rows[0];
    const syncStudent = { ...before, ...s, _match_id_number: before.id_number };
    console.log('[student-sync] 編輯學員 start', { parent: parent.name, phone: parent.phone, student: s.name, studentId: req.params.id });
    const sync = await ragic.updateStudentZ01Z02Strict({ parent: parentForSync, student: syncStudent });
    await persistStudentMirrorAfterRagic({
      parentId: req.parent.id,
      studentId: req.params.id,
      student: syncStudent,
      sync,
    });
    console.log('[student-sync] 編輯學員 Ragic 同步完成', { z02: sync?.z02?.ragicRecordId });

    const activeCount = Number(
      (await pool.query(
        `SELECT COUNT(*)::int AS n FROM students WHERE parent_id = $1 AND COALESCE(is_active, TRUE) = TRUE`,
        [req.parent.id]
      )).rows[0]?.n || 0
    );
    const me = await refreshAfterStudentWrite(req, parentForSync, {
      minStudents: activeCount,
      reason: 'parent-student-update',
      expectedStudent: syncStudent,
      studentId: req.params.id,
      sync,
    });

    // 稽核：家長自己改學員資料，記錄實際變動欄位（不含身分證/血型以外的敏感值以外的判斷，
    // 這裡沿用既有欄位白名單）。best-effort：稽核寫入失敗不擋家長編輯本身。
    const studentChanges = diffChanges(before, s, ['name', 'id_number', 'birth_date', 'gender', 'blood_type']);
    writeStudentAudit(pool, req.params.id, 'edit', { byUser: parent.name, byRole: 'parent', changes: studentChanges })
      .catch((err) => console.warn('[student-audit] 家長編輯稽核寫入失敗:', err.message));
    res.json(me);
  } catch (err) {
    console.error('[student-sync] 編輯學員 失敗', { code: err.code, msg: err.message });
    return ragicError(res, err);
  }
});

// 家長端「停用/刪除學員」已移除。
//   原因：(1) 會把「停用」寫進 Ragic Z02「學員身分」欄覆蓋身分類別（已修）；
//        (2) 直接停用/刪除會破壞與已報名課程的連結、製造孤兒資料。
//   政策：任何移除/轉出/寄掛異動一律由櫃台在 Ragic 端處理。
//   保留路徑並回 405 + 明確引導（前端按鈕已移除；此為直接打 API / 舊頁面的後端守門）。
router.delete('/me/students/:id', requireParent, (req, res) => {
  res.status(405).json({
    error: '學員資料異動（停用 / 移除 / 轉出）請洽櫃臺，或透過 LINE 官方帳號聯繫。',
    code: 'STUDENT_REMOVAL_VIA_COUNTER',
  });
});

router.post('/', async (req, res) => {
  const allowLegacyCreate = process.env.ALLOW_LEGACY_PARENT_CREATE === '1'
    && process.env.NODE_ENV !== 'production';
  if (!allowLegacyCreate) {
    return res.status(410).json({
      error: '家長註冊請改走 LINE 驗證流程',
      code: 'LINE_REGISTER_REQUIRED',
    });
  }

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
