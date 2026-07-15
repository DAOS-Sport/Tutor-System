/**
 * 場館營運：今日課程 / 簽到驗證 / 退課時段復活 (F-R01 / F-R03 / F-M05)
 *  GET   /api/admin/sessions/today           ?venueId=
 *  GET   /api/admin/sessions/verify-checkin  ?phone= &periodId=
 *  GET   /api/admin/sessions/cancelled
 *  POST  /api/admin/sessions/:id/revive      （主管權限）
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole, getScopedVenueIds, isVenueInScope } = require('../../middlewares/adminAuth');

const router = express.Router();

// 真實課堂的統一 SELECT（range / today 共用）：欄位對齊 rowToSession 既有 shape。
// 時間一律以台灣時區呈現；簽到狀態以 checkin_records 為真相（任一學員簽到＝該堂已簽）。
const REAL_SESSIONS_SELECT = `
  SELECT cs.id::text AS id,
         ((cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date)::text AS date,
         to_char(cs.scheduled_at AT TIME ZONE 'Asia/Taipei', 'HH24:MI') AS start_time,
         to_char((cs.scheduled_at AT TIME ZONE 'Asia/Taipei')
                 + make_interval(mins => COALESCE(cs.duration_minutes, 60)), 'HH24:MI') AS end_time,
         cp.venue_id,
         COALESCE(c.name, '') AS coach,
         COALESCE((SELECT json_agg(s.name ORDER BY s.name)
                     FROM course_period_enrollments cpe
                     JOIN students s ON s.id = cpe.student_id
                    WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'), '[]'::json) AS students,
         cp.course_type,
         CASE WHEN EXISTS (SELECT 1 FROM checkin_records cr WHERE cr.course_session_id = cs.id)
              THEN 'checked_in' ELSE 'not_yet' END AS checkin_status,
         (SELECT MIN(cr.checked_in_at) FROM checkin_records cr WHERE cr.course_session_id = cs.id) AS checkin_at,
         NULL::timestamptz AS backfilled_at
    FROM course_sessions cs
    JOIN course_periods cp ON cp.id = cs.course_period_id
    LEFT JOIN coaches c ON c.id = COALESCE(cs.coach_id, cp.coach_id)`;

function rowToSession(r) {
  return {
    id: r.id,
    date: typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().slice(0, 10),
    start: r.start_time,
    end: r.end_time,
    venue_id: r.venue_id,
    coach: r.coach,
    students: r.students || [],
    course_type: r.course_type,
    checkin_status: r.checkin_status,
    checkin_at: r.checkin_at || null,
    backfilled_at: r.backfilled_at || null,
  };
}

function rowToCancelled(r) {
  return {
    id: r.id,
    date: typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().slice(0, 10),
    start: r.start_time,
    period_id: r.period_id,
    parent_name: r.parent_name,
    coach: r.coach,
    venue_id: r.venue_id,
    refunded: !!r.refunded,
  };
}

/**
 * Task #55：日期範圍 + 多場館篩選版本
 *  GET /api/admin/sessions?from=YYYY-MM-DD&to=YYYY-MM-DD&venueIds=B,C
 *  - 範圍最大 31 天；前端週課表視角用，條列也可呼叫
 *  - staff 角色強制 venue_id = 自己場館（忽略 client 傳入的 venueIds）
 */
