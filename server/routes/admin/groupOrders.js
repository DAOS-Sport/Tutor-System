/**
 * 團購（group buy）— 後台審核 API（U6）
 * 掛載於 /api/admin/group-orders，角色 admin / manager / staff（櫃檯需可審）。
 *
 *   GET    /                 待審 + 歷史團購清單（依場館 scope 過濾）
 *   GET    /:id              團購詳情（成員 + 各自學生 + 匯款證明；後台可見原始姓名）
 *   POST   /:id/approve      核准：為每位成員建立 admin_enrollments（pending_payment，標記共享），
 *                            團購狀態 → approved
 *   POST   /:id/reject       退回：body { reason }，狀態 → rejected
 *
 * 核准後產生的報名沿用既有對帳流程（enrollments.js reconcile）逐筆收款。
 * 不更動既有報名路由。
 */
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../../models/db');
const {
  requireAdminAuth, requireAdminRole, getScopedVenueIds, isVenueInScope,
} = require('../../middlewares/adminAuth');

const router = express.Router();
const AMS = requireAdminRole('admin', 'manager', 'staff');

function genEnrollmentId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return `E${ts}${rand}`;
}

// 依 scope 過濾的 venue 條件（null = 全部）
function venueFilter(req, params, col = 'go.venue_id') {
  const scope = getScopedVenueIds(req);
  if (scope === null) return { clause: '', params };
  if (!scope.length) return { clause: ' AND FALSE', params };
  const idx = params.length + 1;
  params.push(scope);
  return { clause: ` AND ${col} = ANY($${idx})`, params };
}

// ── GET / 清單 ──────────────────────────────────────────────
router.get('/', requireAdminAuth, AMS, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    let params = [];
    let where = 'WHERE 1=1';
    if (status) { params.push(status); where += ` AND go.status = $${params.length}`; }
    else { where += ` AND go.status IN ('submitted','approved','rejected')`; }
    const vf = venueFilter(req, params);
    params = vf.params;

    const r = await pool.query(
      `SELECT go.*,
              p.name AS leader_name, p.phone AS leader_phone,
              c.name AS coach_name,
              (SELECT COUNT(*) FROM group_order_members m WHERE m.group_order_id = go.id) AS member_count,
              (SELECT COALESCE(SUM(COALESCE(array_length(m.student_names,1),0)),0)
                 FROM group_order_members m WHERE m.group_order_id = go.id) AS total_students
         FROM group_orders go
         JOIN parents p ON p.id = go.leader_parent_id
         LEFT JOIN coaches c ON c.id = go.coach_id
         ${where}${vf.clause}
        ORDER BY (go.status='submitted') DESC, go.submitted_at DESC NULLS LAST, go.created_at DESC`,
      params
    );
    res.json(r.rows.map((go) => ({
      id: go.id,
      status: go.status,
      venue_id: go.venue_id,
      course_type: go.course_type,
      coach_id: go.coach_id,
      coach_name: go.coach_name || null,
      period_count: go.period_count || 1,
      leader_name: go.leader_name,
      leader_phone: go.leader_phone,
      min_students: go.min_students,
      max_students: go.max_students,
      member_count: Number(go.member_count),
      total_students: Number(go.total_students),
      note: go.note || null,
      reject_reason: go.reject_reason || null,
      submitted_at: go.submitted_at,
      reviewed_by: go.reviewed_by || null,
      reviewed_at: go.reviewed_at || null,
      created_at: go.created_at,
    })));
  } catch (err) {
    console.error('[admin/group-orders GET]', err);
    res.status(500).json({ error: '載入失敗' });
  }
});

// ── GET /:id 詳情 ───────────────────────────────────────────
router.get('/:id', requireAdminAuth, AMS, async (req, res) => {
  try {
    const o = await pool.query(
      `SELECT go.*, p.name AS leader_name, p.phone AS leader_phone, c.name AS coach_name
         FROM group_orders go
         JOIN parents p ON p.id = go.leader_parent_id
         LEFT JOIN coaches c ON c.id = go.coach_id
        WHERE go.id = $1`,
      [req.params.id]
    );
    if (!o.rowCount) return res.status(404).json({ error: '找不到此團購' });
    const order = o.rows[0];
    if (!isVenueInScope(req, order.venue_id)) return res.status(403).json({ error: '無權檢視此場館的團購' });

    const ms = await pool.query(
      `SELECT m.*, p.name AS parent_name, p.phone AS parent_phone
         FROM group_order_members m
         JOIN parents p ON p.id = m.parent_id
        WHERE m.group_order_id = $1
        ORDER BY m.is_leader DESC, m.joined_at ASC`,
      [order.id]
    );
    res.json({
      id: order.id,
      status: order.status,
      venue_id: order.venue_id,
      course_type: order.course_type,
      coach_id: order.coach_id,
      coach_name: order.coach_name || null,
      period_count: order.period_count || 1,
      leader_name: order.leader_name,
      leader_phone: order.leader_phone,
      min_students: order.min_students,
      max_students: order.max_students,
      note: order.note || null,
      reject_reason: order.reject_reason || null,
      submitted_at: order.submitted_at,
      reviewed_by: order.reviewed_by || null,
      reviewed_at: order.reviewed_at || null,
      created_at: order.created_at,
      members: ms.rows.map((m) => ({
        id: m.id,
        parent_id: m.parent_id,
        parent_name: m.parent_name,
        parent_phone: m.parent_phone,
        is_leader: m.is_leader,
        student_names: m.student_names || [],
        student_count: (m.student_names || []).length,
        transfer_last_5: m.transfer_last_5 || null,
        payment_proof_url: m.payment_proof_url || null,
        payment_confirmed: !!m.payment_confirmed,
        status: m.status,
        joined_at: m.joined_at,
      })),
    });
  } catch (err) {
    console.error('[admin/group-orders GET /:id]', err);
    res.status(500).json({ error: '載入失敗' });
  }
});

