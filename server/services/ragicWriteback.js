/**
 * server/services/ragicWriteback.js — 使用者發起的 parents/students 本地異動 → Ragic 即時回寫（best-effort）
 *
 * 使用契約（與 ragicAdmin._backupParentsStudentsImpl 每日備份、routes/parents.js 嚴格同步語意對齊）：
 *  - 呼叫端先在「同一交易」把異動列標記待同步（UPDATE 一律附 last_synced_at = NULL；
 *    INSERT 新列該欄預設即為 NULL），提交後再呼叫 scheduleWriteback() 即時回寫 Ragic；
 *    回寫成功才把 last_synced_at 蓋回 NOW()。
 *  - 回寫失敗只記 warn、絕不擋本地操作：該列保持 last_synced_at IS NULL，由每日 00:30
 *    備份排程（ragicAdmin.backupParentsStudentsToRagic，撈 ragic_record_id IS NULL OR
 *    last_synced_at IS NULL）重試補寫。
 *  - 停用列（is_active = FALSE）不回寫：Ragic 端的移除/停用一律由櫃台在 Ragic 處理
 *    （見 routes/parents.js DELETE /me/students 政策註解、ragic.deactivateStudentZ02Strict
 *    DEPRECATED 註解——Z01/Z02 沒有可安全代表「停用」的欄位，硬寫只會重新覆蓋資料）。
 *    該列保持待同步，之後若重新啟用會再走即時回寫或每日備份。
 *  - 「資料來源是 Ragic」的本地寫入（services/parentSync.js、ragicAdmin 每日 pull、
 *    註冊/綁定刷新）不得呼叫本模組，避免 Ragic→本地→Ragic 回音循環。
 */
const { pool } = require('../models/db');
const ragic = require('./ragic');

// 與 ragicAdmin.ragicEnabled 同義（不 require ragicAdmin，避免服務層互相糾纏）。
function _ragicEnabled() {
  return !!process.env.RAGIC_API_KEY && !!process.env.RAGIC_BASE_URL;
}

function _isoDate(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  try { return new Date(v).toISOString().slice(0, 10); } catch { return ''; }
}

// 家長單筆回寫：Z01 全欄位（與 ragicAdmin._backupParentToRagic 相同 payload），
// syncParentProfileStrict 內含「本地 ragic_record_id 失效 → 手機重查 / 新建」自我修復。
async function syncParentNow(parentId) {
  const r = await pool.query(
    `SELECT id, name, phone, gender, email, identity, primary_venue_id,
            home_phone, line_id, home_address, ragic_record_id, line_uid, is_active
       FROM parents WHERE id = $1`,
    [parentId]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.is_active === false) {
    console.warn('[ragic-writeback] parent 已停用，略過回寫（移除由櫃台在 Ragic 端處理）:', parentId);
    return null;
  }
  // 政策：Z01 只收已綁 LINE UID 的會員。未綁列不回寫，避免在 Ragic Z01 產生未綁殘留
  // （推上去只會被夜間 pull 分流進 Z03 佇列，形成清不完的循環）。
  // `demo:` 哨兵 UID（bootstrap demo 帳號）＝本地測試資料，同樣不回寫。
  if (!row.line_uid || String(row.line_uid).startsWith('demo:')) {
    console.warn('[ragic-writeback] parent 未綁 LINE UID（或 demo 帳號），略過回寫（Z01 不收未綁/測試資料）:', parentId);
    return null;
  }
  const venueName = await ragic.venueLabel(row.primary_venue_id);
  const payload = {
    [ragic.FIELD.Z01.PARENT_NAME]: row.name || '',
    [ragic.FIELD.Z01.VENUE]: venueName || row.primary_venue_id || '',
    [ragic.FIELD.Z01.PHONE]: row.phone || '',
    [ragic.FIELD.Z01.IDENTITY]: row.identity || '一般身分',
    [ragic.FIELD.Z01.GENDER]: ragic.normalizeGender(row.gender),
    [ragic.FIELD.Z01.EMAIL]: row.email || '',
    [ragic.FIELD.Z01.HOME_PHONE]: row.home_phone || '',
    [ragic.FIELD.Z01.LINE_ID]: row.line_id || '',
    [ragic.FIELD.Z01.HOME_ADDRESS]: row.home_address || '',
  };
  const ragicRecordId = await ragic.syncParentProfileStrict(row, payload);
  await pool.query(
    `UPDATE parents SET ragic_record_id = $2, last_synced_at = NOW() WHERE id = $1`,
    [row.id, ragicRecordId]
  );
  return String(ragicRecordId);
}

