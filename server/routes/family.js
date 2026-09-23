/**
 * /api/family — 家長端的家庭動作（規格 docs/family_accounts_spec_2026-09-23.md §14，擁有者 2026-09-23 調整）
 *
 *  GET    /invites/:token            邀請連結預覽
 *  POST   /invites                   產生邀請連結（擁有者；還沒有家庭的家長先放在「準備中的家庭」）
 *  POST   /invites/:id/revoke        作廢邀請連結
 *  POST   /invites/:token/accept     用邀請連結加入
 *  POST   /requests                  申請加入家人的家庭 { student_name, parent_phone, relationship, note? }
 *  DELETE /requests/:id              取消自己審核中的申請
 *  POST   /requests/:id/approve      對方家長（或他家庭的擁有者）同意
 *  POST   /requests/:id/reject       對方家長（或他家庭的擁有者）拒絕 { reason? }
 *  POST   /members/:parentId/revoke  擁有者解綁加入的家人（擁有者本人不能被解綁，只能編輯）
 *  POST   /leave                     成員自己退出家庭（擁有者不行）
 *
 * 申請：填孩子的名字＋對方家長的手機，對方家長同意才生效（櫃台也還能在後台核准）。
 * 防濫用：不符只回通用訊息、不透露任何對方資料；每個帳號 24 小時內最多 5 次嘗試（含不符的）；
 *        同時只能有一筆審核中。
 */
const express = require('express');
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');
const familyScope = require('../services/familyScope');
const familyAdmin = require('../services/familyAdmin');
const familyNotify = require('../services/familyNotify');
const { isRelationship, relationshipLabel, nameMatches } = require('../services/familyRules');
const { normalizePhone } = require('../services/identityNormalizer');

const router = express.Router();
router.use(requireParent);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS_PER_DAY = 5;

function fail(res, status, code, error) {
  return res.status(status).json({ error, code });
}

// ── 邀請連結（擁有者 2026-09-23）──────────────────────────────────────────
// 預覽：誰邀請、家裡幾個人；連結不能用時回原因。需要登入（LIFF 在 LINE 裡打開會自動登入）。
router.get('/invites/:token', async (req, res) => {
  const scope = await familyScope.forRequest(req);
  if (!scope.enabled) return fail(res, 404, 'FAMILY_DISABLED', '家庭功能尚未開放');
  try {
    const r = await pool.query(
      `SELECT i.*, f.status AS family_status, f.owner_parent_id, op.name AS owner_name,
              (SELECT COUNT(*)::int FROM family_members m WHERE m.family_id = i.family_id AND m.status = 'active') AS member_count,
              EXISTS (SELECT 1 FROM family_members m WHERE m.family_id = i.family_id AND m.status = 'active' AND m.parent_id = $2) AS already_member
         FROM family_invites i
         JOIN families f ON f.id = i.family_id
         LEFT JOIN parents op ON op.id = f.owner_parent_id
        WHERE i.token = $1`,
      [String(req.params.token || ''), req.parent.id]
    );
    const inv = r.rows[0] || null;
    const problem = familyAdmin.inviteProblem(inv && inv.family_status === 'active' ? inv : null);
    if (problem) return fail(res, problem.status, problem.code, problem.message);
    res.json({
      owner_name: inv.owner_name || null,
      member_count: Math.max(inv.member_count, 1), // 準備中的家庭還沒有成員，邀請人算一位
      relationship: inv.relationship,
      expires_at: inv.expires_at,
      own_invite: String(inv.owner_parent_id) === String(req.parent.id),
      already_member: inv.already_member,
      in_other_family: !!scope.family && !inv.already_member,
    });
  } catch (err) {
    console.error('[family GET /invites/:token]', err.code || err.message);
    fail(res, 500, 'FAMILY_INVITE_FAILED', '讀取邀請失敗，請稍後再試');
  }
});