// ── POST /:id/approve 核准 ──────────────────────────────────
router.post('/:id/approve', requireAdminAuth, AMS, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(`SELECT * FROM group_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!o.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '找不到此團購' }); }
    const order = o.rows[0];
    if (!isVenueInScope(req, order.venue_id)) { await client.query('ROLLBACK'); return res.status(403).json({ error: '無權審核此場館的團購' }); }
    if (order.status !== 'submitted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '只有「待審核」的團購可以核准', code: 'NOT_SUBMITTED' });
    }

    // 課程基準價 + 教練倍率（與一般報名一致）
    const cfg = await client.query(`SELECT base_price FROM course_type_configs WHERE course_type = $1`, [order.course_type]);
    const basePrice = cfg.rowCount ? Number(cfg.rows[0].base_price) || 0 : 0;
    let coachName = null;
    let multiplier = 1;
    if (order.coach_id) {
      const cr = await client.query(`SELECT name, pricing_multiplier FROM coaches WHERE id = $1`, [order.coach_id]);
      if (cr.rowCount) { coachName = cr.rows[0].name; multiplier = Number(cr.rows[0].pricing_multiplier) || 1; }
    }
    const perStudent = Math.round(basePrice * multiplier);
    // U9：一張團報訂單可購買多期；每位成員費用 = 單期價 × 學生數 × 期數。
    const periodCount = Number(order.period_count) || 1;

    const ms = await client.query(
      `SELECT m.*, p.name AS parent_name, p.phone AS parent_phone
         FROM group_order_members m JOIN parents p ON p.id = m.parent_id
        WHERE m.group_order_id = $1`,
      [order.id]
    );

    const missingProofs = ms.rows
      .filter((m) => !m.payment_proof_url)
      .map((m) => ({
        member_id: m.id,
        parent_id: m.parent_id,
        parent_name: m.parent_name,
        parent_phone: m.parent_phone,
        student_names: m.student_names || [],
      }));
    if (missingProofs.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: '仍有家庭尚未上傳匯款證明，請補齊後再核准成團',
        code: 'MISSING_PAYMENT_PROOF',
        missing_members: missingProofs,
      });
    }

    const createdIds = [];
    for (const m of ms.rows) {
      const names = m.student_names || [];
      const count = names.length || 1;
      // 訂單依期數拆分：每位成員的 N 期各自一筆（period_count=1，6 堂），各自付款/對帳。
      const memberBatchId = randomUUID();
      const perPeriodPrice = perStudent * count; // 單期（該成員所有學員）
      for (let j = 1; j <= periodCount; j += 1) {
        const eid = genEnrollmentId();
        await client.query(
          `INSERT INTO admin_enrollments
             (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
              original_price, final_price, transfer_last_5, payment_proof_url, status, submitted_at,
              group_order_id, is_group_shared, period_count, period_number, enrollment_batch_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_payment',NOW(),$13,TRUE,1,$14,$15)`,
          [
            eid, m.parent_name, m.parent_phone, names, coachName, order.coach_id,
            order.venue_id, order.course_type, perPeriodPrice, perPeriodPrice, m.transfer_last_5 || null, m.payment_proof_url,
            order.id, j, memberBatchId,
          ]
        );
        await client.query(
          `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
           VALUES ($1, $2, $3)`,
          [eid, '團購核准建立報名', req.adminUser?.username || 'system']
        );
        createdIds.push(eid);
      }
    }

    await client.query(
      `UPDATE group_orders SET status='approved', reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW()
        WHERE id=$1`,
      [order.id, req.adminUser?.username || 'system']
    );
    await client.query('COMMIT');
    res.json({ ok: true, enrollment_ids: createdIds, count: createdIds.length });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[admin/group-orders approve]', err);
    res.status(500).json({ error: '核准失敗' });
  } finally {
    client.release();
  }
});

// ── POST /:id/reject 退回 ───────────────────────────────────
router.post('/:id/reject', requireAdminAuth, AMS, async (req, res) => {
  try {
    const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.trim() : '';
    if (!reason) return res.status(400).json({ error: '請填寫退回原因' });
    const o = await pool.query(`SELECT venue_id FROM group_orders WHERE id = $1`, [req.params.id]);
    if (!o.rowCount) return res.status(404).json({ error: '找不到此團購' });
    if (!isVenueInScope(req, o.rows[0].venue_id)) return res.status(403).json({ error: '無權審核此場館的團購' });
    // 原子轉換：只在 submitted 時可退回，避免與並發 approve 互相覆蓋終態
    const r = await pool.query(
      `UPDATE group_orders SET status='rejected', reject_reason=$2, reviewed_by=$3, reviewed_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status='submitted' RETURNING id`,
      [req.params.id, reason, req.adminUser?.username || 'system']
    );
    if (!r.rowCount) return res.status(409).json({ error: '只有「待審核」的團購可以退回', code: 'NOT_SUBMITTED' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/group-orders reject]', err);
    res.status(500).json({ error: '退回失敗' });
  }
});

module.exports = router;
