/**
 * 客戶資料管理 — Z02 學員資料（含購買紀錄查詢） (F-A02C)
 *
 *   GET   /api/admin/customer-students             → 學員清單（含關聯家長）
 *   GET   /api/admin/customer-students/:id          → 單筆學員 + 家長 + 購買紀錄
 *   PATCH /api/admin/customer-students/:id           → 更新學員業務欄位（本地鏡像）
 *
 * 真相分工同 customerParents.js；新增學員請走 Z01 家長子表，不在此開 POST。
 * 權限：manager/staff 僅能存取「家長 primary_venue_id」落在自己場館的學員；admin 全域。
 * PII：身分證/血型預設遮罩，需帶 ?reveal=1（並寫稽核）才回原值；遮罩字串不得寫回真值。
 *
 * 購買紀錄：來自新系統 course_period_enrollments → course_periods（真實資料）。
 * 舊系統消費紀錄尚未清洗匯入，故 legacy 家庭此處可能為空（設計討論已知）。
 */
const express = require('express');
const { formatPlainDate } = require('../../utils/dateTime');
const { pool } = require('../../models/db');
const { parsePaging, pagingSql } = require('../../utils/paging');
const { requireAdminAuth, getScopedVenueIds, isVenueInScope } = require('../../middlewares/adminAuth');
const { parseRocOrIso, courseTypeLabel, maskId, maskBlood, looksMasked, wantReveal, auditReveal, diffChanges, writeStudentAudit, adminActorName } = require('./_customerShared');
const ragicWriteback = require('../../services/ragicWriteback');

const router = express.Router();

const STUDENT_SELECT = `s.id, s.parent_id, s.name, s.id_number, s.gender, s.birth_date, s.blood_type,
  s.student_code, s.ragic_record_id, s.is_active, s.last_synced_at,
  p.name AS parent_name, p.phone AS parent_phone, p.gender AS parent_gender,
  p.identity AS parent_identity, p.email AS parent_email, p.primary_venue_id AS parent_venue_id`;

function isRealLineUid(uid) {
  const s = String(uid || '').trim();
  return !!s && !s.startsWith('demo:') && !s.startsWith('DEMOTEST_');
}

function rowToStudent(r, reveal) {
  return {
    id: r.id,
    parent_id: r.parent_id,
    name: r.name || '',
    id_number: reveal ? (r.id_number || '') : maskId(r.id_number),
    gender: r.gender || '',
    birth_date: formatPlainDate(r.birth_date),
    blood_type: reveal ? (r.blood_type || '') : maskBlood(r.blood_type),
    student_code: r.student_code || '',
    ragic_record_id: r.ragic_record_id || null,
    is_active: r.is_active !== false,
    last_synced_at: r.last_synced_at || null,
    parent_name: r.parent_name || '',
    parent_phone: r.parent_phone || '',
    parent_gender: r.parent_gender || '',
    parent_identity: r.parent_identity || '',
    parent_email: r.parent_email || '',
    parent_venue_id: r.parent_venue_id || '',
  };
}