// 家長自己邀請家人（擁有者 2026-09-23）。只限家庭的擁有者 —— 孩子的資料由擁有者決定分享給誰；
// 還沒有家庭的家長：連結先放在「準備中的家庭」，有人用連結加入時才成立、他當擁有者。一般成員不能再邀別人。
router.post('/invites', async (req, res) => {
  const scope = await familyScope.forRequest(req);
  if (!scope.enabled) return fail(res, 404, 'FAMILY_DISABLED', '家庭功能尚未開放');
  if (scope.family && scope.family.role !== 'owner') {
    return fail(res, 403, 'OWNER_ONLY', '只有家庭的擁有者可以邀請家人，請聯絡擁有者或櫃台');
  }
  const actor = `parent:${req.parent.id}`;
  const client = await pool.connect();
  let invite;
  try {
    await client.query('BEGIN');
    let familyId = scope.family?.family_id || null;
    if (!familyId) {
      // 還有一筆「申請加入別人家庭」在審核中 → 不能同時自己開家庭（核准時會衝突）
      const pendingReq = await client.query(
        `SELECT 1 FROM family_join_requests WHERE applicant_parent_id = $1 AND status = 'pending' LIMIT 1`, [req.parent.id]);
      if (pendingReq.rowCount) {
        await client.query('ROLLBACK');
        client.release();
        return fail(res, 409, 'FAMILY_REQUEST_PENDING', '您有一筆加入家庭的申請正在審核中，請先取消申請再邀請家人');
      }
      // 沒有「有效的」家庭，但還有成員列（LINE 換過、綁定失效）→ 先請櫃台重新綁定，不另開新家庭
      if (await familyAdmin.activeMembership(client, req.parent.id, { lock: true })) {
        await client.query('ROLLBACK');
        client.release();
        return fail(res, 409, 'REBIND_REQUIRED', '您的 LINE 帳號換過了，請先請櫃台重新綁定家庭');
      }
      familyId = await familyAdmin.pendingFamilyOf(client, req.parent.id, { create: true, actor });
    }
    invite = (await familyAdmin.createInvite(client, { familyId, actor })).result;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    if (err instanceof familyAdmin.FamilyError) return fail(res, err.status, err.code, err.message);
    console.error('[family POST /invites]', err.code || err.message);
    return fail(res, 500, 'FAMILY_INVITE_FAILED', '產生邀請連結失敗，請稍後再試');
  }
  client.release();
  res.status(201).json({ ok: true, invite: familyAdmin.shapeInvite(invite) });
});

router.post('/invites/:id/revoke', async (req, res) => {
  const scope = await familyScope.forRequest(req);
  if (!scope.enabled) return fail(res, 404, 'FAMILY_DISABLED', '家庭功能尚未開放');
  if (scope.family && scope.family.role !== 'owner') return fail(res, 403, 'OWNER_ONLY', '只有家庭的擁有者可以作廢邀請');
  if (!UUID_RE.test(String(req.params.id || ''))) return fail(res, 404, 'INVITE_NOT_FOUND', '找不到這個邀請');
  // 有家庭：作廢自己家的；還沒有家庭：作廢準備中的家庭裡的
  const familyId = scope.family?.family_id || await familyAdmin.pendingFamilyOf(pool, req.parent.id);
  if (!familyId) return fail(res, 404, 'INVITE_NOT_FOUND', '找不到這個邀請');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await familyAdmin.revokeInvite(client, { familyId, inviteId: req.params.id, actor: `parent:${req.parent.id}` });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    if (err instanceof familyAdmin.FamilyError) return fail(res, err.status, err.code, err.message);
    console.error('[family POST /invites/:id/revoke]', err.code || err.message);
    return fail(res, 500, 'FAMILY_INVITE_FAILED', '作廢失敗，請稍後再試');
  }
  client.release();
  res.json({ ok: true });
});

