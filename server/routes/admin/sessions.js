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

    const args = [from, to];
    let sql = `SELECT * FROM admin_today_sessions WHERE date >= $1 AND date <= $2`;
    if (venueIds && venueIds.length) {
      args.push(venueIds);
      sql += ` AND venue_id = ANY($${args.length}::text[])`;
    }
    sql += ` ORDER BY date, start_time`;
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
    const scope = getScopedVenueIds(req);
    let sql = `SELECT * FROM admin_today_sessions`;
    const args = [];
    if (scope) {
      args.push(scope);
      sql += ` WHERE venue_id = ANY($${args.length}::text[])`;
    } else if (req.query.venueId) {
      args.push(req.query.venueId);
      sql += ` WHERE venue_id = $${args.length}`;
    }
    sql += ` ORDER BY start_time`;
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

    const s = await pool.query(
      `SELECT * FROM admin_today_sessions WHERE coach = $1 AND venue_id = $2 LIMIT 1`,
      [e.coach, e.venue_id]
    );
    res.json({
      found: true,
      enrollment,
      session: s.rowCount ? rowToSession(s.rows[0]) : null,
    });
  } catch (err) {
    console.error('[admin/sessions/verify-checkin]', err);
    res.status(500).json({ error: 'verify checkin failed' });
  }
});

// 櫃台（staff）可唯讀檢視（getScopedVenueIds 會自動鎖其場館）；實際「歸還」仍僅 admin/manager
router.get('/cancelled', requireAdminAuth, requireAdminRole('admin', 'manager', 'staff'), async (req, res) => {
  try {
    const scope = getScopedVenueIds(req);
    const args = [];
    let sql = `SELECT * FROM admin_cancelled_sessions`;
    if (scope) {
      args.push(scope);
      sql += ` WHERE venue_id = ANY($1::text[])`;
    }
    sql += ` ORDER BY date DESC, start_time`;
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
