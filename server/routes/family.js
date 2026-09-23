/**
 * /api/family — 家長端的家庭動作（規格 docs/family_accounts_spec_2026-09-23.md §14）
 *
 *  POST   /requests        申請加入孩子所在的家庭 { id_number, birth_date, relationship, note? }
 *  DELETE /requests/:id    取消自己審核中的申請
 *  POST   /leave           成員自己退出家庭（擁有者不行，要先由櫃台轉移）
 *
 * 防濫用：身分證＋生日都要相符；不符只回通用訊息、不透露任何對方資料；
 *        每個帳號 24 小時內最多 5 次嘗試（含不符的）；同時只能有一筆審核中；一定要櫃台核准。
 */
const express = require('express');
const { pool } = require('../models/db');
const { requireParent } = require('../middlewares/parentAuth');
const familyScope = require('../services/familyScope');
const familyAdmin = require('../services/familyAdmin');
const familyNotify = require('../services/familyNotify');
const { isRelationship, relationshipLabel } = require('../services/familyRules');
const { formatPlainDate } = require('../utils/dateTime');

const router = express.Router();
router.use(requireParent);

const TW_ID = /^[A-Z][12]\d{8}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
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
      `SELECT i.*, f.status AS family_status, op.name AS owner_name,
              (SELECT COUNT(*)::int FROM family_members m WHERE m.family_id = i.family_id AND m.status = 'active') AS member_count,
              EXISTS (SELECT 1 FROM family_members m WHERE m.family_id = i.family_id AND m.status = 'active' AND m.parent_id = $2) AS already_member
         FROM family_invites i
         JOIN families f ON f.id = i.family_id
         LEFT JOIN parents op ON op.id = f.owner_parent_id
        WHERE i.token = $1`,
      [String(req.params.token || ''), req.parent.id]
    );
    const inv = r.rows[0] || null;
    const problem = familyAdmin.inviteProblem(inv);
    if (problem) return fail(res, problem.status, problem.code, problem.message);
    res.json({
      owner_name: inv.owner_name || null,
      member_count: inv.member_count,
      relationship: inv.relationship,
      expires_at: inv.expires_at,
      already_member: inv.already_member,
      in_other_family: !!scope.family && !inv.already_member,
      family_frozen: inv.family_status !== 'active',
    });
  } catch (err) {
    console.error('[family GET /invites/:token]', err.code || err.message);
    fail(res, 500, 'FAMILY_INVITE_FAILED', '讀取邀請失敗，請稍後再試');
  }
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

router.post('/requests', async (req, res) => {
  const scope = await familyScope.forRequest(req);
  if (!scope.enabled) return fail(res, 404, 'FAMILY_DISABLED', '家庭功能尚未開放');
  const idNumber = String(req.body?.id_number || '').trim().toUpperCase();
  const birth = String(req.body?.birth_date || '').trim();
  const relationship = String(req.body?.relationship || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 200) || null;
  if (!TW_ID.test(idNumber) || !ISO_DATE.test(birth)) {
    return fail(res, 400, 'FAMILY_REQUEST_INPUT_INVALID', '請填寫孩子的身分證字號與生日');
  }
  if (!isRelationship(relationship)) return fail(res, 400, 'RELATIONSHIP_INVALID', '請選擇您和孩子的關係');
  if (scope.family) return fail(res, 409, 'ALREADY_IN_FAMILY', '您已經在家庭裡了；要加入別的家庭，請先退出目前的家庭');

  const client = await pool.connect();
  let request = null;
  let owner = null;
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
      return fail(res, 409, 'FAMILY_REQUEST_PENDING', '您已經有一筆申請在審核中');
    }
    // 目標：別的帳號名下、同身分證的孩子；同一身分證有多份時優先 Ragic 上那份
    const t = await client.query(
      `SELECT s.id, s.parent_id, s.birth_date
         FROM students s
        WHERE UPPER(s.id_number) = $1 AND COALESCE(s.is_active, TRUE) = TRUE AND s.parent_id <> $2
        ORDER BY (s.ragic_record_id IS NOT NULL) DESC, s.created_at ASC
        LIMIT 1`,
      [idNumber, req.parent.id]
    );
    const target = t.rows[0] || null;
    const matched = !!target && formatPlainDate(target.birth_date) === birth;
    await client.query(`INSERT INTO family_join_attempts (parent_id, matched) VALUES ($1, $2)`, [req.parent.id, matched]);
    if (!matched) {
      await client.query('COMMIT'); // 不符的嘗試也要記次數
      return fail(res, 422, 'FAMILY_REQUEST_NOT_MATCHED', '資料不符，請確認孩子的身分證字號與生日，或洽櫃台協助。');
    }
    if (scope.parentIds.map(String).includes(String(target.parent_id))) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'STUDENT_IN_FAMILY', '這位孩子已在您的家庭中。');
    }
    const dup = await client.query(
      `SELECT id FROM students WHERE parent_id = $1 AND UPPER(id_number) = $2 AND COALESCE(is_active, TRUE) = TRUE LIMIT 1`,
      [req.parent.id, idNumber]
    );
    const ins = await client.query(
      `INSERT INTO family_join_requests (applicant_parent_id, target_student_id, duplicate_student_id, relationship, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
      [req.parent.id, target.id, dup.rows[0]?.id || null, relationship, note]
    );
    request = ins.rows[0];
    owner = target.parent_id;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, 409, 'FAMILY_REQUEST_PENDING', '您已經有一筆申請在審核中');
    console.error('[family/requests]', err.code || err.message);
    return fail(res, 500, 'FAMILY_REQUEST_FAILED', '申請送出失敗，請稍後再試');
  } finally {
    client.release();
  }

  res.status(201).json({ ok: true, request });
  // 通知孩子的所屬家長（§14 第 4 點）；不透露申請人的電話等資料
  try {
    const me = await pool.query(`SELECT name FROM parents WHERE id = $1`, [req.parent.id]);
    await familyNotify.sendNotices([{
      kind: 'parent',
      parentId: owner,
      text: `${me.rows[0]?.name || '一位家長'}（${relationshipLabel(relationship)}）申請加入您的家庭，櫃台確認後生效；如果不認識這位申請人，請聯絡櫃台。`,
      refKey: `famreq:${request.id}:submitted`,
    }]);
  } catch (err) {
    console.warn('[family/requests] notify owner failed:', err.message);
  }
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
