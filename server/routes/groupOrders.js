/**
 * 團購（group buy）— 家長端 API（U6）
 * 掛載於 /api/group-orders，全部需要 parent JWT。
 *
 * 流程：
 *   POST   /                       團主發起團購（status='forming'，回 join_token）
 *   GET    /mine                   我參與的團購清單（團主或成員）
 *   GET    /:id                    團購詳情（限本團成員；他家庭資料後端遮罩）
 *   GET    /by-token/:token        以邀請碼預覽要加入的團購（他家庭資料遮罩）
 *   POST   /by-token/:token/join   以邀請碼加入（帶自己學生 + 匯款證明）
 *   POST   /:id/submit             團主送審（人數需落在 [min,max]）
 *   POST   /:id/cancel             團主取消
 *
 * 不更動既有 /api/enrollments 一般報名路徑；團購是平行的新流程，
 * 待櫃檯核准後（admin/groupOrders.js）才會為每位成員產生 admin_enrollments。
 */
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../models/db');
const { objectExists } = require('../services/objectStorage');
const { requireParent } = require('../middlewares/parentAuth');
const { maskName, maskNames } = require('../utils/piiMask');
const line = require('../services/line');

const router = express.Router();
router.use(requireParent);

// 與 enrollments.js 共用的匯款證明路徑格式（local driver 產生）
const PROOF_URL_RE = /^\/uploads\/\d{4}-\d{2}\/[a-f0-9]{24}\.(jpg|jpeg|png)$/;

// 團購容量：與課程組別（1V2/1V3）脫鉤。價格仍依 course_type 計（核准時 per-student × 人數），
// 但揪團人數一律下限 1、上限 6，讓家長自由分享、最多湊到 6 人。
const GROUP_MIN_STUDENTS = 1;
const GROUP_MAX_STUDENTS = 6;

function validProof(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  return PROOF_URL_RE.test(u) && objectExists(u) ? u : null;
}

function genJoinToken() {
  return crypto.randomBytes(16).toString('hex'); // 32 hex chars
}

function cleanStudentNames(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => String(s || '').trim()).filter(Boolean);
}

// 將一筆 member row 整形為對外格式；isSelf=false 時遮罩姓名
function shapeMember(m, isSelf) {
  return {
    id: m.id,
    parent_id: isSelf ? m.parent_id : null,
    is_leader: m.is_leader,
    is_self: isSelf,
    parent_name: isSelf ? m.parent_name : maskName(m.parent_name),
    student_names: isSelf ? (m.student_names || []) : maskNames(m.student_names || []),
    student_count: (m.student_names || []).length,
    has_payment_proof: !!m.payment_proof_url,
    status: m.status,
    joined_at: m.joined_at,
  };
}

// 讀單一團購 + 成員（join parents 取姓名）；回 { order, members(raw) } 或 null
async function loadOrderWithMembers(client, orderId) {
  const o = await client.query(`SELECT * FROM group_orders WHERE id = $1`, [orderId]);
  if (!o.rowCount) return null;
  const ms = await client.query(
    `SELECT m.*, p.name AS parent_name
       FROM group_order_members m
       JOIN parents p ON p.id = m.parent_id
      WHERE m.group_order_id = $1
      ORDER BY m.is_leader DESC, m.joined_at ASC`,
    [orderId]
  );
  return { order: o.rows[0], members: ms.rows };
}

function totalStudents(members) {
  return members.reduce((n, m) => n + ((m.student_names || []).length), 0);
}

// 對外整形整張團購單（含成員，依 viewerParentId 決定遮罩）
function shapeOrder(order, members, viewerParentId, extra = {}) {
  const total = totalStudents(members);
  return {
    id: order.id,
    status: order.status,
    venue_id: order.venue_id,
    course_type: order.course_type,
    coach_id: order.coach_id,
    min_students: order.min_students,
    max_students: order.max_students,
    note: order.note || null,
    total_students: total,
    member_count: members.length,
    is_leader: order.leader_parent_id === viewerParentId,
    reject_reason: order.reject_reason || null,
    submitted_at: order.submitted_at,
    created_at: order.created_at,
    members: members.map((m) => shapeMember(m, m.parent_id === viewerParentId)),
    ...extra,
  };
}

