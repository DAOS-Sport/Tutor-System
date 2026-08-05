// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔全檔屬凍結範圍（整班簽到語意扣課；不得加回 SHARED_PERIOD_REQUIRES_CHECKIN 硬擋）。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
/**
 * 手動扣課（F-R02 extension；獨立於 F-M05 扣課復活）
 *
 * 正式堂數真相是 course_sessions + checkin_records，而不是只遞增一個計數器。
 * 本路由在同一 transaction 建立 completed session、簽到、append-only ledger 與
 * admin audit；course_periods/admin_enrollments 的 used_sessions 只同步作相容顯示。
 */
const express = require('express');
const { pool } = require('../../models/db');
const { validateRequestId, payloadFingerprint } = require('../../services/idempotency');
const { syncStoredUsage, listLinkedEnrollmentIds } = require('../../services/usageSync');
const { broadcastAdminEvent } = require('../../services/websocket');
const { notifyCheckinSafely } = require('../../services/checkinNotify');
const {
  requireAdminAuth,
  requireAdminRole,
  getScopedVenueIds,
  isVenueInScope,
} = require('../../middlewares/adminAuth');

const router = express.Router();
const STRICT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value, max = 1000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function requestId(value) {
  return validateRequestId(value).requestId || null;
}

function publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    request_id: row.request_id,
    course_period_id: row.course_period_id,
    admin_enrollment_id: row.admin_enrollment_id || null,
    course_session_id: row.course_session_id,
    student_id: row.student_id,
    student_name: row.student_name || null,
    venue_id: row.venue_id,
    quantity: Number(row.quantity) || 1,
    remaining_before: Number(row.remaining_before),
    remaining_after: Number(row.remaining_after),
    reason: row.reason,
    deducted_by: row.deducted_by,
    created_at: row.created_at,
    // 這堂扣課實際登記出席的整班名單快照 [{id,name}]（單人課期為一人）。
    roster_snapshot: Array.isArray(row.roster_snapshot) ? row.roster_snapshot : null,
  };
}

async function readDeduction(client, periodId, id) {
  const r = await client.query(
    `SELECT d.*, s.name AS student_name
       FROM manual_lesson_deductions d
       LEFT JOIN students s ON s.id = d.student_id
      WHERE d.course_period_id = $1 AND d.id = $2`,
    [periodId, id]
  );
  return publicRow(r.rows[0]);
}

/**
 * GET /api/admin/manual-deductions?search=<報名單號/家長/學員/電話>
 * 只回可扣的 active course_period，且場館裁判與所有其他 admin route 共用。
 */