router.get('/', requireAdminAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'from / to (YYYY-MM-DD) required' });
    }
    const fromD = new Date(from + 'T00:00:00Z');
    const toD = new Date(to + 'T00:00:00Z');
    if (isNaN(fromD) || isNaN(toD) || toD < fromD) {
      return res.status(400).json({ error: 'invalid date range' });
    }
    // Task #55：上限改為較寬鬆的 92 天（防呆，避免一次拉一年）；前端負責週課表
    // 在 > 31 天時禁用 grid，後端不再硬擋條列模式的合理跨月查詢。
    const days = Math.round((toD - fromD) / 86400000) + 1;
    if (days > 92) return res.status(400).json({ error: 'range max 92 days' });

    // Task #90：staff / manager 鎖在自己所屬全部場館；admin 可帶 venueIds 自由查
    let venueIds;
    const scope = getScopedVenueIds(req);
    if (scope) {
      venueIds = scope;
      if (req.query.venueIds) {
        // staff / manager 皆可在自己場館範圍內再縮小（交集後才套用，越權的 venueId 會被濾掉）。
        // 多場館櫃檯若不指定 venueIds，則預設看見所屬全部場館。
        const want = String(req.query.venueIds).split(',').map((s) => s.trim()).filter(Boolean);
        const allowed = new Set(scope);
        const filtered = want.filter((v) => allowed.has(v));
        if (filtered.length) venueIds = filtered;
      }
    } else if (req.query.venueIds) {
      const raw = String(req.query.venueIds);
      venueIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }

    // U13 修正：主資料源改讀「真實課堂」course_sessions（預約排課＋自助簽到都在這）
    // ——舊版只讀示範表 admin_today_sessions，該表沒有任何真實流程回寫，導致上課
    // 記錄查詢永遠查不到實際上課資料。UNION 保留舊表列（向後相容既有補登/示範資料），
    // 場館範圍過濾對兩邊一體適用；回傳 shape 與原本完全相同（前端零改動）。
    const args = [from, to];
    let sql = `SELECT * FROM (
      ${REAL_SESSIONS_SELECT}
       WHERE (cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date BETWEEN $1::date AND $2::date
         AND cs.status::text NOT LIKE 'cancelled%'
      UNION ALL
      SELECT ats.id::text AS id, ats.date::text AS date, ats.start_time, ats.end_time, ats.venue_id, ats.coach,
             to_json(ats.students) AS students, ats.course_type, ats.checkin_status::text AS checkin_status,
             ats.checkin_at, ats.backfilled_at
        FROM admin_today_sessions ats
       WHERE ats.date >= $1::date AND ats.date <= $2::date
    ) t WHERE TRUE`;
    if (venueIds && venueIds.length) {
      args.push(venueIds);
      sql += ` AND t.venue_id = ANY($${args.length}::text[])`;
    }
    sql += ` ORDER BY t.date, t.start_time`;
    const r = await pool.query(sql, args);
    res.json(r.rows.map(rowToSession));
  } catch (err) {
    console.error('[admin/sessions]', err);
    res.status(500).json({ error: 'load sessions failed' });
  }
});

router.get('/today', requireAdminAuth, async (req, res) => {
  try {
    // Task #90：staff/manager 鎖在自己所屬場館集合；admin 可選 venueId 縮小
    // U13 修正：主資料源改讀真實課堂＋UNION 舊表（見 range 端點說明）。
    const scope = getScopedVenueIds(req);
    let sql = `SELECT * FROM (
      ${REAL_SESSIONS_SELECT}
       WHERE (cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date
         AND cs.status::text NOT LIKE 'cancelled%'
      UNION ALL
      SELECT ats.id::text AS id, ats.date::text AS date, ats.start_time, ats.end_time, ats.venue_id, ats.coach,
             to_json(ats.students) AS students, ats.course_type, ats.checkin_status::text AS checkin_status,
             ats.checkin_at, ats.backfilled_at
        FROM admin_today_sessions ats
       WHERE ats.date = (NOW() AT TIME ZONE 'Asia/Taipei')::date
    ) t WHERE TRUE`;
    const args = [];
    if (scope) {
      args.push(scope);
      sql += ` AND t.venue_id = ANY($${args.length}::text[])`;
    } else if (req.query.venueId) {
      args.push(req.query.venueId);
      sql += ` AND t.venue_id = $${args.length}`;
    }
    sql += ` ORDER BY t.start_time`;
    const r = await pool.query(sql, args);
    res.json(r.rows.map(rowToSession));
  } catch (err) {
    console.error('[admin/sessions/today]', err);
    res.status(500).json({ error: 'load today sessions failed' });
  }
});