// GET / — 學員清單（含家長 join）
router.get('/', requireAdminAuth, async (req, res) => {
  try {
    const { name = '', gender = '', code = '', parentId = '' } = req.query;
    const where = [];
    const args = [];
    where.push(`COALESCE(s.name, '') <> 'ZZ-CANARY'`);
    where.push(`COALESCE(s.student_code, '') <> 'ZZ-CANARY'`);
    const scope = getScopedVenueIds(req); // 學員無場館鏡像 → 以家長 primary_venue_id 收斂
    if (scope) { args.push(scope); where.push(`p.primary_venue_id = ANY($${args.length}::text[])`); }
    if (parentId) { args.push(parentId);   where.push(`s.parent_id = $${args.length}`); }
    if (name)     { args.push(`%${name}%`); where.push(`s.name ILIKE $${args.length}`); }
    if (gender)   { args.push(gender);      where.push(`s.gender = $${args.length}`); }
    if (code)     { args.push(`%${code}%`); where.push(`(s.student_code ILIKE $${args.length} OR s.id_number ILIKE $${args.length})`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // 原本寫死 LIMIT 500，而學員已經 850 筆 —— 有 350 筆永遠看不到，
    // 而且畫面上沒有任何跡象。沒帶參數時維持 500 以免舊呼叫端行為改變。
    const paging = parsePaging(req, { defaultLimit: 500 });
    const reveal = wantReveal(req);
    const r = await pool.query(
      `SELECT ${STUDENT_SELECT}
         FROM students s LEFT JOIN parents p ON p.id = s.parent_id
         ${whereSql}
         ORDER BY s.is_active DESC, s.updated_at DESC NULLS LAST
         ${pagingSql(args, paging)}`,
      args
    );
    if (reveal && r.rowCount) auditReveal(req, 'student-list', r.rowCount);
    res.json(r.rows.map((row) => rowToStudent(row, reveal)));
  } catch (err) {
    console.error('[admin/customer-students] list', err);
    res.status(500).json({ error: '讀取學員清單失敗' });
  }
});

// GET /:id — 學員 + 家長 + 購買紀錄
router.get('/:id', requireAdminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${STUDENT_SELECT} FROM students s LEFT JOIN parents p ON p.id = s.parent_id WHERE s.id = $1`,
      [req.params.id]
    );
    if (!r.rowCount || !isVenueInScope(req, r.rows[0].parent_venue_id)) {
      return res.status(404).json({ error: '找不到此學員' });
    }
    const reveal = wantReveal(req);
    if (reveal) auditReveal(req, 'student-detail', 1);
    const purchases = await loadPurchases(req.params.id);
    res.json({ ...rowToStudent(r.rows[0], reveal), purchases });
  } catch (err) {
    console.error('[admin/customer-students] get', err);
    res.status(500).json({ error: '讀取學員失敗' });
  }
});

// GET /:id/audit-logs — 學員編輯紀錄（家長自己改 / 櫃檯 / 管理員改，含 before/after diff）
router.get('/:id/audit-logs', requireAdminAuth, async (req, res) => {
  try {
    const own = await pool.query(
      `SELECT p.primary_venue_id AS v FROM students s LEFT JOIN parents p ON p.id = s.parent_id WHERE s.id = $1`,
      [req.params.id]
    );
    if (!own.rowCount || !isVenueInScope(req, own.rows[0].v)) {
      return res.status(404).json({ error: '找不到此學員' });
    }
    const r = await pool.query(
      `SELECT id, at, action, by_user, by_role, changes, note
         FROM student_audit_logs WHERE student_id = $1
        ORDER BY at DESC, id DESC LIMIT 200`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[admin/customer-students] audit-logs', err);
    res.status(500).json({ error: '讀取編輯紀錄失敗' });
  }
});

// 購買紀錄查詢（新系統 course_periods）
async function loadPurchases(studentId) {
  const r = await pool.query(
    `SELECT cp.id, cp.course_type, cp.status, cp.total_sessions, cp.used_sessions,
            cp.final_price, cp.period_number, cp.created_at, cp.expires_at, e.enrolled_at
       FROM course_period_enrollments e
       JOIN course_periods cp ON cp.id = e.course_period_id
      WHERE e.student_id = $1
      ORDER BY cp.created_at DESC`,
    [studentId]
  );
  return r.rows.map((p) => ({
    id: p.id,
    category: courseTypeLabel(p.course_type),
    course_type: p.course_type,
    status: p.status,
    sessions: `${p.used_sessions ?? 0}/${p.total_sessions ?? 0}`,
    price: p.final_price,
    period_number: p.period_number,
    date: formatPlainDate(p.enrolled_at || p.created_at),
    expires_at: formatPlainDate(p.expires_at),
  }));
}

// PATCH /:id — 更新學員業務欄位（本地鏡像）
router.patch('/:id', requireAdminAuth, async (req, res) => {
  const b = req.body || {};
  if (b.name !== undefined && !String(b.name).trim()) return res.status(400).json({ error: '學員姓名不可為空', code: 'INPUT_INVALID' });
  try {
    // 權限：學員所屬家長場館需落在操作者範圍；順便撈稽核 diff 要用的目前值。
    const own = await pool.query(
      `SELECT p.primary_venue_id AS v, p.line_uid AS parent_line_uid,
              s.name, s.gender, s.id_number, s.blood_type, s.student_code, s.birth_date
         FROM students s LEFT JOIN parents p ON p.id = s.parent_id WHERE s.id = $1`,
      [req.params.id]
    );
    if (!own.rowCount || !isVenueInScope(req, own.rows[0].v)) {
      return res.status(404).json({ error: '找不到此學員' });
    }
    const before = own.rows[0];

    const sets = [];
    const args = [];
    // 遮罩字串不得寫回真值
    const idNum = looksMasked(b.id_number) ? undefined : b.id_number;
    const blood = looksMasked(b.blood_type) ? undefined : b.blood_type;
    const allow = { name: b.name, gender: b.gender, id_number: idNum, blood_type: blood, student_code: b.student_code };
    for (const [col, val] of Object.entries(allow)) {
      if (val === undefined) continue;
      args.push(val === '' ? null : val);
      sets.push(`${col} = $${args.length}`);
    }
    if (b.birth_date !== undefined) { args.push(parseRocOrIso(b.birth_date)); sets.push(`birth_date = $${args.length}::date`); }
    if (typeof b.is_active === 'boolean') { args.push(b.is_active); sets.push(`is_active = $${args.length}`); }
    if (b.is_active === true && !isRealLineUid(own.rows[0].parent_line_uid)) {
      return res.status(409).json({
        error: '此學員所屬家長尚未綁定真實 LINE，無法啟用',
        code: 'PARENT_UNBOUND_CANNOT_ACTIVATE_STUDENT',
      });
    }
    if (!sets.length) return res.status(400).json({ error: '沒有可更新的欄位' });
    args.push(req.params.id);
    // 先標記待同步（last_synced_at = NULL），下方即時回寫成功才蓋回 NOW()；
    // 失敗保持 NULL，由每日備份排程（ragicAdmin.backupParentsStudentsToRagic）重試。
    const r = await pool.query(
      `UPDATE students SET ${sets.join(', ')}, last_synced_at = NULL, updated_at = NOW() WHERE id = $${args.length}
       RETURNING id, parent_id, name, id_number, gender, birth_date, blood_type,
                 student_code, ragic_record_id, is_active, last_synced_at`,
      args
    );
    if (!r.rowCount) return res.status(404).json({ error: '找不到此學員' });
    // Option A 寫回 Ragic：即時回寫（best-effort、fire-and-forget，不擋本地更新）。
    ragicWriteback.scheduleWriteback({ studentIds: [req.params.id], reason: 'admin-student-patch' });
    const changes = diffChanges(before, r.rows[0], ['name', 'gender', 'id_number', 'blood_type', 'student_code', 'birth_date']);
    writeStudentAudit(pool, req.params.id, 'edit', { byUser: adminActorName(req), byRole: req.adminUser?.role, changes })
      .catch((err) => console.warn('[student-audit] 管理員編輯稽核寫入失敗:', err.message));
    res.json(rowToStudent(r.rows[0], wantReveal(req)));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '身分證字號或 Ragic 連結重複', code: 'UNIQUE_CONFLICT' });
    if (err.code === '23502') return res.status(400).json({ error: '學員姓名不可為空', code: 'INPUT_INVALID' });
    console.error('[admin/customer-students] patch', err);
    res.status(500).json({ error: '更新學員失敗' });
  }
});

module.exports = router;