router.get('/', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  try {
    const q = text(req.query.search || req.query.q, 120);
    if (q.length < 2) return res.json([]);

    const scope = getScopedVenueIds(req);
    const args = [`%${q.toLowerCase()}%`];
    const where = [
      `cp.status = 'active'`,
      `(
        LOWER(COALESCE(ae.id, '')) LIKE $1
        OR LOWER(COALESCE(ae.parent_name, '')) LIKE $1
        OR COALESCE(ae.parent_phone, '') LIKE $1
        OR EXISTS (
          SELECT 1
            FROM course_period_enrollments cpe_s
            JOIN students s_s ON s_s.id = cpe_s.student_id
           WHERE cpe_s.course_period_id = cp.id
             AND cpe_s.status = 'active'
             AND LOWER(s_s.name) LIKE $1
        )
      )`,
    ];
    if (scope) {
      args.push(scope);
      where.push(`cp.venue_id = ANY($${args.length}::text[])`);
    }

    const r = await pool.query(
      `SELECT cp.id AS course_period_id,
              cp.admin_enrollment_id,
              cp.venue_id,
              COALESCE(NULLIF(av.name, ''), v.name, cp.venue_id) AS venue_name,
              cp.course_type,
              cp.group_order_id,
              cp.total_sessions,
              cp.used_sessions AS stored_used_sessions,
              ae.parent_name,
              ae.parent_phone,
              ae.coach,
              ae.id AS enrollment_id,
              COALESCE(session_usage.attended_sessions, 0)::int AS used_sessions,
              COALESCE(session_usage.reserved_sessions, 0)::int AS reserved_sessions,
              GREATEST(cp.total_sessions - COALESCE(session_usage.reserved_sessions, 0), 0)::int AS remaining_sessions,
              COALESCE(members.students, '[]'::jsonb) AS students,
              COALESCE(member_count.active_student_count, 0)::int AS active_student_count
         FROM course_periods cp
    LEFT JOIN admin_enrollments ae ON ae.id = cp.admin_enrollment_id
    LEFT JOIN venues v ON v.id = cp.venue_id
    LEFT JOIN admin_venues av ON av.id = cp.venue_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT cs.id) FILTER (WHERE cs.status::text NOT LIKE 'cancelled%')::int AS reserved_sessions,
        COUNT(DISTINCT cs.id) FILTER (
           WHERE cs.status::text NOT LIKE 'cancelled%'
            AND cr.course_session_id IS NOT NULL
            AND cr.attendance_status = 'ATTENDED'
        )::int AS attended_sessions
        FROM course_sessions cs
   LEFT JOIN checkin_records cr ON cr.course_session_id = cs.id
       WHERE cs.course_period_id = cp.id
    ) session_usage ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name,
               'is_active', COALESCE(s.is_active, TRUE)) ORDER BY s.name) AS students
        FROM course_period_enrollments cpe
        JOIN students s ON s.id = cpe.student_id
       WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'
    ) members ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS active_student_count
        FROM course_period_enrollments cpe_count
       WHERE cpe_count.course_period_id = cp.id AND cpe_count.status = 'active'
    ) member_count ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY cp.created_at DESC
        LIMIT 50`,
      args
    );

    res.json(r.rows.map((row) => ({
      course_period_id: row.course_period_id,
      admin_enrollment_id: row.admin_enrollment_id || row.enrollment_id || null,
      venue_id: row.venue_id,
      venue_name: row.venue_name || row.venue_id,
      course_type: Number(row.course_type) || null,
      parent_name: row.parent_name || '',
      parent_phone: row.parent_phone || '',
      coach: row.coach || '',
      total_sessions: Number(row.total_sessions) || 0,
      used_sessions: Number(row.used_sessions) || 0,
      reserved_sessions: Number(row.reserved_sessions) || 0,
      remaining_sessions: Number(row.remaining_sessions) || 0,
      students: Array.isArray(row.students) ? row.students : [],
      // 共享課期（團購/家庭共班）不再是 blocker：POST 已改為整班簽到語意
      // （一筆 session＋整班出席＝整期共扣 1 堂）。旗標保留供前端顯示
      // 「整班扣課」說明與單顆整班按鈕。
      is_shared_period: !!row.group_order_id || Number(row.active_student_count) > 1,
      active_student_count: Number(row.active_student_count) || 0,
    })));
  } catch (err) {
    console.error('[admin/manual-deductions list]', err);
    res.status(500).json({ error: 'load manual deduction candidates failed' });
  }
});

/**
 * POST /api/admin/manual-deductions
 * { course_period_id, student_id, reason, request_id, occurred_at? }
 */