router.get('/verify-checkin', requireAdminAuth, async (req, res) => {
  try {
    const { phone, periodId } = req.query;
    if (!phone && !periodId) return res.json({ found: false });

    const where = [];
    const args = [];
    if (periodId) { args.push(periodId); where.push(`id = $${args.length}`); }
    if (phone) { args.push(phone); where.push(`parent_phone = $${args.length}`); }
    // Task #90：staff 限定自己所屬全部場館；查到別館回 found:false
    const scope = getScopedVenueIds(req);
    if (scope) {
      args.push(scope);
      where.push(`venue_id = ANY($${args.length}::text[])`);
    }
    const r = await pool.query(
      `SELECT * FROM admin_enrollments WHERE ${where.join(' AND ')} ORDER BY submitted_at DESC LIMIT 1`,
      args
    );
    if (!r.rowCount) return res.json({ found: false });
    const e = r.rows[0];

    const enrollment = {
      id: e.id,
      parent_name: e.parent_name,
      parent_phone: e.parent_phone,
      students: e.students || [],
      coach: e.coach,
      venue_id: e.venue_id,
      course_type: e.course_type,
      original_price: Number(e.original_price),
      final_price: Number(e.final_price),
      transfer_last_5: e.transfer_last_5,
      status: e.status,
      submitted_at: typeof e.submitted_at === 'string' ? e.submitted_at : new Date(e.submitted_at).toISOString().slice(0, 19),
      total_sessions: e.total_sessions,
      used_sessions: e.used_sessions,
    };

    // U13 修正：「下一堂」提示改讀真實課堂——解析此報名對應的課程期
    // （團報 → 家庭共班批次 → 單筆 anchor 三層，與 courses.js 一致），
    // 取今天尚未取消的課堂。自助簽到模式無預排課堂時為 null（前端不顯示該區塊）。
    const pRes = await pool.query(
      `SELECT COALESCE(
         (SELECT cp.id FROM course_periods cp
            WHERE $2::uuid IS NOT NULL AND cp.group_order_id = $2::uuid
            ORDER BY cp.created_at LIMIT 1),
         (SELECT cp.id FROM course_periods cp
            WHERE $3::uuid IS NOT NULL AND cp.enrollment_batch_id = $3::uuid
              AND cp.period_number = COALESCE($4::int, 1)
            LIMIT 1),
         (SELECT cp.id FROM course_periods cp
            WHERE cp.admin_enrollment_id = $1
            ORDER BY cp.created_at LIMIT 1)) AS period_id`,
      [e.id, e.group_order_id || null, e.enrollment_batch_id || null, e.period_number || 1]
    );
    const resolvedPeriodId = pRes.rows[0]?.period_id || null;
    let session = null;
    if (resolvedPeriodId) {
      const s = await pool.query(
        `${REAL_SESSIONS_SELECT}
          WHERE cp.id = $1
            AND (cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date
            AND cs.status::text NOT LIKE 'cancelled%'
          ORDER BY cs.scheduled_at LIMIT 1`,
        [resolvedPeriodId]
      );
      if (s.rowCount) session = rowToSession(s.rows[0]);
    }
    res.json({
      found: true,
      enrollment,
      session,
    });
  } catch (err) {
    console.error('[admin/sessions/verify-checkin]', err);
    res.status(500).json({ error: 'verify checkin failed' });
  }
});

// 櫃台（staff）可唯讀檢視（getScopedVenueIds 會自動鎖其場館）；實際「歸還」仍僅 admin/manager
// U13 修正：主資料源改讀「真實已扣堂取消」課堂（course_sessions.status='cancelled_penalty'，
// 即逾時取消堂數已扣者），UNION 舊示範表 admin_cancelled_sessions 向後相容——舊版只讀
// 示範表，真實取消永遠不會出現（正式環境只看得到當年測試殘留）。
router.get('/cancelled', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  try {
    const scope = getScopedVenueIds(req);
    const args = [];
    let sql = `SELECT * FROM (
      SELECT cs.id::text AS id,
             ((cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date)::text AS date,
             to_char(cs.scheduled_at AT TIME ZONE 'Asia/Taipei', 'HH24:MI') AS start_time,
             COALESCE(cp.admin_enrollment_id, '') AS period_id,
             COALESCE(ae.parent_name, '') AS parent_name,
             COALESCE(c.name, '') AS coach,
             cp.venue_id,
             FALSE AS refunded
        FROM course_sessions cs
        JOIN course_periods cp ON cp.id = cs.course_period_id
        LEFT JOIN admin_enrollments ae ON ae.id = cp.admin_enrollment_id
        LEFT JOIN coaches c ON c.id = COALESCE(cs.coach_id, cp.coach_id)
       WHERE cs.status = 'cancelled_penalty'
      UNION ALL
      SELECT id::text AS id, date::text AS date, start_time, period_id, parent_name, coach, venue_id, refunded
        FROM admin_cancelled_sessions
    ) t WHERE TRUE`;
    if (scope) {
      args.push(scope);
      sql += ` AND t.venue_id = ANY($1::text[])`;
    }
    sql += ` ORDER BY t.date DESC, t.start_time`;
    const r = await pool.query(sql, args);
    res.json(r.rows.map(rowToCancelled));
  } catch (err) {
    console.error('[admin/sessions/cancelled]', err);
    res.status(500).json({ error: 'load cancelled failed' });
  }
});