// ── POST / 發起團購 ──────────────────────────────────────────
router.post('/', async (req, res) => {
  const p = req.body || {};
  const courseType = parseInt(p.course_type, 10);
  const venueId = p.venue_id ? String(p.venue_id).trim() : '';
  const coachId = p.coach_id ? String(p.coach_id).trim() : null;
  const studentNames = cleanStudentNames(p.student_names);
  const note = typeof p.note === 'string' ? p.note.trim().slice(0, 500) : null;
  const proof = validProof(p.payment_proof_url);

  if (isNaN(courseType) || courseType < 1) return res.status(400).json({ error: 'course_type 無效' });
  if (!venueId) return res.status(400).json({ error: '請選擇場館' });
  if (!studentNames.length) return res.status(400).json({ error: '請填寫至少一位學生姓名' });
  if (!proof) return res.status(400).json({ error: '請上傳匯款／轉帳證明', code: 'PAYMENT_PROOF_REQUIRED' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cfg = await client.query(
      `SELECT course_type, min_students, max_students, is_active
         FROM course_type_configs WHERE course_type = $1`,
      [courseType]
    );
    if (!cfg.rowCount || cfg.rows[0].is_active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '此課程需求不可用' });
    }
    // course_type 僅用於定價；團購容量固定 1–6（不沿用課程組別的 min/max）
    const min_students = GROUP_MIN_STUDENTS;
    const max_students = GROUP_MAX_STUDENTS;

    const vr = await client.query(`SELECT id, is_active FROM venues WHERE id = $1`, [venueId]);
    if (!vr.rowCount || vr.rows[0].is_active === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '場館不存在或已停用' });
    }

    if (coachId) {
      const cr = await client.query(`SELECT id FROM coaches WHERE id = $1`, [coachId]);
      if (!cr.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: '教練不存在' }); }
    }

    if (studentNames.length > max_students) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `學生人數已超過上限（最多 ${max_students} 人）` });
    }

    const token = genJoinToken();
    const o = await client.query(
      `INSERT INTO group_orders
         (leader_parent_id, venue_id, course_type, coach_id, status, join_token,
          min_students, max_students, note)
       VALUES ($1,$2,$3,$4,'forming',$5,$6,$7,$8)
       RETURNING *`,
      [req.parent.id, venueId, courseType, coachId, token, min_students, max_students, note]
    );
    const order = o.rows[0];
    await client.query(
      `INSERT INTO group_order_members
         (group_order_id, parent_id, student_names, payment_proof_url, is_leader, status)
       VALUES ($1,$2,$3,$4,TRUE,'joined')`,
      [order.id, req.parent.id, studentNames, proof]
    );

    await client.query('COMMIT');
    const loaded = await loadOrderWithMembers(pool, order.id);
    res.status(201).json({
      ...shapeOrder(loaded.order, loaded.members, req.parent.id),
      join_token: token, // 團主可拿到邀請碼分享
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[group-orders POST]', err);
    res.status(500).json({ error: '發起團購失敗' });
  } finally {
    client.release();
  }
});