router.post('/', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  const body = req.body || {};
  const periodId = text(body.course_period_id, 64);
  const studentId = text(body.student_id, 64);
  const reason = text(body.reason, 1000);
  const requestCheck = validateRequestId(body.request_id || req.get('Idempotency-Key'));
  if (requestCheck.error) {
    return res.status(requestCheck.status).json({ error: requestCheck.error, code: requestCheck.code });
  }
  const idempotencyKey = requestCheck.requestId;
  const occurredAt = body.occurred_at ? new Date(body.occurred_at) : new Date();

  if (!STRICT_UUID_RE.test(periodId) || !STRICT_UUID_RE.test(studentId)) {
    return res.status(400).json({ error: '課期或學員識別碼格式不正確', code: 'INPUT_INVALID' });
  }
  if (!reason) return res.status(400).json({ error: '請填寫扣課原因', code: 'REASON_REQUIRED' });
  if (Number.isNaN(occurredAt.getTime())) {
    return res.status(400).json({ error: '扣課時間格式不正確', code: 'OCCURRED_AT_INVALID' });
  }
  const fingerprint = payloadFingerprint({
    course_period_id: periodId,
    student_id: studentId,
    reason,
    // 未指定時間代表「伺服器接收時間」，retry 時仍是同一語意，不能把每次產生的
    // now 放進 fingerprint；明確指定時則以 ISO canonical value 比對。
    occurred_at: body.occurred_at ? occurredAt.toISOString() : null,
  });

  const by = text(req.adminUser?.name || req.adminUser?.username || req.adminUser?.sub || 'unknown', 120);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 先以無鎖讀取教練，取得與 /api/slots/:id/book 完全相同的 advisory lock。
    // 不可先 FOR UPDATE course_period 再等 coach lock：選槽路徑已持有 coach lock
    // 並在 INSERT session 時取得 course_period 的 FK KEY SHARE，會形成死鎖。
    const periodHintResult = await client.query(
      `SELECT id, coach_id FROM course_periods WHERE id = $1`,
      [periodId]
    );
    const periodHint = periodHintResult.rows[0];
    if (!periodHint) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到課期', code: 'PERIOD_NOT_FOUND' });
    }
    if (!periodHint.coach_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此課期缺少教練資訊，暫時不可手動扣課', code: 'PERIOD_COACH_MISSING' });
    }
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [String(periodHint.coach_id)]
    );

    // 取得教練 lock 後才鎖 period；接下來的容量檢查 + 建 session 與選槽序列化。
    // FOR UPDATE OF cp：只鎖 period 列，LEFT JOIN 的名稱表不加鎖（僅供 WS 事件顯示）。
    const pr = await client.query(
      `SELECT cp.id, cp.venue_id, cp.coach_id, cp.total_sessions, cp.used_sessions,
              cp.admin_enrollment_id, cp.group_order_id, cp.enrollment_batch_id,
              cp.period_number, cp.status, cp.course_type,
              COALESCE(NULLIF(av.name, ''), v.name, cp.venue_id) AS venue_name,
              c.name AS coach_name
         FROM course_periods cp
    LEFT JOIN admin_venues av ON av.id = cp.venue_id
    LEFT JOIN venues v ON v.id = cp.venue_id
    LEFT JOIN coaches c ON c.id = cp.coach_id
        WHERE cp.id = $1
        FOR UPDATE OF cp`,
      [periodId]
    );
    const period = pr.rows[0];
    if (!period) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到課期', code: 'PERIOD_NOT_FOUND' });
    }
    if (String(period.coach_id || '') !== String(periodHint.coach_id)) {
      // 極少數「剛好改派教練」競態：不要以舊教練 lock 處理新教練課期；回覆可安全重試。
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '課期教練剛更新，請重新整理後再操作', code: 'PERIOD_COACH_CHANGED_RETRY' });
    }
    if (!isVenueInScope(req, period.venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此課期不在您的場館範圍內', code: 'VENUE_OUT_OF_SCOPE' });
    }
    if (period.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '此課期目前不可扣課', code: 'PERIOD_NOT_ACTIVE' });
    }

    // 同一 period/request 已由上方 coach advisory lock + period row lock 序列化。
    // 必須先於 shared/capacity 等會隨時間改變的 guard 回舊結果，否則成功 retry
    // 可能因後續狀態變動而被誤判；場館 scope 與 period identity 仍先驗證。
    const prior = await client.query(
      `SELECT id, payload_fingerprint
         FROM manual_lesson_deductions
        WHERE course_period_id = $1 AND request_id = $2
        FOR UPDATE`,
      [periodId, idempotencyKey]
    );
    if (prior.rowCount) {
      const storedFingerprint = prior.rows[0].payload_fingerprint;
      if (!storedFingerprint || storedFingerprint !== fingerprint) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: storedFingerprint
            ? '相同 request ID 已用於不同扣課內容'
            : '此舊扣課紀錄缺少 payload fingerprint，無法安全重送',
          code: storedFingerprint
            ? 'IDEMPOTENCY_PAYLOAD_MISMATCH'
            : 'IDEMPOTENCY_LEGACY_UNVERIFIABLE',
        });
      }
      const deduction = await readDeduction(client, periodId, prior.rows[0].id);
      await client.query('COMMIT');
      return res.json({ ok: true, idempotent: true, deduction });
    }

    // 整班簽到語意：共享課期（團報/家庭共班）以「同一個 session 對所有成員」計堂，
    // 手動扣課建立的 completed session 為整班 active 名單各寫一筆出席紀錄——
    // 整期共扣 1 堂、每位成員都拿到該堂出席，與家長/教練/自助簽到四路資料契約一致，
    // 因此不再擋共享課期（原 SHARED_PERIOD_REQUIRES_CHECKIN 409 已移除）。
    const rosterRes = await client.query(
      `SELECT s.id, s.name, COALESCE(s.is_active, TRUE) AS is_active
         FROM course_period_enrollments cpe
         JOIN students s ON s.id = cpe.student_id
        WHERE cpe.course_period_id = $1 AND cpe.status = 'active'
        ORDER BY s.name
        FOR SHARE OF cpe`,
      [periodId]
    );
    const anchor = rosterRes.rows.find((r) => String(r.id) === String(studentId));
    if (!anchor) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此學員不屬於可扣課的課期', code: 'STUDENT_NOT_IN_PERIOD' });
    }
    // 出席名單：停用學員不列入，但櫃檯點名的 anchor 學員一律登記（單人課期停用
    // 學員的補登仍要留下出席紀錄，否則扣課會變成無出席的幽靈 session）。
    const attendanceRoster = rosterRes.rows.filter((r) => r.is_active || String(r.id) === String(studentId));

    const usage = await client.query(
      `SELECT
         COUNT(DISTINCT cs.id) FILTER (WHERE cs.status::text NOT LIKE 'cancelled%')::int AS reserved_sessions
         FROM course_sessions cs
        WHERE cs.course_period_id = $1`,
      [periodId]
    );
    const reserved = Number(usage.rows[0]?.reserved_sessions) || 0;
    const total = Number(period.total_sessions) || 0;
    // 可再排／可再補登的堂數以「所有未取消 session」計算，不能只看已簽到數；
    // 已排而尚未簽到的 session 已保留一堂，否則後續簽到會使課期超額。
    const remainingBefore = Math.max(0, total - reserved);
    if (remainingBefore < 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '剩餘堂數不足，無法扣課', code: 'INSUFFICIENT_SESSIONS' });
    }

    const session = await client.query(
      `INSERT INTO course_sessions
         (course_period_id, coach_id, scheduled_at, duration_minutes, status, completed_at, session_deducted)
       VALUES ($1, $2, $3, 60, 'completed', NOW(), TRUE)
       RETURNING id`,
      [periodId, period.coach_id || null, occurredAt.toISOString()]
    );
    const courseSessionId = session.rows[0].id;
    // 整班出席：與 F-R03 簽到（checkins.js / sessions.js 的 roster 寫入）同一資料契約——
    // 一筆 session＋整班 checkin_records＝整期共扣 1 堂。新建 session 不可能撞鍵，
    // ON CONFLICT 僅作防禦。
    for (const member of attendanceRoster) {
      const ins = await client.query(
        `INSERT INTO checkin_records
           (course_session_id, student_id, checked_in_by_student_id,
            is_auto_linked, checked_in_source, checked_in_at)
         VALUES ($1, $2, $2, FALSE, 'staff', $3)
         ON CONFLICT (course_session_id, student_id) DO NOTHING
         RETURNING id`,
        [courseSessionId, member.id, occurredAt.toISOString()]
      );
      // WS 事件用；ON CONFLICT 無回列時以合成 key 保底，避免前端以 undefined 去重互吞。
      member.checkin_id = ins.rows[0]?.id || `${courseSessionId}:${member.id}`;
    }

    const remainingAfter = remainingBefore - 1;
    const rosterSnapshot = attendanceRoster.map((m) => ({ id: m.id, name: m.name }));
    const ledger = await client.query(
      `INSERT INTO manual_lesson_deductions
         (request_id, payload_fingerprint, course_period_id, admin_enrollment_id, course_session_id, student_id,
          venue_id, quantity, remaining_before, remaining_after, reason, deducted_by, roster_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12::jsonb)
       RETURNING id`,
      [
        idempotencyKey, fingerprint, periodId, period.admin_enrollment_id || null, courseSessionId, studentId,
        period.venue_id, remainingBefore, remainingAfter, reason, by, JSON.stringify(rosterSnapshot),
      ]
    );

    // 鏡射欄位以權威簽到數重算，並同步「共享此 period 的全部訂單」（anchor／團報／
    // 多期批次），與 checkins.js / sessions.js 的 syncStoredUsage 同一條路。
    const usedAfterRes = await client.query(
      `SELECT COUNT(DISTINCT cs.id)::int AS n
         FROM course_sessions cs
         JOIN checkin_records cr ON cr.course_session_id = cs.id
        WHERE cs.course_period_id = $1
          AND cs.status::text NOT LIKE 'cancelled%'
          AND cr.attendance_status = 'ATTENDED'`,
      [periodId]
    );
    const usedAfter = Math.min(total, Number(usedAfterRes.rows[0]?.n || 0));
    await syncStoredUsage(client, period, usedAfter);

    // 稽核：對共享此 period 的所有訂單各寫一筆（單人課期即 anchor 一筆）。
    const isSharedPeriod = !!period.group_order_id || rosterRes.rows.length > 1;
    const auditAction = isSharedPeriod
      ? `手動扣課 1 堂（整班出席 ${attendanceRoster.length} 名：${attendanceRoster.map((m) => m.name).join('、')}；剩餘 ${remainingAfter} 堂）`
      : `手動扣課 1 堂（學員：${anchor.name}；剩餘 ${remainingAfter} 堂）`;
    const linkedEnrollmentIds = await listLinkedEnrollmentIds(client, period);
    for (const enrollmentId of linkedEnrollmentIds) {
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason)
         VALUES ($1,$2,$3,$4)`,
        [enrollmentId, auditAction, by, reason]
      );
    }

    const deduction = await readDeduction(client, periodId, ledger.rows[0].id);
    await client.query('COMMIT');

    // 與家長/教練簽到相同的後台即時事件（簽到驗證頁自動更新）；payload 形狀對齊
    // checkins.js 的廣播（含 checkin_id，缺了會被 CheckinPage 去重誤吞）。失敗不影響已扣課結果。
    for (const member of attendanceRoster) {
      // 簽到通知（教練／家長）。fire-and-forget：簽到已 COMMIT，推播不該把它拖下水。
      notifyCheckinSafely(courseSessionId, null);

      try {
        broadcastAdminEvent('checkin:created', {
          checkin_id: member.checkin_id,
          at: occurredAt.toISOString(),
          session_id: courseSessionId,
          period_id: periodId,
          venue_id: period.venue_id,
          venue_name: period.venue_name || period.venue_id,
          course_type: Number(period.course_type) || null,
          coach: period.coach_name || '',
          student: member.name || '',
          source: 'staff',
          checked_in_by: '櫃檯',
        });
      } catch (e) { console.warn('[admin/manual-deductions] broadcast skipped:', e?.message); }
    }

    res.status(201).json({ ok: true, idempotent: false, deduction, attendance_count: attendanceRoster.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A unique conflict can only occur if another client created the same request
    // between lock acquisition and insert (for example a legacy worker); surface a
    // retry-safe conflict instead of pretending a second deduction succeeded.
    if (err?.code === '23505') {
      try {
        const existing = await pool.query(
          `SELECT d.*, s.name AS student_name
             FROM manual_lesson_deductions d
             LEFT JOIN students s ON s.id = d.student_id
            WHERE d.course_period_id = $1 AND d.request_id = $2`,
          [periodId, idempotencyKey]
        );
        if (existing.rowCount) {
          if (existing.rows[0].payload_fingerprint === fingerprint) {
            return res.json({ ok: true, idempotent: true, deduction: publicRow(existing.rows[0]) });
          }
          return res.status(409).json({
            error: '相同 request ID 已用於不同扣課內容',
            code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
          });
        }
      } catch { /* fall through to the explicit conflict */ }
      return res.status(409).json({ error: '重複扣課請求，請重新整理後確認堂數', code: 'IDEMPOTENCY_CONFLICT' });
    }
    console.error('[admin/manual-deductions create]', { code: err?.code || 'UNEXPECTED' });
    res.status(500).json({ error: '手動扣課失敗，尚未扣除堂數', code: 'MANUAL_DEDUCTION_FAILED' });
  } finally {
    client.release();
  }
});

router._internals = {
  requestId,
  publicRow,
  STRICT_UUID_RE,
};

module.exports = router;