router.post('/:id/revive', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;

    // U13：真實已扣堂取消（cancelled_penalty）的復活——轉為 cancelled_normal（＝堂數歸還、
    // 不再列於扣課復活清單），audit 掛 anchor 報名單；找不到真實課堂時退回舊示範表路徑。
    const real = await client.query(
      `SELECT cs.id, cs.status::text AS status, cp.venue_id, cp.admin_enrollment_id
         FROM course_sessions cs
         JOIN course_periods cp ON cp.id = cs.course_period_id
        WHERE cs.id::text = $1
        FOR UPDATE OF cs`,
      [id]
    );
    if (real.rowCount) {
      const row = real.rows[0];
      if (!isVenueInScope(req, row.venue_id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: '此時段不在您的場館範圍內' });
      }
      if (row.status !== 'cancelled_penalty') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '僅「已扣堂」的取消課堂可復活', code: 'NOT_PENALTY_CANCELLED' });
      }
      await client.query(
        `UPDATE course_sessions SET status = 'cancelled_normal', updated_at = NOW() WHERE id = $1`,
        [id]
      );
      if (row.admin_enrollment_id) {
        const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
        await client.query(
          `UPDATE admin_enrollments
              SET used_sessions = GREATEST(COALESCE(used_sessions, 0) - 1, 0), updated_at = NOW()
            WHERE id = $1 AND used_sessions IS NOT NULL AND used_sessions > 0`,
          [row.admin_enrollment_id]
        );
        await client.query(
          `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
           SELECT id, $2, $3 FROM admin_enrollments WHERE id = $1`,
          [row.admin_enrollment_id, `扣課復活（課堂 ${id}，已歸還 1 堂）`, by]
        );
      }
      await client.query('COMMIT');
      return res.json({ id, refunded: true });
    }

    const cur = await client.query(`SELECT * FROM admin_cancelled_sessions WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'cancelled session not found' });
    }
    if (!isVenueInScope(req, cur.rows[0].venue_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: '此時段不在您的場館範圍內' });
    }
    await client.query(`UPDATE admin_cancelled_sessions SET refunded = TRUE WHERE id = $1`, [id]);

    // 將堂數歸還給對應的 enrollment（used_sessions - 1，下限 0）
    const periodId = cur.rows[0].period_id;
    if (periodId) {
      await client.query(
        `UPDATE admin_enrollments
            SET used_sessions = GREATEST(COALESCE(used_sessions, 0) - 1, 0),
                updated_at = NOW()
          WHERE id = $1 AND used_sessions IS NOT NULL AND used_sessions > 0`,
        [periodId]
      );
      const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
      await client.query(
        `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
         VALUES ($1, $2, $3)`,
        [periodId, `退課時段復活（${id}，已歸還 1 堂）`, by]
      );
    }
    await client.query('COMMIT');
    const r = await pool.query(`SELECT * FROM admin_cancelled_sessions WHERE id = $1`, [id]);
    res.json(rowToCancelled(r.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin/sessions/:id/revive]', err);
    res.status(500).json({ error: 'revive failed' });
  } finally {
    client.release();
  }
});

/**
 * F-R01：櫃台補簽到 —— 可自由選擇上課/簽到時間，為某時段補登簽到。
 *  POST /api/admin/sessions/:id/backfill-checkin   { checkin_at }
 *  - checkin_at：操作者選擇的「簽到時間」（datetime-local / ISO 字串）
 *  - backfilled_at = NOW()：補簽到按鈕被按下的當下時間，供管理端查看
 */
router.post('/:id/backfill-checkin', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const raw = req.body?.checkin_at;
    const dt = raw ? new Date(raw) : null;
    if (!dt || isNaN(dt.getTime())) {
      return res.status(400).json({ error: '請選擇有效的簽到時間' });
    }
    // U13 修正：清單改讀真實課堂後，補簽到也寫「真實簽到紀錄」——
    // 對該堂課的本期全部 active 學員補 checkin_records（來源 'staff'、時間＝操作者選擇），
    // 已簽過的學員不重複。堂數計算與全系統同一真相。找不到真實課堂時，退回舊示範表
    // 路徑（向後相容既有 demo 資料，不影響新流程）。
    const real = await pool.query(
      `SELECT cs.id, cs.status::text AS status, cp.id AS period_id, cp.venue_id
         FROM course_sessions cs JOIN course_periods cp ON cp.id = cs.course_period_id
        WHERE cs.id::text = $1`,
      [id]
    );
    if (real.rowCount) {
      const row = real.rows[0];
      if (!isVenueInScope(req, row.venue_id)) {
        return res.status(403).json({ error: '此時段不在您的場館範圍內' });
      }
      if (row.status.startsWith('cancelled')) {
        return res.status(400).json({ error: '已取消的課堂不可補簽到' });
      }
      await pool.query(
        `INSERT INTO checkin_records (course_session_id, student_id, checked_in_source, checked_in_at)
         SELECT $1, cpe.student_id, 'staff', $2
           FROM course_period_enrollments cpe
          WHERE cpe.course_period_id = $3 AND cpe.status = 'active'
         ON CONFLICT (course_session_id, student_id) DO NOTHING`,
        [id, dt.toISOString(), row.period_id]
      );
      await pool.query(
        `UPDATE course_sessions
            SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
          WHERE id = $1 AND status = 'confirmed'`,
        [id]
      );
      return res.json({
        id,
        checkin_status: 'checked_in',
        checkin_at: dt.toISOString(),
        backfilled_at: new Date().toISOString(),
      });
    }

    const cur = await pool.query(`SELECT venue_id FROM admin_today_sessions WHERE id = $1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: '找不到此時段' });
    if (!isVenueInScope(req, cur.rows[0].venue_id)) {
      return res.status(403).json({ error: '此時段不在您的場館範圍內' });
    }
    const r = await pool.query(
      `UPDATE admin_today_sessions
          SET checkin_status = 'checked_in', checkin_at = $2, backfilled_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, dt.toISOString()]
    );
    res.json(rowToSession(r.rows[0]));
  } catch (err) {
    console.error('[admin/sessions/:id/backfill-checkin]', err);
    res.status(500).json({ error: 'backfill checkin failed' });
  }
});

/**
 * F-R03 收尾：體驗課簽到觸發 MGM 推薦獎勵發放
 *  POST /api/admin/sessions/checkin   { enrollmentId }
 *  - 將 admin_enrollments.experience_checked_in_at 設為 NOW()
 *  - 若該 enrollment 對應 referral_records，發放 9 折券給推薦方並推 LINE Flex
 */
router.post('/checkin', requireAdminAuth, async (req, res) => {
  const enrollmentId = String(req.body?.enrollmentId || '').trim();
  if (!enrollmentId) return res.status(400).json({ error: 'enrollmentId required' });
  try {
    const e = await pool.query(
      `SELECT id, venue_id FROM admin_enrollments WHERE id = $1`,
      [enrollmentId]
    );
    if (!e.rowCount) return res.status(404).json({ error: 'enrollment not found' });
    // Task #90：簽到場館須在當前 admin 所屬場館清單內
    const scope = getScopedVenueIds(req);
    if (scope && !scope.includes(e.rows[0].venue_id)) {
      return res.status(403).json({ error: '無權跨場館簽到' });
    }
    await pool.query(
      `ALTER TABLE admin_enrollments
         ADD COLUMN IF NOT EXISTS experience_checked_in_at TIMESTAMPTZ`
    );
    await pool.query(
      `UPDATE admin_enrollments SET experience_checked_in_at = COALESCE(experience_checked_in_at, NOW())
        WHERE id = $1`,
      [enrollmentId]
    );
    const by = req.adminUser?.name || req.adminUser?.username || 'unknown';
    await pool.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
       VALUES ($1, $2, $3)`,
      [enrollmentId, '體驗課簽到', by]
    );

    const referrals = require('../../services/referrals');
    const line = require('../../services/line');
    const reward = await referrals.issueRewardForEnrollment(enrollmentId, {
      line, BRAND_LIFF_URL: (process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '/liff/'),
    });

    // Task #60：廣播即時報到事件（venue_id 帶入做 server 端過濾）
    try {
      const er = e.rows[0];
      const detail = await pool.query(
        `SELECT ae.coach, ae.course_type, COALESCE(array_to_string(ae.students,'、'),'') AS students,
                v.name AS venue_name
           FROM admin_enrollments ae LEFT JOIN admin_venues v ON v.id = ae.venue_id
          WHERE ae.id = $1`, [enrollmentId]
      );
      const d = detail.rows[0] || {};
      const { broadcastAdminEvent } = require('../../services/websocket');
      broadcastAdminEvent('checkin:created', {
        checkin_id: `${enrollmentId}:${Date.now()}`,
        at: new Date().toISOString(),
        period_id: enrollmentId,
        venue_id: er.venue_id,
        venue_name: d.venue_name || er.venue_id,
        course_type: Number(d.course_type) || null,
        coach: d.coach || '',
        student: d.students || '',
      });
    } catch (e2) { console.warn('[admin/sessions/checkin] broadcast skipped:', e2?.message); }

    res.json({ ok: true, reward });
  } catch (err) {
    console.error('[admin/sessions/checkin]', err);
    res.status(500).json({ error: 'checkin failed' });
  }
});

// Task #60：列表端點已搬到 routes/admin/checkins.js（mount 為 /api/admin/checkins）
/* eslint-disable */

module.exports = router;
