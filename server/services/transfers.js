/**
 * 課程轉讓服務 (F-S08 / F-M04)
 * - createRequest：家長端送出申請（轉入方手機 → 找 / 建 student）
 * - listForAdmin：後台清單，可依 status / venue 篩選
 * - approve / reject：主管審核
 *   approve：以 transaction 將原 enrollment 標 transferred_out + 新建轉入學員 enrollment
 */
const { pool } = require('../models/db');
const ragicWriteback = require('./ragicWriteback');

async function listMine(parentId) {
  const r = await pool.query(
    `SELECT t.*, cp.coach_id, cp.venue_id, cp.course_type,
            co.name AS coach_name, fs.name AS from_student_name
       FROM transfer_records t
       JOIN course_periods cp ON cp.id = t.course_period_id
       JOIN coaches co ON co.id = cp.coach_id
       JOIN students fs ON fs.id = t.from_student_id
      WHERE t.from_parent_id = $1
      ORDER BY t.created_at DESC LIMIT 50`,
    [parentId]
  );
  return r.rows;
}

async function listForAdmin({ status, venueId, venueIds } = {}) {
  const conds = []; const args = [];
  if (status) { args.push(status); conds.push(`t.status = $${args.length}`); }
  // Task #90：venueIds 陣列優先；舊呼叫端 venueId 仍相容
  if (Array.isArray(venueIds) && venueIds.length) {
    args.push(venueIds);
    conds.push(`cp.venue_id = ANY($${args.length}::text[])`);
  } else if (venueId) {
    args.push(venueId);
    conds.push(`cp.venue_id = $${args.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT t.*, cp.coach_id, cp.venue_id, cp.course_type,
            co.name AS coach_name, fs.name AS from_student_name,
            fp.name AS from_parent_name, fp.phone AS from_parent_phone
       FROM transfer_records t
       JOIN course_periods cp ON cp.id = t.course_period_id
       JOIN coaches co ON co.id = cp.coach_id
       JOIN students fs ON fs.id = t.from_student_id
       JOIN parents fp ON fp.id = t.from_parent_id
      ${where}
      ORDER BY t.created_at DESC LIMIT 200`,
    args
  );
  return r.rows;
}

async function createRequest({ parentId, periodId, fromStudentId, toPhone, toStudentName, reason }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 驗證 enrollment 屬於該家長
    const en = await client.query(
      `SELECT cpe.id, cp.id AS period_id,
              (cp.total_sessions - cp.used_sessions) AS remaining
         FROM course_period_enrollments cpe
         JOIN course_periods cp ON cp.id = cpe.course_period_id
         JOIN students s ON s.id = cpe.student_id
        WHERE cp.id = $1 AND s.id = $2 AND s.parent_id = $3
          AND cpe.status = 'active' AND cp.status = 'active'`,
      [periodId, fromStudentId, parentId]
    );
    if (!en.rowCount) throw Object.assign(new Error('找不到可轉讓的課程'), { status: 400 });
    const remaining = en.rows[0].remaining;
    if (remaining <= 0) throw Object.assign(new Error('此課程剩餘堂數為 0，無法轉讓'), { status: 400 });

    // 防重複（同 period + from_student + pending_review 一筆）
    const dup = await client.query(
      `SELECT 1 FROM transfer_records
        WHERE course_period_id = $1 AND from_student_id = $2 AND status = 'pending_review'`,
      [periodId, fromStudentId]
    );
    if (dup.rowCount) throw Object.assign(new Error('已有審核中的申請'), { status: 409 });

    // 預先嘗試找到轉入方家長 / 學員（沒有也允許，由主管審核時補建）
    const toParent = await client.query(`SELECT id FROM parents WHERE phone = $1`, [toPhone]);
    const toParentId = toParent.rows[0]?.id || null;

    const ins = await client.query(
      `INSERT INTO transfer_records
         (course_period_id, from_student_id, from_parent_id, to_phone, to_parent_id,
          to_student_name, sessions_remaining, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [periodId, fromStudentId, parentId, toPhone, toParentId, toStudentName || null, remaining, reason || '']
    );
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function approve({ id, adminUserId, note }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query(
      `SELECT * FROM transfer_records WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!t.rowCount) throw Object.assign(new Error('找不到轉讓申請'), { status: 404 });
    if (t.rows[0].status !== 'pending_review') {
      throw Object.assign(new Error(`狀態為 ${t.rows[0].status}，無法核准`), { status: 409 });
    }
    const tr = t.rows[0];

    // 找 / 建轉入家長
    let toParentId = tr.to_parent_id;
    if (!toParentId) {
      const p = await client.query(`SELECT id FROM parents WHERE phone = $1`, [tr.to_phone]);
      toParentId = p.rows[0]?.id;
      if (!toParentId) {
        throw Object.assign(new Error(`轉入手機 ${tr.to_phone} 尚未註冊家長帳號`), { status: 400 });
      }
    }
    // 找 / 建轉入學員
    let toStudentId = tr.to_student_id;
    let createdToStudent = false; // 新建者 COMMIT 後即時回寫 Ragic（新列 last_synced_at 預設 NULL）
    if (!toStudentId) {
      const sName = tr.to_student_name || '轉入學員';
      const sExist = await client.query(
        `SELECT id FROM students WHERE parent_id = $1 AND name = $2 LIMIT 1`,
        [toParentId, sName]
      );
      if (sExist.rowCount) {
        toStudentId = sExist.rows[0].id;
      } else {
        const sIns = await client.query(
          `INSERT INTO students (parent_id, name) VALUES ($1, $2) RETURNING id`,
          [toParentId, sName]
        );
        toStudentId = sIns.rows[0].id;
        createdToStudent = true;
      }
    }

    // 原 enrollment 標 transferred_out
    await client.query(
      `UPDATE course_period_enrollments SET status = 'transferred_out'
        WHERE course_period_id = $1 AND student_id = $2`,
      [tr.course_period_id, tr.from_student_id]
    );
    // 新增轉入 enrollment
    await client.query(
      `INSERT INTO course_period_enrollments (course_period_id, student_id, status)
       VALUES ($1, $2, 'active') ON CONFLICT (course_period_id, student_id) DO NOTHING`,
      [tr.course_period_id, toStudentId]
    );
    // 標記 transfer_records
    await client.query(
      `UPDATE transfer_records
          SET status='approved', reviewed_by=$2, reviewed_at=NOW(),
              review_note=$3, to_parent_id=$4, to_student_id=$5, updated_at=NOW()
        WHERE id=$1`,
      [id, adminUserId, note || null, toParentId, toStudentId]
    );
    // 審核軌跡：transfer_records 本身已記 reviewed_by / reviewed_at / review_note，
    // 並透過上面 transferred_out / 新建 active enrollment 的狀態變動，達成端對端可追溯。
    // （admin_enrollment_audit_logs 之 FK 對應 admin_enrollments，與本表不同網段，故不寫入。）
    await client.query('COMMIT');
    // 即時回寫 Ragic（best-effort、fire-and-forget）：僅新建的轉入學員需要；
    // 失敗時該列保持 last_synced_at IS NULL，由每日備份排程重試。
    if (createdToStudent) {
      ragicWriteback.scheduleWriteback({ studentIds: [toStudentId], reason: 'transfer-approve' });
    }
    return { ...tr, status: 'approved', to_parent_id: toParentId, to_student_id: toStudentId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function reject({ id, adminUserId, note }) {
  const r = await pool.query(
    `UPDATE transfer_records
        SET status='rejected', reviewed_by=$2, reviewed_at=NOW(),
            review_note=$3, updated_at=NOW()
      WHERE id=$1 AND status='pending_review'
      RETURNING *`,
    [id, adminUserId, note || '']
  );
  if (!r.rowCount) throw Object.assign(new Error('狀態變更失敗（可能已被審核）'), { status: 409 });
  return r.rows[0];
}

async function cancel({ id, parentId }) {
  const r = await pool.query(
    `UPDATE transfer_records SET status='cancelled', updated_at=NOW()
      WHERE id=$1 AND from_parent_id=$2 AND status='pending_review'
      RETURNING *`,
    [id, parentId]
  );
  if (!r.rowCount) throw Object.assign(new Error('無法取消（可能已審核或非本人）'), { status: 409 });
  return r.rows[0];
}

module.exports = { listMine, listForAdmin, createRequest, approve, reject, cancel };
