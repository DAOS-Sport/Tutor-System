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
const { requireParent, optionalParent } = require('../middlewares/parentAuth');
const { maskName, maskNames } = require('../utils/piiMask');
const ragic = require('../services/ragic');
const line = require('../services/line');

const router = express.Router();

// 與 enrollments.js 共用的匯款證明路徑格式（local driver 產生）
const PROOF_URL_RE = /^\/uploads\/\d{4}-\d{2}\/[a-f0-9]{24}\.(jpg|jpeg|png)$/;
// 台灣手機格式（與 auth.js 一致）
const TW_PHONE_RE = /^09\d{8}$/;

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

// per-IP in-memory rate limit（與 coachAuth / auth.js 同模式；單機 MVP，正式部署改 Redis）。
// 用於公開（免登入）端點，抑制以分享出去的 join token 暴搜電話號碼。
const RL_WINDOW_MS = 5 * 60 * 1000;
function makeRateLimiter(max, label) {
  const buckets = new Map(); // ip → { count, windowStart }
  return function rateLimit(req, res, next) {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();
    const now = Date.now();
    const rec = buckets.get(ip);
    if (!rec || now - rec.windowStart > RL_WINDOW_MS) {
      if (buckets.size > 5000) {
        for (const [k, v] of buckets) if (now - v.windowStart > RL_WINDOW_MS) buckets.delete(k);
      }
      buckets.set(ip, { count: 1, windowStart: now });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      console.warn(`[group-orders] rate-limited ${label}: ip=${ip} attempts=${rec.count}`);
      return res.status(429).json({ error: '查詢次數過多，請 5 分鐘後再試', code: 'RATE_LIMITED' });
    }
    next();
  };
}
// lookup-phone 是枚舉風險面 → 較緊（15 / 5min，足夠正常確認流程）；by-token 預覽較鬆（頁面載入/刷新）。
const lookupRateLimit = makeRateLimiter(15, 'lookup-phone');
const previewRateLimit = makeRateLimiter(60, 'by-token-preview');

// 整理前端送來的「新學員」（需建檔者）：name 必填，其餘選填
function cleanNewStudents(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => ({
      name: String(s?.name || '').trim(),
      id_number: s?.id_number ? String(s.id_number).trim().toUpperCase() : null,
      birth_date: s?.birth_date ? String(s.birth_date).trim() : null,
      gender: s?.gender ? String(s.gender).trim() : null,
      blood_type: s?.blood_type ? String(s.blood_type).trim() : null,
    }))
    .filter((s) => s.name);
}

/**
 * 在交易內把「加入者本次選的學員」解析成綁定後的 { ids, names, createdForRagic }：
 *  - studentIds：限定為 req.parent 名下既有學員（驗證擁有權，避免綁別人的小孩）
 *  - newStudents：在本地 students 建檔（綁到 parentId），收集新 id/name；
 *    回傳 createdForRagic 供交易提交後 best-effort 寫入 Ragic 子表格。
 * 任一學員姓名都會進 names（供顯示），ids 收集既有 + 新建。
 */
async function resolveBoundStudents(client, parentId, studentIds, newStudents) {
  const ids = [];
  const names = [];
  const createdForRagic = [];

  const wantIds = Array.isArray(studentIds)
    ? [...new Set(studentIds.map((x) => String(x || '').trim()).filter(Boolean))]
    : [];
  if (wantIds.length) {
    const r = await client.query(
      `SELECT id, name FROM students WHERE parent_id = $1 AND id = ANY($2::uuid[])`,
      [parentId, wantIds]
    );
    if (r.rowCount !== wantIds.length) {
      const err = new Error('所選學員不存在或不屬於您');
      err.code = 'STUDENT_NOT_OWNED';
      throw err;
    }
    for (const row of r.rows) { ids.push(row.id); names.push(row.name); }
  }

  for (const s of newStudents || []) {
    // 同 parent 下以 id_number 或 name+birth 去重，避免重複建檔
    let matched = null;
    if (s.id_number) {
      const m = await client.query(
        `SELECT id, name FROM students WHERE parent_id = $1 AND id_number = $2 LIMIT 1`,
        [parentId, s.id_number]
      );
      matched = m.rows[0] || null;
    }
    if (!matched) {
      const m = await client.query(
        `SELECT id, name FROM students
          WHERE parent_id = $1 AND name = $2
            AND ($3::date IS NULL OR birth_date = $3::date)
          LIMIT 1`,
        [parentId, s.name, s.birth_date || null]
      );
      matched = m.rows[0] || null;
    }
    if (matched) {
      if (!ids.includes(matched.id)) { ids.push(matched.id); names.push(matched.name); }
      continue;
    }
    const ins = await client.query(
      `INSERT INTO students (parent_id, name, birth_date, gender, id_number, blood_type)
       VALUES ($1, $2, $3::date, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''))
       RETURNING id, name`,
      [parentId, s.name, s.birth_date || null, s.gender || '', s.id_number || '', s.blood_type || '']
    );
    ids.push(ins.rows[0].id);
    names.push(ins.rows[0].name);
    createdForRagic.push(s);
  }

  return { ids, names, createdForRagic };
}

