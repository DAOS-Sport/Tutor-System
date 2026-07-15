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
const { createCheckoutSession } = require('../../services/checkouts');
const { isGloballyEnabled } = require('../../config/businessFeatureFlags');
const { parseProofInput } = require('../../services/paymentProof');
const { logGroupOrderAudit } = require('../../services/groupOrderAudit');
const {
  validateRequestId,
  payloadFingerprint,
  acquireRequestLock,
} = require('../../services/idempotency');

const router = express.Router();
const AMS = requireAdminRole('admin', 'manager', 'staff');
const GROUP_APPROVAL_OPERATION = 'approve_group_order_checkouts';

// 場館來源優先：已開通 course period → registration item → 團購商品 mapping。
// 每一層都 DISTINCT 聚合全部場館，不用 LIMIT 1 掩蓋跨館資料。
const RESOLVED_VENUES_SQL = `COALESCE(
  (SELECT jsonb_agg(to_jsonb(vp) ORDER BY vp.name, vp.id)
     FROM (
       SELECT DISTINCT cp.venue_id AS id,
              COALESCE(NULLIF(av.name, ''), v.name, cp.venue_id) AS name
         FROM course_periods cp
         LEFT JOIN venues v ON v.id = cp.venue_id
         LEFT JOIN admin_venues av ON av.id = cp.venue_id
        WHERE cp.group_order_id = go.id
          AND COALESCE(cp.entitlement_state, 'ACTIVE') <> 'SUPERSEDED'
          AND cp.venue_id IS NOT NULL
     ) vp),
  (SELECT jsonb_agg(to_jsonb(ve) ORDER BY ve.name, ve.id)
     FROM (
       SELECT DISTINCT ae.venue_id AS id,
              COALESCE(NULLIF(av.name, ''), v.name, ae.venue_id) AS name
         FROM admin_enrollments ae
         LEFT JOIN venues v ON v.id = ae.venue_id
         LEFT JOIN admin_venues av ON av.id = ae.venue_id
        WHERE ae.group_order_id = go.id AND ae.venue_id IS NOT NULL
     ) ve),
  (SELECT jsonb_build_array(jsonb_build_object(
            'id', go.venue_id,
            'name', COALESCE(
              (SELECT NULLIF(av.name, '') FROM admin_venues av WHERE av.id = go.venue_id),
              (SELECT v.name FROM venues v WHERE v.id = go.venue_id),
              go.venue_id)))
     WHERE go.venue_id IS NOT NULL),
  '[]'::jsonb
)`;

function venueContract(row) {
  const venues = Array.isArray(row.resolved_venues) ? row.resolved_venues : [];
  return {
    venues,
    venue_mapping_status: venues.length ? 'RESOLVED' : 'VENUE_MAPPING_REQUIRED',
    group_venue_display_v2_enabled: isGloballyEnabled('GROUP_VENUE_DISPLAY_V2'),
  };
}

async function readApprovedGroupResult(client, groupOrderId, { idempotent = false } = {}) {
  const result = await client.query(
    `SELECT id, checkout_id
       FROM admin_enrollments
      WHERE group_order_id = $1
      ORDER BY submitted_at, period_number, id`,
    [groupOrderId]
  );
  const checkoutIds = [...new Set(result.rows.map((row) => row.checkout_id).filter(Boolean))];
  return {
    ok: true,
    group_order_id: groupOrderId,
    enrollment_ids: result.rows.map((row) => row.id),
    checkout_ids: checkoutIds,
    count: result.rowCount,
    idempotent,
  };
}