// 學員單筆回寫：Z01 子表 best-effort + Z02 嚴格 upsert（與 ragicAdmin._backupStudentToRagic 同分流），
// 帶 ragic_record_id / _match_id_number 讓 Ragic 端比對更精準（同 routes/parents.js 編輯流程）。
async function syncStudentNow(studentId) {
  const r = await pool.query(
    `SELECT s.id, s.parent_id, s.name, s.id_number, s.birth_date, s.gender, s.blood_type,
            s.student_code, s.ragic_record_id, s.is_active,
            p.name AS p_name, p.phone AS p_phone, p.gender AS p_gender, p.email AS p_email,
            p.identity AS p_identity, p.primary_venue_id AS p_venue, p.line_uid AS p_line_uid,
            p.ragic_record_id AS p_ragic_record_id, p.is_active AS p_is_active
       FROM students s
       JOIN parents p ON p.id = s.parent_id
      WHERE s.id = $1`,
    [studentId]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.is_active === false || row.p_is_active === false) {
    console.warn('[ragic-writeback] student/parent 已停用，略過回寫（移除由櫃台在 Ragic 端處理）:', studentId);
    return null;
  }
  // 家長未綁 UID → 學員也不回寫：createStudentZ01Z02Strict 的自我修復會替不存在的
  // 家長在 Z01 建新列，等於從側門把未綁家長塞進 Z01。demo 哨兵帳號同略。
  if (!row.p_line_uid || String(row.p_line_uid).startsWith('demo:')) {
    console.warn('[ragic-writeback] 家長未綁 LINE UID（或 demo 帳號），略過學員回寫（Z01 不收未綁/測試資料）:', studentId);
    return null;
  }
  const parent = {
    id: row.parent_id, name: row.p_name, phone: row.p_phone, gender: row.p_gender,
    email: row.p_email, identity: row.p_identity, primary_venue_id: row.p_venue,
    ragic_record_id: row.p_ragic_record_id, line_uid: row.p_line_uid,
  };
  const student = {
    name: row.name, id_number: row.id_number, birth_date: _isoDate(row.birth_date),
    gender: row.gender, blood_type: row.blood_type, student_code: row.student_code,
    ragic_record_id: row.ragic_record_id, _match_id_number: row.id_number,
  };
  let sync;
  if (row.ragic_record_id) {
    sync = await ragic.updateStudentZ01Z02Strict({ parent, student });
  } else {
    const startIndex = Number(
      (await pool.query(`SELECT COUNT(*)::int AS n FROM students WHERE parent_id = $1`, [row.parent_id])).rows[0]?.n || 0
    );
    sync = await ragic.createStudentZ01Z02Strict({ parent, student, startIndex });
  }
  const z02Id = sync?.z02?.ragicRecordId || null;
  await pool.query(
    `UPDATE students SET ragic_record_id = COALESCE($2, ragic_record_id), last_synced_at = NOW() WHERE id = $1`,
    [row.id, z02Id]
  );
  if (sync?.parentRagicRecordId) {
    await pool.query(
      `UPDATE parents SET ragic_record_id = COALESCE(ragic_record_id, $2) WHERE id = $1`,
      [row.parent_id, sync.parentRagicRecordId]
    );
  }
  return z02Id ? String(z02Id) : null;
}

/**
 * 交易提交後呼叫：即時回寫 Ragic。
 *  - fire-and-forget（不需 await；回傳 Promise 供測試端等待，保證不 reject）。
 *  - 家長先、學員後（家長回寫會校正 ragic_record_id，學員回寫重新讀 DB 即可受益），
 *    多位學員循序處理，避免併發打 Ragic 造成 Z01 子表 startIndex 競態。
 *  - 任一筆失敗只記 warn：該列已由呼叫端標記 last_synced_at = NULL（或新列預設 NULL），
 *    由每日備份排程重試，本地操作不受影響。
 */
function scheduleWriteback({ parentId = null, studentIds = [], reason = 'user-edit' } = {}) {
  const ids = [...new Set((studentIds || []).filter(Boolean).map(String))];
  if (!parentId && !ids.length) return Promise.resolve();
  if (!_ragicEnabled()) {
    console.warn('[ragic-writeback] Ragic 未設定，略過即時回寫（列保持待同步）', { reason, parentId, students: ids.length });
    return Promise.resolve();
  }
  return (async () => {
    if (parentId) {
      try {
        const ragicId = await syncParentNow(parentId);
        if (ragicId) console.log('[ragic-writeback] parent 已回寫', { reason, parentId, ragicId });
      } catch (err) {
        console.warn(`[ragic-writeback] parent 回寫失敗（保持待同步，交由每日備份重試） reason=${reason} id=${parentId}:`, err.message);
      }
    }
    for (const sid of ids) {
      try {
        const z02Id = await syncStudentNow(sid);
        if (z02Id !== null) console.log('[ragic-writeback] student 已回寫', { reason, studentId: sid, z02Id });
      } catch (err) {
        console.warn(`[ragic-writeback] student 回寫失敗（保持待同步，交由每日備份重試） reason=${reason} id=${sid}:`, err.message);
      }
    }
  })();
}

module.exports = { scheduleWriteback, syncParentNow, syncStudentNow };