router.post('/invites/:token/accept', async (req, res) => {
  const scope = await familyScope.forRequest(req);
  if (!scope.enabled) return fail(res, 404, 'FAMILY_DISABLED', '家庭功能尚未開放');
  const relationship = String(req.body?.relationship || '').trim() || null;
  if (relationship && !isRelationship(relationship)) return fail(res, 400, 'RELATIONSHIP_INVALID', '請選擇您和孩子的關係');
  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    out = await familyAdmin.acceptInvite(client, { token: req.params.token, parentId: req.parent.id, relationship });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    if (err instanceof familyAdmin.FamilyError) return fail(res, err.status, err.code, err.message);
    console.error('[family POST /invites/:token/accept]', err.code || err.message);
    return fail(res, 500, 'FAMILY_INVITE_FAILED', '加入家庭失敗，請稍後再試');
  }
  client.release();
  res.json({ ok: true, family_id: out.result.family_id });
  familyNotify.sendNotices(out.notices).catch(() => {});
});

// 申請加入家人的家庭（擁有者 2026-09-23）：填孩子的名字＋對方家長的手機；對方家長同意才生效，
// 對方在家庭裡但不是擁有者時由擁有者同意。櫃台也還能在後台核准（備援）。
router.post('/requests', async (req, res) => {
  const scope = await familyScope.forRequest(req);
  if (!scope.enabled) return fail(res, 404, 'FAMILY_DISABLED', '家庭功能尚未開放');
  const studentName = String(req.body?.student_name || '').trim().slice(0, 40);
  const phone = normalizePhone(req.body?.parent_phone);
  const relationship = String(req.body?.relationship || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 200) || null;
  if (studentName.replace(/\s/g, '').length < 2 || !/^09\d{8}$/.test(phone)) {
    return fail(res, 400, 'FAMILY_REQUEST_INPUT_INVALID', '請填寫孩子的名字與對方家長的手機號碼');
  }
  if (!isRelationship(relationship)) return fail(res, 400, 'RELATIONSHIP_INVALID', '請選擇您和孩子的關係');
  if (scope.family) return fail(res, 409, 'ALREADY_IN_FAMILY', '您已經在家庭裡了；要加入別的家庭，請先退出目前的家庭');

  const client = await pool.connect();
  let request = null;
  let target = null;
  try {
    await client.query('BEGIN');
    // 同一帳號的申請排隊處理，避免雙擊或並行把次數限制繞過去
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('family_join_request:' || $1))`, [req.parent.id]);
    const attempts = await client.query(
      `SELECT COUNT(*)::int AS n FROM family_join_attempts WHERE parent_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [req.parent.id]
    );
    if (attempts.rows[0].n >= MAX_ATTEMPTS_PER_DAY) {
      await client.query('ROLLBACK');
      return fail(res, 429, 'FAMILY_REQUEST_TOO_MANY', '今天的申請次數已達上限，請明天再試，或洽櫃台協助');
    }
    const pending = await client.query(
      `SELECT 1 FROM family_join_requests WHERE applicant_parent_id = $1 AND status = 'pending'`,
      [req.parent.id]
    );
    if (pending.rowCount) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'FAMILY_REQUEST_PENDING', '您已經有一筆申請在等對方同意');
    }
    // 目標：手機對得上的另一個有效帳號名下、名字對得上的有效孩子（Ragic 上那份優先）
    const t = await client.query(
      `SELECT s.id, s.parent_id, s.name, s.id_number
         FROM parents p
         JOIN students s ON s.parent_id = p.id AND COALESCE(s.is_active, TRUE) = TRUE
        WHERE p.phone = $1 AND COALESCE(p.is_active, TRUE) = TRUE AND p.id <> $2
        ORDER BY (s.ragic_record_id IS NOT NULL) DESC, s.created_at ASC`,
      [phone, req.parent.id]
    );
    target = t.rows.find((row) => nameMatches(row.name, studentName)) || null;
    await client.query(`INSERT INTO family_join_attempts (parent_id, matched) VALUES ($1, $2)`, [req.parent.id, !!target]);
    if (!target) {
      await client.query('COMMIT'); // 不符的嘗試也要記次數
      return fail(res, 422, 'FAMILY_REQUEST_NOT_MATCHED', '資料不符，請確認孩子的名字與對方家長的手機號碼，或洽櫃台協助。');
    }
    if (scope.parentIds.map(String).includes(String(target.parent_id))) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'STUDENT_IN_FAMILY', '這位孩子已在您的家庭中。');
    }
    // 我名下跟這個孩子同一個身分證的那份（重複登記）→ 核准時依 §9 處理
    const dup = target.id_number
      ? await client.query(
        `SELECT id FROM students WHERE parent_id = $1 AND UPPER(id_number) = UPPER($2) AND COALESCE(is_active, TRUE) = TRUE LIMIT 1`,
        [req.parent.id, target.id_number])
      : { rows: [] };
    const ins = await client.query(
      `INSERT INTO family_join_requests (applicant_parent_id, target_student_id, duplicate_student_id, relationship, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
      [req.parent.id, target.id, dup.rows[0]?.id || null, relationship, note]
    );
    request = ins.rows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, 409, 'FAMILY_REQUEST_PENDING', '您已經有一筆申請在等對方同意');
    console.error('[family/requests]', err.code || err.message);
    return fail(res, 500, 'FAMILY_REQUEST_FAILED', '申請送出失敗，請稍後再試');
  } finally {
    client.release();
  }

  res.status(201).json({ ok: true, request });
  // 通知要按同意的人（孩子的家長；他在家庭裡但不是擁有者時是擁有者）；不透露申請人的電話等資料
  try {
    const approverId = await approverFor(pool, target.parent_id);
    const me = await pool.query(`SELECT name FROM parents WHERE id = $1`, [req.parent.id]);
    if (approverId) {
      await familyNotify.sendNotices([{
        kind: 'parent',
        parentId: approverId,
        text: `${me.rows[0]?.name || '一位家長'}（${relationshipLabel(relationship)}）申請加入您的家庭（孩子：${target.name}）。請到個人頁「我的家庭」同意或拒絕；不認識這位申請人請直接拒絕。`,
        refKey: `famreq:${request.id}:submitted`,
      }]);
    }
  } catch (err) {
    console.warn('[family/requests] notify approver failed:', err.message);
  }
});

// 誰可以同意這筆申請：孩子的家長所在家庭的擁有者；孩子的家長還沒有家庭時就是他本人
async function approverFor(db, targetParentId) {
  const m = await familyAdmin.activeMembership(db, targetParentId);
  if (!m) return targetParentId;
  if (m.family_status !== 'active') return null;
  const o = await db.query(
    `SELECT parent_id FROM family_members WHERE family_id = $1 AND role = 'owner' AND status = 'active' LIMIT 1`,
    [m.family_id]
  );
  return o.rows[0]?.parent_id || null;
}

// 對方家長同意／拒絕（櫃台在後台也能做）。擁有者要是目前 LINE 綁定有效的那位（scope.family）。
async function decideRequest(req, res, decide) {
  const scope = await familyScope.forRequest(req);
  if (!scope.enabled) return fail(res, 404, 'FAMILY_DISABLED', '家庭功能尚未開放');
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) return fail(res, 404, 'FAMILY_REQUEST_NOT_FOUND', '找不到這筆申請');
  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT r.id, s.parent_id AS target_parent_id
         FROM family_join_requests r JOIN students s ON s.id = r.target_student_id
        WHERE r.id = $1 AND r.status = 'pending'
        FOR UPDATE OF r`,
      [id]
    );
    const row = r.rows[0];
    const approverId = row ? await approverFor(client, row.target_parent_id) : null;
    const allowed = approverId && String(approverId) === String(req.parent.id)
      && (!scope.family || scope.family.role === 'owner');
    if (!allowed) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'FAMILY_REQUEST_NOT_FOUND', '找不到等您同意的申請');
    }
    out = await decide(client, row);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof familyAdmin.FamilyError) return fail(res, err.status, err.code, err.message);
    console.error('[family/requests decide]', err.code || err.message);
    return fail(res, 500, 'FAMILY_REQUEST_DECIDE_FAILED', '操作失敗，請稍後再試');
  } finally {
    client.release();
  }
  res.json({ ok: true });
  familyNotify.sendNotices(out.notices).catch(() => {});
}

