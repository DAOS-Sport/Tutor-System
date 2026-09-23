/**
 * /api/admin/families — 櫃台的家庭管理（規格 docs/family_accounts_spec_2026-09-23.md §7、§9、§14）
 *
 * 權限：沿用「(Z01) 家長 & 學員關係」的 customer-parents（新資源鍵在既有庫預設全部拒絕，見 rolePermissions）。
 * 場館範圍：manager／staff 只能處理擁有者 primary_venue_id 在自己範圍內的家庭（比照 customerParents，範圍外回 404）。
 * 轉移擁有者、凍結／解除凍結限 admin。
 *
 *  GET  /by-parent/:parentId               這位家長所在的家庭（成員、預先登記、最近異動）；沒有回 { family: null }
 *  POST /                                  建立家庭 { owner_parent_id, owner_relationship?, name? }
 *  GET  /lookup?phone=&name=               櫃台加成員前查帳號：姓名對得上才回 LINE UID
 *  POST /by-parent/:parentId/members       Z01 視窗「添加成員」{ phone, name }：沒有家庭就先以這位家長為擁有者建立
 *  POST /by-parent/:parentId/invites       產生邀請連結 { relationship? }：沒有家庭就先以這位家長為擁有者建立
 *  POST /:id/invites/:inviteId/revoke      作廢邀請連結
 *  POST /:id/members                       加入成員 { phone＋name | parent_id, relationship? }
 *  PATCH /:id/members/:parentId            改關係 { relationship }
 *  POST /:id/members/:parentId/revoke      移出成員 { reason? }
 *  POST /:id/transfer-owner                轉移擁有者 { parent_id }（admin）
 *  POST /:id/freeze                        凍結／解除 { frozen, reason? }（admin）
 *  POST /:id/pending-members               預先登記家人手機 { phone, relationship }（第二階段）
 *  POST /:id/pending-members/:pid/remove   取消預先登記
 *  GET  /suggestions                       同一身分證掛在不同帳號、還沒合併的孩子
 *  POST /suggestions/apply                 一鍵建立 { student_a_id, student_b_id, member_relationship, owner_relationship?, owner_parent_id? }
 *  GET  /requests?status=pending           家長送來的合併申請
 *  POST /requests/:id/approve
 *  POST /requests/:id/reject               { reason }
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, isVenueInScope, getScopedVenueIds, requireAdminRole } = require('../../middlewares/adminAuth');
const { requireResource } = require('../../middlewares/requireResource');
const { adminActorName } = require('../../services/studentAudit');
const familyAdmin = require('../../services/familyAdmin');
const familyNotify = require('../../services/familyNotify');
const { relationshipLabel, resolveDuplicate, ownerParentFor, nameMatches } = require('../../services/familyRules');
const { maskName } = require('../../utils/piiMask');
const { normalizePhone } = require('../../services/identityNormalizer');

const LINE_UID_RE = /^U[0-9a-f]{32}$/i;

// 邀請連結的網址與回傳格式跟家長端共用（familyAdmin.shapeInvite）
const { shapeInvite } = familyAdmin;

const router = express.Router();
router.use(requireAdminAuth, requireResource('customer-parents'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(req) {
  return `admin:${adminActorName(req) || 'unknown'}`;
}

function sendError(res, err, fallback) {
  if (err instanceof familyAdmin.FamilyError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error('[admin/families]', fallback, err.code || err.message);
  return res.status(500).json({ error: fallback });
}

// 交易＋COMMIT 後送通知
async function run(res, fn, fallback) {
  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    out = await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    return sendError(res, err, fallback);
  }
  client.release();
  res.json({ ok: true, ...(out?.result && typeof out.result === 'object' ? { result: out.result } : {}) });
  familyNotify.sendNotices(out?.notices || []).catch(() => {});
}

async function parentVenue(parentId) {
  const r = await pool.query(`SELECT primary_venue_id FROM parents WHERE id = $1`, [parentId]);
  return r.rowCount ? { exists: true, venue: r.rows[0].primary_venue_id } : { exists: false };
}

async function parentInScope(req, parentId) {
  if (!UUID_RE.test(String(parentId || ''))) return false;
  const p = await parentVenue(parentId);
  return p.exists && isVenueInScope(req, p.venue);
}

async function familyInScope(req, familyId) {
  if (!UUID_RE.test(String(familyId || ''))) return false;
  const r = await pool.query(
    `SELECT p.primary_venue_id FROM families f LEFT JOIN parents p ON p.id = f.owner_parent_id WHERE f.id = $1`,
    [familyId]
  );
  return r.rowCount > 0 && isVenueInScope(req, r.rows[0].primary_venue_id);
}

function notFound(res) {
  return res.status(404).json({ error: '找不到這個家庭或家長', code: 'NOT_FOUND' });
}

// ── 查詢 ──────────────────────────────────────────────────────────────────
router.get('/by-parent/:parentId', async (req, res) => {
  try {
    if (!(await parentInScope(req, req.params.parentId))) return notFound(res);
    const m = await pool.query(
      `SELECT fm.family_id FROM family_members fm WHERE fm.parent_id = $1 AND fm.status = 'active' LIMIT 1`,
      [req.params.parentId]
    );
    if (!m.rowCount) return res.json({ family: null });
    const familyId = m.rows[0].family_id;
    const f = await pool.query(`SELECT id, name, status, owner_parent_id, created_at, created_by FROM families WHERE id = $1`, [familyId]);
    const members = await pool.query(
      // line_bound：家庭記的 userId 還等於主帳號目前的 LINE（換過 LINE → false，櫃台再「加入」一次＝重新綁定）。
      // userId 本身不回傳。
      `SELECT fm.parent_id, p.name, p.phone, fm.role, fm.relationship, fm.linked_at, fm.linked_by,
              (fm.line_uid IS NOT NULL AND p.line_uid = fm.line_uid) AS line_bound,
              (SELECT COUNT(*)::int FROM students s WHERE s.parent_id = p.id AND COALESCE(s.is_active, TRUE)) AS active_students
         FROM family_members fm JOIN parents p ON p.id = fm.parent_id
        WHERE fm.family_id = $1 AND fm.status = 'active'
        ORDER BY (fm.role = 'owner') DESC, fm.linked_at ASC NULLS LAST`,
      [familyId]
    );
    const pending = await pool.query(
      `SELECT id, phone_canonical, relationship, created_at, expires_at
         FROM family_pending_members WHERE family_id = $1 AND claimed_parent_id IS NULL AND expires_at > NOW()
        ORDER BY created_at DESC`,
      [familyId]
    );
    const invites = await pool.query(
      `SELECT * FROM family_invites
        WHERE family_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY created_at DESC`,
      [familyId]
    );
    const logs = await pool.query(
      `SELECT l.id, l.action, l.actor, l.target_parent_id, p.name AS target_name, l.detail, l.created_at
         FROM family_audit_logs l LEFT JOIN parents p ON p.id = l.target_parent_id
        WHERE l.family_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT 50`,
      [familyId]
    );
    res.json({
      family: {
        ...f.rows[0],
        members: members.rows.map((row) => ({ ...row, relationship_label: relationshipLabel(row.relationship) })),
        pending_members: pending.rows.map((row) => ({ ...row, relationship_label: relationshipLabel(row.relationship) })),
        invites: invites.rows.map(shapeInvite),
        logs: logs.rows,
      },
    });
  } catch (err) {
    sendError(res, err, '讀取家庭資料失敗');
  }
});

// ── 櫃台加成員前查帳號（擁有者 2026-09-23：只要手機、姓名，UID 由系統帶）──────────
// 姓名對不上時只回遮罩過的姓名提示，不回 UID —— 只知道手機的人查不到別人的 UID。
router.get('/lookup', async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  const name = String(req.query.name || '').trim();
  if (!/^09\d{8}$/.test(phone) || name.length < 2) {
    return res.status(400).json({ error: '請輸入 09 開頭的 10 碼手機與至少 2 個字的姓名', code: 'LOOKUP_INPUT_INVALID' });
  }
  try {
    const p = await pool.query(
      `SELECT p.id, p.name, p.line_uid,
              (SELECT jsonb_build_object('family_id', fm.family_id, 'owner_name', op.name)
                 FROM family_members fm JOIN families f ON f.id = fm.family_id
                 LEFT JOIN parents op ON op.id = f.owner_parent_id
                WHERE fm.parent_id = p.id AND fm.status = 'active' LIMIT 1) AS in_family
         FROM parents p WHERE p.phone = $1 AND COALESCE(p.is_active, TRUE) = TRUE LIMIT 2`,
      [phone]
    );
    if (!p.rowCount) return res.json({ found: false });
    if (p.rowCount > 1) return res.json({ found: true, multiple: true });
    const row = p.rows[0];
    if (!nameMatches(row.name, name)) return res.json({ found: true, name_matches: false, name_hint: maskName(row.name) });
    const bound = LINE_UID_RE.test(String(row.line_uid || ''));
    res.json({
      found: true, name_matches: true, parent_id: row.id, name: row.name,
      line_uid: bound ? row.line_uid : null, line_bound: bound, in_family: row.in_family || null,
    });
  } catch (err) {
    sendError(res, err, '查詢失敗');
  }
});

// ── 建立與成員 ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const ownerId = String(req.body?.owner_parent_id || '');
  if (!(await parentInScope(req, ownerId))) return notFound(res);
  await run(res, (c) => familyAdmin.createFamily(c, {
    ownerParentId: ownerId,
    ownerRelationship: req.body?.owner_relationship || null,
    name: String(req.body?.name || '').trim().slice(0, 100) || null,
    actor: actorOf(req),
  }), '建立家庭失敗');
});

// 要加的是誰：parent_id（成員列表上的「重新綁定」），或手機＋姓名（櫃台「添加成員」）。
// 用手機一定要附姓名，伺服器端再核對一次（畫面上的查詢只是方便，不能當成把關）。
// 回傳 parent id；有錯就直接回應並回傳 null。
async function resolveMember(req, res) {
  let parentId = String(req.body?.parent_id || '');
  if (!parentId && req.body?.phone) {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2) { res.status(400).json({ error: '請輸入家人的姓名', code: 'NAME_REQUIRED' }); return null; }
    const phone = normalizePhone(req.body.phone);
    const p = await pool.query(
      `SELECT id, name FROM parents WHERE phone = $1 AND COALESCE(is_active, TRUE) = TRUE LIMIT 2`,
      [phone]
    );
    if (p.rowCount !== 1) {
      res.status(404).json({ error: p.rowCount ? '這支手機對應到多個帳號，請改用家長清單指定' : '找不到這支手機的家長帳號（還沒註冊的話，可以用「預先登記」）', code: 'PARENT_NOT_FOUND' });
      return null;
    }
    if (!nameMatches(p.rows[0].name, name)) {
      res.status(409).json({ error: '手機號碼跟姓名對不上，請再確認', code: 'NAME_MISMATCH' });
      return null;
    }
    parentId = p.rows[0].id;
  }
  if (!UUID_RE.test(parentId)) { res.status(400).json({ error: '請輸入家人的手機與姓名', code: 'PARENT_REQUIRED' }); return null; }
  return parentId;
}

router.post('/:id/members', async (req, res) => {
  if (!(await familyInScope(req, req.params.id))) return notFound(res);
  const parentId = await resolveMember(req, res);
  if (!parentId) return;
  await run(res, async (c) => {
    const added = await familyAdmin.addMember(c, {
      familyId: req.params.id, parentId, relationship: req.body?.relationship, actor: actorOf(req),
    });
    // 新成員名下跟家人重複的孩子依 §9 處理（跟邀請加入、核准申請一致）
    const decisions = await familyAdmin.resolveNewMemberDuplicates(c, { parentId, familyId: req.params.id, actor: actorOf(req) });
    return { result: { ...added.result, decisions }, notices: added.notices };
  }, '加入成員失敗');
});

// Z01 編輯視窗的「邀請家人加入」（擁有者 2026-09-23）：產生一次性的邀請連結；
// 這位家長還沒有家庭時，先以他為擁有者建立（同一個交易）。
router.post('/by-parent/:parentId/invites', async (req, res) => {
  const ownerId = String(req.params.parentId || '');
  if (!(await parentInScope(req, ownerId))) return notFound(res);
  let invite = null;
  const client = await pool.connect();
  let notices = [];
  try {
    await client.query('BEGIN');
    let familyId = (await familyAdmin.activeMembership(client, ownerId, { lock: true }))?.family_id || null;
    if (!familyId) {
      const created = await familyAdmin.createFamily(client, { ownerParentId: ownerId, actor: actorOf(req) });
      familyId = created.result.id;
      notices = created.notices;
    }
    invite = (await familyAdmin.createInvite(client, {
      familyId, relationship: req.body?.relationship || null, actor: actorOf(req),
    })).result;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    return sendError(res, err, '產生邀請連結失敗');
  }
  client.release();
  res.json({ ok: true, invite: shapeInvite(invite) });
  familyNotify.sendNotices(notices).catch(() => {});
});

router.post('/:id/invites/:inviteId/revoke', async (req, res) => {
  if (!(await familyInScope(req, req.params.id))) return notFound(res);
  if (!UUID_RE.test(String(req.params.inviteId || ''))) return notFound(res);
  await run(res, (c) => familyAdmin.revokeInvite(c, {
    familyId: req.params.id, inviteId: req.params.inviteId, actor: actorOf(req),
  }), '作廢邀請失敗');
});

// Z01 編輯視窗的「添加成員」（擁有者 2026-09-23）：這位家長還沒有家庭時，
// 加第一位成員就以他為擁有者建立家庭 —— 建立與加入在同一個交易，不會留下只有一個人的空家庭。
router.post('/by-parent/:parentId/members', async (req, res) => {
  const ownerId = String(req.params.parentId || '');
  if (!(await parentInScope(req, ownerId))) return notFound(res);
  const parentId = await resolveMember(req, res);
  if (!parentId) return;
  if (parentId === ownerId) return res.status(400).json({ error: '不能把這位家長加成自己的家人', code: 'SELF_MEMBER' });
  await run(res, async (c) => {
    const notices = [];
    let familyId = (await familyAdmin.activeMembership(c, ownerId, { lock: true }))?.family_id || null;
    if (!familyId) {
      const created = await familyAdmin.createFamily(c, { ownerParentId: ownerId, actor: actorOf(req) });
      familyId = created.result.id;
      notices.push(...created.notices);
    }
    const added = await familyAdmin.addMember(c, {
      familyId, parentId, relationship: req.body?.relationship || null, actor: actorOf(req),
    });
    notices.push(...added.notices);
    const decisions = await familyAdmin.resolveNewMemberDuplicates(c, { parentId, familyId, actor: actorOf(req) });
    return { result: { family_id: familyId, ...added.result, decisions }, notices };
  }, '加入成員失敗');
});

router.patch('/:id/members/:parentId', async (req, res) => {
  if (!(await familyInScope(req, req.params.id))) return notFound(res);
  await run(res, (c) => familyAdmin.setRelationship(c, {
    familyId: req.params.id, parentId: req.params.parentId, relationship: req.body?.relationship, actor: actorOf(req),
  }), '修改關係失敗');
});

router.post('/:id/members/:parentId/revoke', async (req, res) => {
  if (!(await familyInScope(req, req.params.id))) return notFound(res);
  await run(res, (c) => familyAdmin.revokeMember(c, {
    familyId: req.params.id, parentId: req.params.parentId, actor: actorOf(req),
    reason: String(req.body?.reason || '').trim().slice(0, 200) || null,
  }), '移出成員失敗');
});

router.post('/:id/transfer-owner', requireAdminRole('admin'), async (req, res) => {
  if (!(await familyInScope(req, req.params.id))) return notFound(res);
  await run(res, (c) => familyAdmin.transferOwner(c, {
    familyId: req.params.id, newOwnerParentId: String(req.body?.parent_id || ''), actor: actorOf(req),
  }), '轉移擁有者失敗');
});

router.post('/:id/freeze', requireAdminRole('admin'), async (req, res) => {
  if (!(await familyInScope(req, req.params.id))) return notFound(res);
  await run(res, (c) => familyAdmin.setFrozen(c, {
    familyId: req.params.id, frozen: req.body?.frozen !== false, actor: actorOf(req),
    reason: String(req.body?.reason || '').trim().slice(0, 200) || null,
  }), '變更凍結狀態失敗');
});

router.post('/:id/pending-members', async (req, res) => {
  if (!(await familyInScope(req, req.params.id))) return notFound(res);
  await run(res, (c) => familyAdmin.addPendingMember(c, {
    familyId: req.params.id, phone: req.body?.phone, relationship: req.body?.relationship, actor: actorOf(req),
  }), '預先登記失敗');
});

router.post('/:id/pending-members/:pid/remove', async (req, res) => {
  if (!(await familyInScope(req, req.params.id))) return notFound(res);
  await run(res, (c) => familyAdmin.removePendingMember(c, {
    familyId: req.params.id, pendingId: req.params.pid, actor: actorOf(req),
  }), '取消預先登記失敗');
});

// ── 家庭建議（§7、§9）──────────────────────────────────────────────────────
// 生日一律在 SQL 轉成 YYYY-MM-DD：pg 會把 DATE 轉成本地午夜的 Date，JSON 化變成前一天 16:00Z
router.get('/suggestions', async (req, res) => {
  try {
    const scope = getScopedVenueIds(req);
    const r = await pool.query(
      `SELECT a.id AS a_id, a.name AS a_name, a.parent_id AS a_parent_id, pa.name AS a_parent_name, pa.phone AS a_parent_phone,
              pa.primary_venue_id AS a_venue, (a.ragic_record_id IS NOT NULL) AS a_in_ragic, to_char(a.birth_date, 'YYYY-MM-DD') AS a_birth,
              ${familyAdmin.courseLoadSql('a')} AS a_periods,
              b.id AS b_id, b.name AS b_name, b.parent_id AS b_parent_id, pb.name AS b_parent_name, pb.phone AS b_parent_phone,
              pb.primary_venue_id AS b_venue, (b.ragic_record_id IS NOT NULL) AS b_in_ragic, to_char(b.birth_date, 'YYYY-MM-DD') AS b_birth,
              ${familyAdmin.courseLoadSql('b')} AS b_periods
         FROM students a
         JOIN students b ON b.id_number = a.id_number AND b.parent_id <> a.parent_id AND a.id < b.id
         JOIN parents pa ON pa.id = a.parent_id
         JOIN parents pb ON pb.id = b.parent_id
        WHERE COALESCE(a.is_active, TRUE) AND COALESCE(b.is_active, TRUE)
          AND NULLIF(a.id_number, '') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM family_members x JOIN family_members y ON y.family_id = x.family_id
             WHERE x.parent_id = a.parent_id AND y.parent_id = b.parent_id AND x.status = 'active' AND y.status = 'active')
          AND ($1::text[] IS NULL OR pa.primary_venue_id = ANY($1::text[]) OR pb.primary_venue_id = ANY($1::text[]))
        ORDER BY a.name
        LIMIT 200`,
      [scope]
    );
    const rows = r.rows.map((row) => {
      const a = { id: row.a_id, parentId: row.a_parent_id, inRagic: row.a_in_ragic, periods: row.a_periods };
      const b = { id: row.b_id, parentId: row.b_parent_id, inRagic: row.b_in_ragic, periods: row.b_periods };
      return {
        a: { student_id: row.a_id, name: row.a_name, parent_id: row.a_parent_id, parent_name: row.a_parent_name,
             parent_phone: row.a_parent_phone, in_ragic: row.a_in_ragic, periods: row.a_periods, birth_date: row.a_birth },
        b: { student_id: row.b_id, name: row.b_name, parent_id: row.b_parent_id, parent_name: row.b_parent_name,
             parent_phone: row.b_parent_phone, in_ragic: row.b_in_ragic, periods: row.b_periods, birth_date: row.b_birth },
        suggested_owner_parent_id: ownerParentFor(a, b),
        duplicate_plan: resolveDuplicate(a, b),
      };
    });
    res.json({ items: rows });
  } catch (err) {
    sendError(res, err, '讀取家庭建議失敗');
  }
});

router.post('/suggestions/apply', async (req, res) => {
  const a = String(req.body?.student_a_id || '');
  const b = String(req.body?.student_b_id || '');
  if (!UUID_RE.test(a) || !UUID_RE.test(b)) return res.status(400).json({ error: '缺少學員資料', code: 'SUGGESTION_INVALID' });
  const owners = await pool.query(`SELECT parent_id FROM students WHERE id = ANY($1::uuid[])`, [[a, b]]);
  for (const row of owners.rows) {
    if (!(await parentInScope(req, row.parent_id))) return notFound(res);
  }
  await run(res, (c) => familyAdmin.applySuggestion(c, {
    studentAId: a, studentBId: b,
    memberRelationship: req.body?.member_relationship,
    ownerRelationship: req.body?.owner_relationship || null,
    ownerParentId: req.body?.owner_parent_id || null,
    actor: actorOf(req), actorRole: req.adminUser?.role,
  }), '建立家庭失敗');
});

// ── 家長送來的合併申請（§14）─────────────────────────────────────────────────
router.get('/requests', async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : 'pending';
    const scope = getScopedVenueIds(req);
    const r = await pool.query(
      `SELECT r.id, r.status, r.relationship, r.note, r.created_at, r.reviewed_by, r.reviewed_at, r.reject_reason,
              ap.id AS applicant_id, ap.name AS applicant_name, ap.phone AS applicant_phone,
              t.id AS target_id, t.name AS target_name, to_char(t.birth_date, 'YYYY-MM-DD') AS target_birth,
              (t.ragic_record_id IS NOT NULL) AS target_in_ragic,
              ${familyAdmin.courseLoadSql('t')} AS target_periods,
              op.id AS owner_id, op.name AS owner_name, op.phone AS owner_phone, op.primary_venue_id AS owner_venue,
              d.id AS dup_id, d.name AS dup_name, to_char(d.birth_date, 'YYYY-MM-DD') AS dup_birth,
              (d.ragic_record_id IS NOT NULL) AS dup_in_ragic,
              ${familyAdmin.courseLoadSql('d')} AS dup_periods
         FROM family_join_requests r
         JOIN parents ap ON ap.id = r.applicant_parent_id
         JOIN students t ON t.id = r.target_student_id
         JOIN parents op ON op.id = t.parent_id
         LEFT JOIN students d ON d.id = r.duplicate_student_id
        WHERE r.status = $1
          AND ($2::text[] IS NULL OR op.primary_venue_id = ANY($2::text[]))
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [status, scope]
    );
    res.json({
      items: r.rows.map((row) => ({
        ...row,
        relationship_label: relationshipLabel(row.relationship),
        duplicate_plan: row.dup_id
          ? resolveDuplicate(
            { id: row.target_id, parentId: row.owner_id, inRagic: row.target_in_ragic, periods: row.target_periods },
            { id: row.dup_id, parentId: row.applicant_id, inRagic: row.dup_in_ragic, periods: row.dup_periods })
          : null,
      })),
    });
  } catch (err) {
    sendError(res, err, '讀取合併申請失敗');
  }
});

async function requestInScope(req, requestId) {
  if (!UUID_RE.test(String(requestId || ''))) return false;
  const r = await pool.query(
    `SELECT t.parent_id FROM family_join_requests r JOIN students t ON t.id = r.target_student_id WHERE r.id = $1`,
    [requestId]
  );
  return r.rowCount > 0 && parentInScope(req, r.rows[0].parent_id);
}

router.post('/requests/:id/approve', async (req, res) => {
  if (!(await requestInScope(req, req.params.id))) return notFound(res);
  await run(res, (c) => familyAdmin.approveRequest(c, {
    requestId: req.params.id, actor: actorOf(req), actorRole: req.adminUser?.role,
  }), '核准失敗');
});

router.post('/requests/:id/reject', async (req, res) => {
  if (!(await requestInScope(req, req.params.id))) return notFound(res);
  await run(res, (c) => familyAdmin.rejectRequest(c, {
    requestId: req.params.id, actor: actorOf(req), reason: req.body?.reason,
  }), '退回失敗');
});

module.exports = router;