// ── GET /mine 我參與的團購 ───────────────────────────────────
router.get('/mine', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT go.*,
              (SELECT COUNT(*) FROM group_order_members m WHERE m.group_order_id = go.id) AS member_count,
              (SELECT COALESCE(SUM(COALESCE(array_length(m.student_names,1),0)),0)
                 FROM group_order_members m WHERE m.group_order_id = go.id) AS total_students
         FROM group_orders go
        WHERE go.id IN (SELECT group_order_id FROM group_order_members WHERE parent_id = $1)
        ORDER BY go.created_at DESC`,
      [req.parent.id]
    );
    res.json(r.rows.map((go) => ({
      id: go.id,
      status: go.status,
      venue_id: go.venue_id,
      course_type: go.course_type,
      coach_id: go.coach_id,
      min_students: go.min_students,
      max_students: go.max_students,
      member_count: Number(go.member_count),
      total_students: Number(go.total_students),
      is_leader: go.leader_parent_id === req.parent.id,
      join_token: go.leader_parent_id === req.parent.id ? go.join_token : null,
      created_at: go.created_at,
    })));
  } catch (err) {
    console.error('[group-orders GET /mine]', err);
    res.status(500).json({ error: '載入失敗' });
  }
});

// ── GET /:id 團購詳情（限本團成員） ─────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const loaded = await loadOrderWithMembers(pool, req.params.id);
    if (!loaded) return res.status(404).json({ error: '找不到此團購' });
    const isMember = loaded.members.some((m) => m.parent_id === req.parent.id);
    if (!isMember) return res.status(403).json({ error: '無權檢視此團購' });
    const isLeader = loaded.order.leader_parent_id === req.parent.id;
    res.json(shapeOrder(loaded.order, loaded.members, req.parent.id,
      isLeader ? { join_token: loaded.order.join_token } : {}));
  } catch (err) {
    console.error('[group-orders GET /:id]', err);
    res.status(500).json({ error: '載入失敗' });
  }
});

// ── GET /by-token/:token 預覽要加入的團購 ───────────────────
router.get('/by-token/:token', async (req, res) => {
  try {
    const o = await pool.query(`SELECT * FROM group_orders WHERE join_token = $1`, [req.params.token]);
    if (!o.rowCount) return res.status(404).json({ error: '邀請碼無效' });
    const loaded = await loadOrderWithMembers(pool, o.rows[0].id);
    const alreadyMember = loaded.members.some((m) => m.parent_id === req.parent.id);
    res.json({
      ...shapeOrder(loaded.order, loaded.members, req.parent.id, {
        already_member: alreadyMember,
        joinable: loaded.order.status === 'forming' && !alreadyMember,
      }),
    });
  } catch (err) {
    console.error('[group-orders GET /by-token]', err);
    res.status(500).json({ error: '載入失敗' });
  }
});

// ── POST /by-token/:token/join 加入團購 ─────────────────────
router.post('/by-token/:token/join', async (req, res) => {
  const p = req.body || {};
  const studentNames = cleanStudentNames(p.student_names);
  const proof = validProof(p.payment_proof_url);
  if (!studentNames.length) return res.status(400).json({ error: '請填寫至少一位學生姓名' });
  if (!proof) return res.status(400).json({ error: '請上傳匯款／轉帳證明', code: 'PAYMENT_PROOF_REQUIRED' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 鎖住此團購，避免並發加入超過上限
    const o = await client.query(
      `SELECT * FROM group_orders WHERE join_token = $1 FOR UPDATE`, [req.params.token]
    );
    if (!o.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '邀請碼無效' }); }
    const order = o.rows[0];
    if (order.status !== 'forming') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此團購已不在揪團中，無法加入', code: 'NOT_FORMING' });
    }

    const dup = await client.query(
      `SELECT 1 FROM group_order_members WHERE group_order_id = $1 AND parent_id = $2`,
      [order.id, req.parent.id]
    );
    if (dup.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: '您已加入此團購', code: 'ALREADY_MEMBER' }); }

    const cur = await client.query(
      `SELECT COALESCE(SUM(COALESCE(array_length(student_names,1),0)),0) AS total
         FROM group_order_members WHERE group_order_id = $1`,
      [order.id]
    );
    const curTotal = Number(cur.rows[0].total);
    if (curTotal + studentNames.length > order.max_students) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `加入後將超過人數上限（最多 ${order.max_students} 人，目前 ${curTotal} 人）`,
        code: 'OVER_CAPACITY',
      });
    }

    await client.query(
      `INSERT INTO group_order_members
         (group_order_id, parent_id, student_names, payment_proof_url, is_leader, status)
       VALUES ($1,$2,$3,$4,FALSE,'joined')`,
      [order.id, req.parent.id, studentNames, proof]
    );
    await client.query('COMMIT');

    const loaded = await loadOrderWithMembers(pool, order.id);
    res.status(201).json(shapeOrder(loaded.order, loaded.members, req.parent.id));

    // best-effort：LINE 推播通知團主「有人加入，可前往送審」（不阻塞回應；失敗只記 log）
    if (order.leader_parent_id && order.leader_parent_id !== req.parent.id) {
      try {
        const ld = await pool.query(`SELECT line_uid FROM parents WHERE id = $1`, [order.leader_parent_id]);
        const leaderUid = ld.rows[0]?.line_uid;
        if (leaderUid) {
          const total = totalStudents(loaded.members);
          const me = loaded.members.find((m) => m.parent_id === req.parent.id);
          const liffUrl = (process.env.LIFF_URL_PARENT || process.env.LIFF_URL || 'https://liff.line.me/-') + `/group/${order.id}`;
          line.pushMessage(leaderUid, line.templates.groupMemberJoined({
            memberName: maskName(me?.parent_name || ''),
            total, min: order.min_students, max: order.max_students,
            reachedMin: total >= order.min_students, liffUrl,
          }), order.venue_id).catch((e) => console.warn('[group join push]', e.message));
        }
      } catch (e) { console.warn('[group join push prep]', e.message); }
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[group-orders join]', err);
    res.status(500).json({ error: '加入失敗' });
  } finally {
    client.release();
  }
});

// ── POST /:id/submit 團主送審 ───────────────────────────────
router.post('/:id/submit', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(`SELECT * FROM group_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!o.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '找不到此團購' }); }
    const order = o.rows[0];
    if (order.leader_parent_id !== req.parent.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '只有團主可以送審' });
    }
    if (order.status !== 'forming') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此團購狀態無法送審', code: 'NOT_FORMING' });
    }
    const cur = await client.query(
      `SELECT COALESCE(SUM(COALESCE(array_length(student_names,1),0)),0) AS total
         FROM group_order_members WHERE group_order_id = $1`,
      [order.id]
    );
    const total = Number(cur.rows[0].total);
    if (total < order.min_students) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `尚未達成團最低人數（需 ${order.min_students} 人，目前 ${total} 人）`,
        code: 'BELOW_MIN',
      });
    }
    if (total > order.max_students) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `超過人數上限（最多 ${order.max_students} 人）`, code: 'OVER_CAPACITY' });
    }
    const r = await client.query(
      `UPDATE group_orders SET status='submitted', submitted_at=NOW(), updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [order.id]
    );
    await client.query('COMMIT');
    const loaded = await loadOrderWithMembers(pool, r.rows[0].id);
    res.json(shapeOrder(loaded.order, loaded.members, req.parent.id));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[group-orders submit]', err);
    res.status(500).json({ error: '送審失敗' });
  } finally {
    client.release();
  }
});

// ── POST /:id/cancel 團主取消 ───────────────────────────────
router.post('/:id/cancel', async (req, res) => {
  try {
    const o = await pool.query(`SELECT leader_parent_id FROM group_orders WHERE id = $1`, [req.params.id]);
    if (!o.rowCount) return res.status(404).json({ error: '找不到此團購' });
    if (o.rows[0].leader_parent_id !== req.parent.id) return res.status(403).json({ error: '只有團主可以取消' });
    // 原子轉換：只在 forming/submitted 時可取消，避免覆蓋已核准/已退回的終態
    const r = await pool.query(
      `UPDATE group_orders SET status='cancelled', updated_at=NOW()
        WHERE id=$1 AND status IN ('forming','submitted') RETURNING id`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(409).json({ error: '此團購狀態無法取消' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[group-orders cancel]', err);
    res.status(500).json({ error: '取消失敗' });
  }
});

module.exports = router;