router.post('/requests/:id/approve', (req, res) => decideRequest(req, res, (c, row) =>
  familyAdmin.approveRequest(c, { requestId: row.id, actor: `parent:${req.parent.id}`, actorRole: 'parent' })));

router.post('/requests/:id/reject', (req, res) => decideRequest(req, res, (c, row) =>
  familyAdmin.rejectRequest(c, {
    requestId: row.id,
    actor: `parent:${req.parent.id}`,
    reason: String(req.body?.reason || '').trim().slice(0, 200) || '對方家長未同意',
  })));

// 擁有者解綁加入的家人（擁有者 2026-09-23）。擁有者本人（原本辦理學員的那位）不能被解綁，只能編輯。
router.post('/members/:parentId/revoke', async (req, res) => {
  const scope = await familyScope.forRequest(req);
  if (!scope.enabled || !scope.family) return fail(res, 404, 'NOT_IN_FAMILY', '您目前不在任何家庭裡');
  if (scope.family.role !== 'owner') return fail(res, 403, 'OWNER_ONLY', '只有家庭的擁有者可以解綁家人');
  const target = String(req.params.parentId || '');
  if (!UUID_RE.test(target)) return fail(res, 404, 'MEMBER_NOT_FOUND', '這位家長不在您的家庭裡');
  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    out = await familyAdmin.revokeMember(client, {
      familyId: scope.family.family_id, parentId: target, actor: `parent:${req.parent.id}`, reason: '擁有者在個人頁解綁', by: 'owner',
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof familyAdmin.FamilyError) return fail(res, err.status, err.code, err.message);
    console.error('[family/members revoke]', err.code || err.message);
    return fail(res, 500, 'FAMILY_REVOKE_FAILED', '解綁失敗，請稍後再試');
  } finally {
    client.release();
  }
  res.json({ ok: true });
  familyNotify.sendNotices(out.notices).catch(() => {});
});