function genEnrollmentId() {
  const ts = Date.now().toString(36).toUpperCase();
  // 團購核准會在同一個 transaction 內一次建立「家庭 × 期數」多筆子訂單。
  // 兩碼隨機數在 1v3/1v4 以上很容易在同毫秒碰撞，改用與一般報名相同等級的 UUID 熵；
  // 僅影響新單號格式，不重寫既有資料。
  const rand = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
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
              ${RESOLVED_VENUES_SQL} AS resolved_venues,
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
      ...venueContract(go),
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
      `SELECT go.*, p.name AS leader_name, p.phone AS leader_phone, c.name AS coach_name,
              ${RESOLVED_VENUES_SQL} AS resolved_venues
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
    const audit = await pool.query(
      `SELECT at, action, by_user, reason
         FROM group_order_audit_logs
        WHERE group_order_id = $1
        ORDER BY at ASC, id ASC`,
      [order.id]
    );
    res.json({
      id: order.id,
      status: order.status,
      venue_id: order.venue_id,
      ...venueContract(order),
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
        proof_uploaded_at: m.proof_uploaded_at || null,
        payment_confirmed: !!m.payment_confirmed,
        status: m.status,
        joined_at: m.joined_at,
      })),
      audit_logs: audit.rows.map((x) => ({
        at: x.at,
        action: x.action,
        by: x.by_user,
        ...(x.reason ? { reason: x.reason } : {}),
      })),
    });
  } catch (err) {
    console.error('[admin/group-orders GET /:id]', err);
    res.status(500).json({ error: '載入失敗' });
  }
});

// ── POST /:id/approve 核准 ──────────────────────────────────
router.post('/:id/approve', requireAdminAuth, AMS, async (req, res) => {
  const requestCheck = validateRequestId(req.body?.request_id || req.get('Idempotency-Key'));
  if (requestCheck.error) {
    return res.status(requestCheck.status).json({ error: requestCheck.error, code: requestCheck.code });
  }
  const requestId = requestCheck.requestId;
  const actorId = String(req.adminUser?.sub || req.adminUser?.username || '').trim();
  if (!actorId) return res.status(403).json({ error: '無法確認核准操作人員', code: 'ACTOR_REQUIRED' });
  const fingerprint = payloadFingerprint({ group_order_id: String(req.params.id) });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // lock 順序：admin/request advisory → ledger → group order row → member/order rows。
    // 原有 group FOR UPDATE 仍保留，負責不同 admin / 不同 request 之間的狀態序列化。
    await acquireRequestLock(client, {
      actorId,
      operation: GROUP_APPROVAL_OPERATION,
      requestId,
    });
    const prior = await client.query(
      `SELECT payload_fingerprint, result_entity_id, status
         FROM request_idempotency_ledger
        WHERE actor_type = 'admin' AND actor_id = $1
          AND operation = $2 AND normalized_request_id = $3
        FOR UPDATE`,
      [actorId, GROUP_APPROVAL_OPERATION, requestId]
    );
    const o = await client.query(`SELECT * FROM group_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!o.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '找不到此團購' }); }
    const order = o.rows[0];
    if (!isVenueInScope(req, order.venue_id)) { await client.query('ROLLBACK'); return res.status(403).json({ error: '無權審核此場館的團購' }); }
    if (prior.rowCount) {
      const ledger = prior.rows[0];
      if (ledger.payload_fingerprint !== fingerprint) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '相同 request ID 已用於不同團購核准內容',
          code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        });
      }
      if (ledger.status !== 'completed' || ledger.result_entity_id !== String(order.id)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '此 request ID 正在處理或原結果不完整，請稍後重試',
          code: 'IDEMPOTENCY_IN_PROGRESS',
        });
      }
      const existing = await readApprovedGroupResult(client, order.id, { idempotent: true });
      if (!existing.count || !existing.checkout_ids.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '此 request ID 的原始團購訂單不存在，請聯繫管理員',
          code: 'IDEMPOTENCY_RESULT_MISSING',
        });
      }
      await client.query('COMMIT');
      return res.json(existing);
    }
    await client.query(
      `INSERT INTO request_idempotency_ledger
         (normalized_request_id, actor_type, actor_id, operation, payload_fingerprint, status)
       VALUES ($1,'admin',$2,$3,$4,'processing')`,
      [requestId, actorId, GROUP_APPROVAL_OPERATION, fingerprint]
    );
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

    // 家長端 my-proof 允許「轉帳末 5 碼」或「匯款證明」擇一送出（櫃檯憑末 5 碼即可查帳），
    // 核准守門必須採同一標準：兩者皆缺才擋，避免只填末 5 碼的家庭永遠無法成團。
    const missingProofs = ms.rows
      .filter((m) => !m.payment_proof_url && !String(m.transfer_last_5 || '').trim())
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
        error: '仍有家庭尚未提供付款資料（轉帳末 5 碼或匯款證明），請補齊後再核准成團',
        code: 'MISSING_PAYMENT_PROOF',
        missing_members: missingProofs,
      });
    }
    // member proof 可能來自舊資料，或在上傳後、核准前被 bucket 管理作業移除。
    // 在複製到 checkout/admin_enrollments 前逐筆重驗真實 object，不可把
    // 「格式正確但已不存在」的 key 擴散到新訂單。
    // 驗證失敗的處理與核准守門同標準：該家庭若已填末 5 碼（櫃檯可直接查帳）→ 丟棄
    // 失效的 proof 引用（複製到新訂單時以 NULL 取代，成員原始資料不動）繼續核准；
    // 連末 5 碼都沒有才整筆擋下。storage 暫時查不到（503 LOOKUP_FAILED）一律
    // rollback——那是暫時性故障，應重試而非誤判證明失效。
    const proofByMemberId = new Map();
    for (const member of ms.rows) {
      const proofInput = await parseProofInput({ payment_proof_url: member.payment_proof_url });
      if (proofInput.error) {
        const hasLast5 = !!String(member.transfer_last_5 || '').trim();
        if (proofInput.code === 'PAYMENT_PROOF_LOOKUP_FAILED' || !hasLast5) {
          await client.query('ROLLBACK');
          return res.status(proofInput.status).json({
            error: proofInput.error,
            code: proofInput.code,
            missing_members: [{
              member_id: member.id,
              parent_id: member.parent_id,
              parent_name: member.parent_name,
              parent_phone: member.parent_phone,
              student_names: member.student_names || [],
            }],
          });
        }
        console.warn('[admin/groupOrders approve] 成員匯款證明已失效，憑末 5 碼放行（proof 不複製到新訂單）:',
          order.id, member.parent_id, member.payment_proof_url);
        await logGroupOrderAudit(client, {
          groupOrderId: order.id,
          action: `核准時成員匯款證明已失效，憑末 5 碼放行（${member.parent_name}／${member.parent_phone}）`,
          by: req.adminUser?.name || req.adminUser?.username || 'unknown',
          reason: member.payment_proof_url,
        });
        proofByMemberId.set(member.id, null);
        continue;
      }
      proofByMemberId.set(member.id, proofInput.supplied ? proofInput.value : null);
    }

    for (const m of ms.rows) {
      const names = m.student_names || [];
      const count = names.length || 1;
      // 每個家庭有自己的 checkout / idempotency batch。部分舊 production schema
      // 仍保有 enrollment_batch_id 的全域 unique constraint；共用同一 batch 會令第二個
      // 家庭核准失敗。開課守門改以 group_order + 期數查所有 checkout，不再依賴共用 batch。
      const memberBatchId = randomUUID();
      // 訂單依期數拆分：每位成員的 N 期各自一筆（period_count=1，6 堂），各自付款/對帳。
      const perPeriodPrice = perStudent * count; // 單期（該成員所有學員）
      const checkout = await createCheckoutSession(client, {
        parentId: m.parent_id,
        enrollmentBatchId: memberBatchId,
        totalAmount: perPeriodPrice * periodCount,
        transferLast5: m.transfer_last_5 || null,
        paymentProofUrl: proofByMemberId.get(m.id) || null,
        by: req.adminUser?.username || 'system',
        requestFingerprint: fingerprint,
      });
      for (let j = 1; j <= periodCount; j += 1) {
        const eid = genEnrollmentId();
        await client.query(
          `INSERT INTO admin_enrollments
             (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
              original_price, final_price, transfer_last_5, payment_proof_url, status, submitted_at,
              group_order_id, is_group_shared, period_count, period_number, enrollment_batch_id, checkout_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_payment',NOW(),$13,TRUE,1,$14,$15,$16)`,
          [
            eid, m.parent_name, m.parent_phone, names, coachName, order.coach_id,
            order.venue_id, order.course_type, perPeriodPrice, perPeriodPrice, m.transfer_last_5 || null, proofByMemberId.get(m.id) || null,
            order.id, j, memberBatchId, checkout.checkoutId,
          ]
        );
        await client.query(
          `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
           VALUES ($1, $2, $3)`,
          [eid, '團購核准建立報名', req.adminUser?.username || 'system']
        );
      }
    }

    await client.query(
      `UPDATE group_orders SET status='approved', reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW()
        WHERE id=$1`,
      [order.id, req.adminUser?.username || 'system']
    );
    await logGroupOrderAudit(client, {
      groupOrderId: order.id,
      action: `核准成團（${ms.rows.length} 個家庭 × ${periodCount} 期，送待對帳清單）`,
      by: req.adminUser?.name || req.adminUser?.username || 'unknown',
    });
    await client.query(
      `UPDATE request_idempotency_ledger
          SET result_entity_id = $4, status = 'completed', completed_at = NOW()
        WHERE actor_type = 'admin' AND actor_id = $1
          AND operation = $2 AND normalized_request_id = $3`,
      [actorId, GROUP_APPROVAL_OPERATION, requestId, order.id]
    );
    const response = await readApprovedGroupResult(client, order.id);
    await client.query('COMMIT');
    res.json(response);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[admin/group-orders approve]', { code: err?.code || 'UNEXPECTED' });
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
    // 原子轉換：只在 submitted 時可退回，避免與並發 approve 互相覆蓋終態。
    // CTE 讓「狀態變更 + 操作紀錄」同一語句落地，不會退回成功卻漏記稽核。
    const r = await pool.query(
      `WITH upd AS (
         UPDATE group_orders SET status='rejected', reject_reason=$2, reviewed_by=$3, reviewed_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND status='submitted' RETURNING id
       )
       INSERT INTO group_order_audit_logs (group_order_id, action, by_user, reason)
       SELECT id, '退回團購', $4, $2 FROM upd
       RETURNING group_order_id`,
      [req.params.id, reason, req.adminUser?.username || 'system',
       req.adminUser?.name || req.adminUser?.username || 'unknown']
    );
    if (!r.rowCount) return res.status(409).json({ error: '只有「待審核」的團購可以退回', code: 'NOT_SUBMITTED' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/group-orders reject]', err);
    res.status(500).json({ error: '退回失敗' });
  }
});

// 純函式只供不連 DB 的 regression test 使用；路由對外行為不受影響。
router.__test__ = { genEnrollmentId };

module.exports = router;
