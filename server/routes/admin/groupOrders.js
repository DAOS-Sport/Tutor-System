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
const { parseProofInput } = require('../../services/paymentProof');
const { logGroupOrderAudit } = require('../../services/groupOrderAudit');
const line = require('../../services/line');
const promotions = require('../../services/promotions');
const {
  validateRequestId,
  payloadFingerprint,
  acquireRequestLock,
} = require('../../services/idempotency');

const router = express.Router();
const AMS = requireAdminRole('admin', 'manager', 'staff');
const GROUP_APPROVAL_OPERATION = 'approve_group_order_checkouts';

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
        carrier: m.carrier || null,
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

    // U14：有促銷的團，金額在「加入當下」就落地到 member 列（家長照那個金額轉帳），
    // 這裡一律沿用落地值，不重算 —— 重算會與家長已匯出的金額不一致。
    // 既有團（含本次改版前建立的）final_amount 為 NULL → 走原本的 perStudent × 人數 × 期數。
    const memberAmount = (m, count) => {
      const fallback = perStudent * count * periodCount;
      if (m.final_amount == null) return { original: fallback, final: fallback, discount: 0 };
      return {
        original: Number(m.original_amount) || fallback,
        final: Number(m.final_amount),
        discount: Number(m.discount_amount) || 0,
      };
    };

    for (const m of ms.rows) {
      const names = m.student_names || [];
      const count = names.length || 1;
      // 每個家庭有自己的 checkout / idempotency batch。部分舊 production schema
      // 仍保有 enrollment_batch_id 的全域 unique constraint；共用同一 batch 會令第二個
      // 家庭核准失敗。開課守門改以 group_order + 期數查所有 checkout，不再依賴共用 batch。
      const memberBatchId = randomUUID();
      // 訂單依期數拆分：每位成員的 N 期各自一筆（period_count=1，6 堂），各自付款/對帳。
      // U14：單期金額由「該家落地總額 ÷ 期數」推回，確保 N 期加總 = 家長實際轉帳金額
      // （最後一期補足餘數，避免整數除法造成尾差）。
      const amt = memberAmount(m, count);
      const perPeriodOriginal = Math.round((amt.original || 0) / periodCount);
      const perPeriodPrice = Math.round(amt.final / periodCount); // 單期（該成員所有學員）
      const checkout = await createCheckoutSession(client, {
        parentId: m.parent_id,
        enrollmentBatchId: memberBatchId,
        totalAmount: amt.final,
        transferLast5: m.transfer_last_5 || null,
        paymentProofUrl: proofByMemberId.get(m.id) || null,
        carrier: m.carrier || null,
        by: req.adminUser?.username || 'system',
        requestFingerprint: fingerprint,
      });
      let firstEid = null;
      let allocatedOriginal = 0;
      let allocatedFinal = 0;
      for (let j = 1; j <= periodCount; j += 1) {
        const eid = genEnrollmentId();
        if (!firstEid) firstEid = eid;
        // 最後一期補足餘數，讓 N 期加總嚴格等於該家落地金額（整數除法尾差不落在客人身上）。
        const isLast = j === periodCount;
        const rowOriginal = isLast ? (amt.original - allocatedOriginal) : perPeriodOriginal;
        const rowFinal = isLast ? (amt.final - allocatedFinal) : perPeriodPrice;
        allocatedOriginal += rowOriginal;
        allocatedFinal += rowFinal;
        await client.query(
          `INSERT INTO admin_enrollments
             (id, parent_name, parent_phone, students, coach, coach_id, venue_id, course_type,
              original_price, final_price, transfer_last_5, payment_proof_url, status, submitted_at,
              group_order_id, is_group_shared, period_count, period_number, enrollment_batch_id, checkout_id, carrier)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_payment',NOW(),$13,TRUE,1,$14,$15,$16,$17)`,
          [
            eid, m.parent_name, m.parent_phone, names, coachName, order.coach_id,
            order.venue_id, order.course_type, rowOriginal, rowFinal, m.transfer_last_5 || null, proofByMemberId.get(m.id) || null,
            order.id, j, memberBatchId, checkout.checkoutId, m.carrier || null,
          ]
        );
        await client.query(
          `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
           VALUES ($1, $2, $3)`,
          [eid, amt.discount > 0 ? `團購核准建立報名（已折 ${amt.discount} 元）` : '團購核准建立報名',
           req.adminUser?.username || 'system']
        );
      }
      // U14：把該家的 usage 綁到第一筆 enrollment 上。
      // 這一步讓「團購核准後的退費」自動走既有的 revertUsage({ adminEnrollmentId }) 回沖路徑，
      // 不需要在退費流程另外寫團購分支。
      if (amt.discount > 0 && firstEid) {
        await client.query(
          `UPDATE promotion_usages
              SET admin_enrollment_id = $2
            WHERE group_order_member_id = $1 AND admin_enrollment_id IS NULL`,
          [m.id, firstEid]
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

// ── POST /:id/return-for-fix 退回補件（U14）──────────────────
// 與 /reject 的差別：
//   reject          → rejected（終態，家長無法續作）— 行為完全不變，既有資料不受影響
//   return-for-fix  → forming （可續作）— 家長回到揪團中狀態補齊付款資料後重新送審
// 之所以要「退回到 forming」而不是留在 submitted：group_orders 的 my-proof 雖然
// forming/submitted 都允許上傳，但退回 forming 才能讓團主重新走一次送審守門，
// 也讓「名單鎖定」解除（退回原因可能就是要換人）。
//
// reset_member_ids：清空指定成員的付款欄位。這是必要的——家長端 my-proof 對
// 「已送出的末 5 碼」是硬鎖的（TRANSFER_LAST5_LOCKED，且 clear 旁路擋不掉），
// 若退回原因正是末 5 碼填錯，不由櫃檯清空的話家長永遠改不了。
// 已 payment_confirmed 的成員一律不清（櫃檯已查核過的帳款不可被抹掉）。
router.post('/:id/return-for-fix', requireAdminAuth, AMS, async (req, res) => {
  const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.trim() : '';
  if (!reason) return res.status(400).json({ error: '請填寫退回原因', code: 'REASON_REQUIRED' });
  const resetIds = Array.isArray(req.body?.reset_member_ids)
    ? [...new Set(req.body.reset_member_ids.map((x) => String(x || '').trim()).filter(Boolean))]
    : [];

  const client = await pool.connect();
  let notify = null;
  try {
    await client.query('BEGIN');
    const o = await client.query(`SELECT * FROM group_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!o.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '找不到此團購' }); }
    const order = o.rows[0];
    if (!isVenueInScope(req, order.venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '無權審核此場館的團購' });
    }
    if (order.status !== 'submitted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '只有「待審核」的團購可以退回補件', code: 'NOT_SUBMITTED' });
    }

    let resetCount = 0;
    if (resetIds.length) {
      const cleared = await client.query(
        `UPDATE group_order_members
            SET payment_proof_url = NULL,
                transfer_last_5   = NULL,
                proof_uploaded_at = NULL
          WHERE group_order_id = $1
            AND id = ANY($2::uuid[])
            AND COALESCE(payment_confirmed, FALSE) = FALSE
          RETURNING id`,
        [order.id, resetIds]
      );
      resetCount = cleared.rowCount;
    }
    // 注意：這裡「不」回沖優惠名額。退回補件的語意是「付款資料重填」，不是「退出團購」，
    // 該家仍在名單內、金額（含已鎖定的折扣）不變，補齊後重新送審即可。
    // 回沖名額會造成 final_amount 仍是折扣價、名額卻已歸還的不一致。
    // 真正該回沖的是「整團取消」（家長端 cancel）與退費，那兩條路徑已各自處理。

    await client.query(
      `UPDATE group_orders
          SET status='forming', reject_reason=$2, reviewed_by=$3, reviewed_at=NOW(),
              submitted_at=NULL, return_count=COALESCE(return_count,0)+1, updated_at=NOW()
        WHERE id=$1`,
      [order.id, reason, req.adminUser?.username || 'system']
    );
    await logGroupOrderAudit(client, {
      groupOrderId: order.id,
      action: `退回補件（回到揪團中${resetCount ? `，清空 ${resetCount} 筆付款資料供重填` : ''}）`,
      by: req.adminUser?.name || req.adminUser?.username || 'unknown',
      reason,
    });

    const members = await client.query(
      `SELECT p.line_uid FROM group_order_members m
         JOIN parents p ON p.id = m.parent_id
        WHERE m.group_order_id = $1 AND p.line_uid IS NOT NULL`,
      [order.id]
    );
    notify = { uids: members.rows.map((x) => x.line_uid), venueId: order.venue_id, orderId: order.id, resetCount };

    await client.query('COMMIT');
    res.json({ ok: true, status: 'forming', reset_members: resetCount });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[admin/group-orders return-for-fix]', { code: err?.code || 'UNEXPECTED' });
    return res.status(500).json({ error: '退回補件失敗' });
  } finally {
    client.release();
  }

  // best-effort 通知全體成員（交易外，失敗只記 log，不影響已落地的退回結果）
  if (notify && notify.uids.length) {
    const liffUrl = `${process.env.LIFF_URL_PARENT || process.env.LIFF_URL || 'https://liff.line.me/-'}/group/${notify.orderId}`;
    const msg = line.templates.returnedForFix({
      title: '您的團購已退回補件',
      reason,
      hint: notify.resetCount ? '部分家庭的付款資料已清空，請重新填寫轉帳末 5 碼並上傳證明。' : null,
      liffUrl,
    });
    for (const uid of notify.uids) {
      line.pushMessage(uid, msg, notify.venueId)
        .catch((e) => console.warn('[group return-for-fix push]', e.message));
    }
  }
});

// 純函式只供不連 DB 的 regression test 使用；路由對外行為不受影響。
router.__test__ = { genEnrollmentId };

module.exports = router;