router.delete('/requests/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE family_join_requests SET status = 'cancelled', reviewed_at = NOW(), reviewed_by = $3
        WHERE id::text = $1 AND applicant_parent_id = $2 AND status = 'pending' RETURNING id`,
      [String(req.params.id), req.parent.id, `parent:${req.parent.id}`]
    );
    if (!r.rowCount) return fail(res, 404, 'FAMILY_REQUEST_NOT_FOUND', '找不到審核中的申請');
    res.json({ ok: true });
  } catch (err) {
    console.error('[family/requests cancel]', err.code || err.message);
    fail(res, 500, 'FAMILY_REQUEST_CANCEL_FAILED', '取消失敗，請稍後再試');
  }
});

router.post('/leave', async (req, res) => {
  const scope = await familyScope.forRequest(req);
  if (!scope.enabled || !scope.family) return fail(res, 404, 'NOT_IN_FAMILY', '您目前不在任何家庭裡');
  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    out = await familyAdmin.revokeMember(client, {
      familyId: scope.family.family_id,
      parentId: req.parent.id,
      actor: `parent:${req.parent.id}`,
      self: true,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof familyAdmin.FamilyError) return fail(res, err.status, err.code, err.message);
    console.error('[family/leave]', err.code || err.message);
    return fail(res, 500, 'FAMILY_LEAVE_FAILED', '退出失敗，請稍後再試');
  } finally {
    client.release();
  }
  res.json({ ok: true });
  familyNotify.sendNotices(out.notices).catch(() => {});
});

module.exports = router;