/**
 * best-effort 把新建學員補寫進該家長的 Ragic Z01 子表格。
 * 失敗只記 log、不拋錯（本地已建檔，加入動作不該因 Ragic 卡住）。
 */
async function syncNewStudentsToRagic(parentId, createdForRagic) {
  if (!createdForRagic || !createdForRagic.length) return;
  try {
    const pr = await pool.query(`SELECT ragic_record_id FROM parents WHERE id = $1`, [parentId]);
    const ragicRecordId = pr.rows[0]?.ragic_record_id || null;
    if (!ragicRecordId) {
      console.warn('[group-orders ragic] parent 無 ragic_record_id，略過子表格回寫', parentId);
      return;
    }
    // startIndex = 目前該家長本地學員數扣掉本次新建數（≈ Ragic 既有子表格列數）
    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM students WHERE parent_id = $1`, [parentId]);
    const startIndex = Math.max(0, (cnt.rows[0]?.n || 0) - createdForRagic.length);
    await ragic.addStudentsToParentInRagic({ ragicRecordId, startIndex, students: createdForRagic });
  } catch (e) {
    console.warn('[group-orders ragic] addStudentsToParentInRagic failed:', e.message);
  }
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

// ═══════════════════════════════════════════════════════════
// 公開（免登入）路由：分享出去的加入連結，點開先唯讀看狀態 + 電話查詢
// optionalParent：有帶 parent JWT 就解析（用來判斷 already_member / is_self），沒有也放行
// ═══════════════════════════════════════════════════════════

// ── GET /by-token/:token 預覽要加入的團購（唯讀，他家庭資料遮罩） ──
router.get('/by-token/:token', previewRateLimit, optionalParent, async (req, res) => {
  try {
    const o = await pool.query(`SELECT * FROM group_orders WHERE join_token = $1`, [req.params.token]);
    if (!o.rowCount) return res.status(404).json({ error: '邀請碼無效' });
    const loaded = await loadOrderWithMembers(pool, o.rows[0].id);
    const viewerId = req.parent?.id || null;
    const alreadyMember = viewerId ? loaded.members.some((m) => m.parent_id === viewerId) : false;
    res.json(shapeOrder(loaded.order, loaded.members, viewerId, {
      already_member: alreadyMember,
      joinable: loaded.order.status === 'forming' && !alreadyMember,
    }));
  } catch (err) {
    console.error('[group-orders GET /by-token]', err);
    res.status(500).json({ error: '載入失敗' });
  }
});

// ── POST /by-token/:token/lookup-phone 以電話查詢「這支電話名下學生 + 在本團狀態」 ──
//    用途：加入者輸入家長電話，確認掛在下面的學生與目前團報狀態無誤後再加入。
//    隱私：學生／家長姓名一律遮罩；查無此電話 → found:false（前端引導註冊）。
router.post('/by-token/:token/lookup-phone', lookupRateLimit, optionalParent, async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  if (!TW_PHONE_RE.test(phone)) {
    return res.status(400).json({ error: '手機格式錯誤（需 09xxxxxxxx）', code: 'PHONE_FORMAT_INVALID' });
  }
  try {
    const o = await pool.query(`SELECT * FROM group_orders WHERE join_token = $1`, [req.params.token]);
    if (!o.rowCount) return res.status(404).json({ error: '邀請碼無效' });
    const order = o.rows[0];

    const pr = await pool.query(`SELECT id, name FROM parents WHERE phone = $1 LIMIT 1`, [phone]);
    if (!pr.rowCount) {
      return res.json({ found: false, order_status: order.status });
    }
    const parent = pr.rows[0];
    const sr = await pool.query(`SELECT name FROM students WHERE parent_id = $1 ORDER BY created_at ASC`, [parent.id]);
    const mm = await pool.query(
      `SELECT 1 FROM group_order_members WHERE group_order_id = $1 AND parent_id = $2`,
      [order.id, parent.id]
    );
    res.json({
      found: true,
      parent_name: maskName(parent.name),
      students: maskNames(sr.rows.map((r) => r.name)),
      student_count: sr.rowCount,
      already_member: mm.rowCount > 0,
      is_self: req.parent?.id === parent.id,
      order_status: order.status,
      joinable: order.status === 'forming' && mm.rowCount === 0,
    });
  } catch (err) {
    console.error('[group-orders lookup-phone]', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// ═══════════════════════════════════════════════════════════
// 以下皆需 parent JWT
// ═══════════════════════════════════════════════════════════
router.use(requireParent);

// ── POST / 發起團購 ──────────────────────────────────────────
router.post('/', async (req, res) => {
  const p = req.body || {};
  const courseType = parseInt(p.course_type, 10);
  const venueId = p.venue_id ? String(p.venue_id).trim() : '';
  const coachId = p.coach_id ? String(p.coach_id).trim() : null;
  const studentIds = Array.isArray(p.student_ids) ? p.student_ids : [];
  const newStudents = cleanNewStudents(p.new_students);
  const note = typeof p.note === 'string' ? p.note.trim().slice(0, 500) : null;
  const proof = validProof(p.payment_proof_url);

  if (isNaN(courseType) || courseType < 1) return res.status(400).json({ error: 'course_type 無效' });
  if (!venueId) return res.status(400).json({ error: '請選擇場館' });
  if (!studentIds.length && !newStudents.length) return res.status(400).json({ error: '請選擇或填寫至少一位學生' });
  if (!proof) return res.status(400).json({ error: '請上傳匯款／轉帳證明', code: 'PAYMENT_PROOF_REQUIRED' });

  const client = await pool.connect();
  let createdForRagic = [];
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

    let bound;
    try {
      bound = await resolveBoundStudents(client, req.parent.id, studentIds, newStudents);
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(e.code === 'STUDENT_NOT_OWNED' ? 403 : 400).json({ error: e.message, code: e.code });
    }
    if (!bound.names.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '請選擇或填寫至少一位學生' });
    }
    if (bound.names.length > max_students) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `學生人數已超過上限（最多 ${max_students} 人）` });
    }
    createdForRagic = bound.createdForRagic;

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
         (group_order_id, parent_id, student_names, student_ids, payment_proof_url, is_leader, status)
       VALUES ($1,$2,$3,$4,$5,TRUE,'joined')`,
      [order.id, req.parent.id, bound.names, bound.ids, proof]
    );

    await client.query('COMMIT');
    await syncNewStudentsToRagic(req.parent.id, createdForRagic); // best-effort，失敗不阻擋
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

// ── POST /by-token/:token/join 加入團購（綁定本人學員 + best-effort 回寫 Ragic）──
router.post('/by-token/:token/join', async (req, res) => {
  const p = req.body || {};
  const studentIds = Array.isArray(p.student_ids) ? p.student_ids : [];
  const newStudents = cleanNewStudents(p.new_students);
  const proof = validProof(p.payment_proof_url);
  if (!studentIds.length && !newStudents.length) return res.status(400).json({ error: '請選擇或填寫至少一位學生' });
  if (!proof) return res.status(400).json({ error: '請上傳匯款／轉帳證明', code: 'PAYMENT_PROOF_REQUIRED' });

  const client = await pool.connect();
  let createdForRagic = [];
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

    let bound;
    try {
      bound = await resolveBoundStudents(client, req.parent.id, studentIds, newStudents);
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(e.code === 'STUDENT_NOT_OWNED' ? 403 : 400).json({ error: e.message, code: e.code });
    }
    if (!bound.names.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '請選擇或填寫至少一位學生' });
    }
    createdForRagic = bound.createdForRagic;

    const cur = await client.query(
      `SELECT COALESCE(SUM(COALESCE(array_length(student_names,1),0)),0) AS total
         FROM group_order_members WHERE group_order_id = $1`,
      [order.id]
    );
    const curTotal = Number(cur.rows[0].total);
    if (curTotal + bound.names.length > order.max_students) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `加入後將超過人數上限（最多 ${order.max_students} 人，目前 ${curTotal} 人）`,
        code: 'OVER_CAPACITY',
      });
    }

    await client.query(
      `INSERT INTO group_order_members
         (group_order_id, parent_id, student_names, student_ids, payment_proof_url, is_leader, status)
       VALUES ($1,$2,$3,$4,$5,FALSE,'joined')`,
      [order.id, req.parent.id, bound.names, bound.ids, proof]
    );
    await client.query('COMMIT');
    await syncNewStudentsToRagic(req.parent.id, createdForRagic); // best-effort，失敗不阻擋

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
