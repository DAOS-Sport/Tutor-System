/**
 * 家庭帳號的寫入動作（規格 docs/family_accounts_spec_2026-09-23.md §7、§9、§14、第二階段）。
 *
 * 每個動作都在呼叫端給的交易 client 裡跑，並寫 family_audit_logs；回傳 { result, notices }，
 * notices 由路由在 COMMIT 之後送 LINE（best-effort，失敗不影響已落地的資料）。
 *
 * 原則（§14）：一個孩子只有一份資料、掛在 Ragic 上的家長底下；其他家人一律透過家庭、由櫃台核准。
 * 重複學員的處理一律走 familyRules.resolveDuplicate：保留 Ragic 那份、絕不搬課程。
 */
const { relationshipLabel, isRelationship, resolveDuplicate, ownerParentFor } = require('./familyRules');
const { writeStudentAudit } = require('./studentAudit');
const { normalizePhone } = require('./identityNormalizer');

class FamilyError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function audit(c, familyId, action, actor, targetParentId = null, detail = {}) {
  const r = await c.query(
    `INSERT INTO family_audit_logs (family_id, action, actor, target_parent_id, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [familyId, action, actor, targetParentId, JSON.stringify(detail || {})]
  );
  return r.rows[0].id;
}

async function activeMembership(c, parentId, { lock = false } = {}) {
  const r = await c.query(
    `SELECT fm.*, f.status AS family_status, f.owner_parent_id
       FROM family_members fm JOIN families f ON f.id = fm.family_id
      WHERE fm.parent_id = $1 AND fm.status = 'active'
      LIMIT 1 ${lock ? 'FOR UPDATE OF fm' : ''}`,
    [parentId]
  );
  return r.rows[0] || null;
}

async function loadParent(c, parentId) {
  const r = await c.query(
    `SELECT id, name, phone, line_uid, primary_venue_id, is_active FROM parents WHERE id = $1`,
    [parentId]
  );
  if (!r.rowCount) throw new FamilyError('PARENT_NOT_FOUND', '找不到這位家長', 404);
  return r.rows[0];
}

async function lockFamily(c, familyId) {
  const r = await c.query(`SELECT * FROM families WHERE id = $1 FOR UPDATE`, [familyId]);
  if (!r.rowCount) throw new FamilyError('FAMILY_NOT_FOUND', '找不到這個家庭', 404);
  return r.rows[0];
}

function requireRelationship(rel, field = '關係') {
  if (!isRelationship(rel)) throw new FamilyError('RELATIONSHIP_INVALID', `請選擇${field}`, 400);
}

// 家庭通知對象：全家 active 成員
function familyNotice(familyId, text, refKey) {
  return { kind: 'family', familyId, text, refKey };
}
function parentNotice(parentId, text, refKey) {
  return { kind: 'parent', parentId, text, refKey };
}

async function createFamily(c, { ownerParentId, ownerRelationship = null, name = null, actor }) {
  if (ownerRelationship) requireRelationship(ownerRelationship, '擁有者的關係');
  const owner = await loadParent(c, ownerParentId);
  if (await activeMembership(c, ownerParentId, { lock: true })) {
    throw new FamilyError('ALREADY_IN_FAMILY', '這位家長已經在另一個家庭裡，請先移出');
  }
  const f = await c.query(
    `INSERT INTO families (owner_parent_id, name, created_by, status) VALUES ($1, $2, $3, 'active') RETURNING *`,
    [ownerParentId, name, actor]
  );
  const family = f.rows[0];
  await c.query(
    `INSERT INTO family_members (family_id, parent_id, role, status, relationship, linked_by, linked_at)
     VALUES ($1, $2, 'owner', 'active', $3, $4, NOW())`,
    [family.id, ownerParentId, ownerRelationship, actor]
  );
  const auditId = await audit(c, family.id, 'family_created', actor, ownerParentId, { owner_relationship: ownerRelationship });
  return {
    result: family,
    notices: [parentNotice(ownerParentId,
      `櫃台已為您建立「家庭」。之後加入的家人可以一起查看孩子的課程、幫忙繳費與簽到。`,
      `fam:${auditId}:${ownerParentId}`)],
    owner,
  };
}

async function addMember(c, { familyId, parentId, relationship, actor }) {
  requireRelationship(relationship);
  const family = await lockFamily(c, familyId);
  if (family.status !== 'active') throw new FamilyError('FAMILY_FROZEN', '這個家庭已凍結，請先解除凍結');
  const parent = await loadParent(c, parentId);
  const existing = await activeMembership(c, parentId, { lock: true });
  if (existing && existing.family_id === familyId) throw new FamilyError('ALREADY_MEMBER', '這位家長已經是這個家庭的成員');
  if (existing) throw new FamilyError('ALREADY_IN_FAMILY', '這位家長已經在另一個家庭裡，請先移出');
  await c.query(
    `INSERT INTO family_members (family_id, parent_id, role, status, relationship, linked_by, linked_at)
     VALUES ($1, $2, 'member', 'active', $3, $4, NOW())`,
    [familyId, parentId, relationship, actor]
  );
  const auditId = await audit(c, familyId, 'member_added', actor, parentId, { relationship });
  return {
    result: { family_id: familyId, parent_id: parentId },
    notices: [familyNotice(familyId,
      `${parent.name || '一位家人'}（${relationshipLabel(relationship)}）已加入您的家庭，之後可以一起查看孩子的課程、幫忙繳費與簽到。如有疑問請聯絡櫃台。`,
      `fam:${auditId}`)],
  };
}

async function setRelationship(c, { familyId, parentId, relationship, actor }) {
  requireRelationship(relationship);
  await lockFamily(c, familyId);
  const r = await c.query(
    `UPDATE family_members SET relationship = $3
      WHERE family_id = $1 AND parent_id = $2 AND status = 'active' RETURNING id`,
    [familyId, parentId, relationship]
  );
  if (!r.rowCount) throw new FamilyError('MEMBER_NOT_FOUND', '這位家長不在這個家庭裡', 404);
  await audit(c, familyId, 'relationship_changed', actor, parentId, { relationship });
  return { result: { ok: true }, notices: [] };
}

async function revokeMember(c, { familyId, parentId, actor, reason = null, self = false }) {
  await lockFamily(c, familyId);
  const m = await c.query(
    `SELECT role FROM family_members WHERE family_id = $1 AND parent_id = $2 AND status = 'active' FOR UPDATE`,
    [familyId, parentId]
  );
  if (!m.rowCount) throw new FamilyError('MEMBER_NOT_FOUND', '這位家長不在這個家庭裡', 404);
  if (m.rows[0].role === 'owner') {
    throw new FamilyError('OWNER_CANNOT_LEAVE', self
      ? '擁有者不能自己退出，請聯絡櫃台先轉移擁有者'
      : '擁有者不能直接移除，請先轉移擁有者');
  }
  const parent = await loadParent(c, parentId);
  await c.query(
    `UPDATE family_members SET status = 'revoked', revoked_by = $3, revoked_at = NOW(), note = COALESCE($4, note)
      WHERE family_id = $1 AND parent_id = $2 AND status = 'active'`,
    [familyId, parentId, actor, reason]
  );
  const auditId = await audit(c, familyId, self ? 'member_left' : 'member_revoked', actor, parentId, { reason });
  return {
    result: { ok: true },
    notices: [
      familyNotice(familyId, `${parent.name || '一位家人'}已${self ? '退出' : '被櫃台移出'}您的家庭，之後不能再查看家中孩子的課程。如有疑問請聯絡櫃台。`, `fam:${auditId}`),
      parentNotice(parentId, self ? '您已退出家庭。' : '您已被移出家庭，如有疑問請聯絡櫃台。', `fam:${auditId}:${parentId}`),
    ],
  };
}

async function transferOwner(c, { familyId, newOwnerParentId, actor }) {
  const family = await lockFamily(c, familyId);
  const m = await c.query(
    `SELECT role FROM family_members WHERE family_id = $1 AND parent_id = $2 AND status = 'active' FOR UPDATE`,
    [familyId, newOwnerParentId]
  );
  if (!m.rowCount) throw new FamilyError('MEMBER_NOT_FOUND', '新的擁有者必須是這個家庭的成員', 404);
  if (m.rows[0].role === 'owner') return { result: { ok: true, unchanged: true }, notices: [] };
  // 先降再升：一個家庭同一時間只能有一位 active 擁有者（部分唯一索引）
  await c.query(`UPDATE family_members SET role = 'member' WHERE family_id = $1 AND role = 'owner' AND status = 'active'`, [familyId]);
  await c.query(`UPDATE family_members SET role = 'owner' WHERE family_id = $1 AND parent_id = $2 AND status = 'active'`, [familyId, newOwnerParentId]);
  await c.query(`UPDATE families SET owner_parent_id = $2, updated_at = NOW() WHERE id = $1`, [familyId, newOwnerParentId]);
  const auditId = await audit(c, familyId, 'owner_transferred', actor, newOwnerParentId, { from: family.owner_parent_id });
  return { result: { ok: true }, notices: [familyNotice(familyId, '櫃台已變更您家庭的擁有者。如有疑問請聯絡櫃台。', `fam:${auditId}`)] };
}

async function setFrozen(c, { familyId, frozen, actor, reason = null }) {
  const family = await lockFamily(c, familyId);
  const next = frozen ? 'frozen' : 'active';
  if (family.status === next) return { result: { ok: true, unchanged: true }, notices: [] };
  await c.query(`UPDATE families SET status = $2, updated_at = NOW() WHERE id = $1`, [familyId, next]);
  const auditId = await audit(c, familyId, frozen ? 'family_frozen' : 'family_unfrozen', actor, null, { reason });
  return {
    result: { ok: true },
    notices: [familyNotice(familyId, frozen
      ? '櫃台已暫停您家庭的共用功能，家人暫時無法查看彼此孩子的資料。如有疑問請聯絡櫃台。'
      : '您家庭的共用功能已恢復。', `fam:${auditId}`)],
  };
}

async function studentCopy(c, studentId) {
  const r = await c.query(
    `SELECT s.id, s.parent_id, s.name, s.is_active, (s.ragic_record_id IS NOT NULL) AS in_ragic,
            (SELECT COUNT(*)::int FROM course_period_enrollments e WHERE e.student_id = s.id) AS periods
       FROM students s WHERE s.id = $1`,
    [studentId]
  );
  const row = r.rows[0];
  return row ? { id: row.id, parentId: row.parent_id, name: row.name, active: row.is_active !== false, inRagic: row.in_ragic, periods: row.periods } : null;
}

// 依 §9 規則處理重複學員：停用那份 → 寫學員稽核；其他情況只記錄，交給櫃台
async function applyDuplicateRule(c, { a, b, familyId, actor, actorRole }) {
  const decision = resolveDuplicate(a, b);
  if (decision.action === 'deactivate') {
    await c.query(`UPDATE students SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND is_active IS NOT FALSE`, [decision.studentId]);
    await writeStudentAudit(c, decision.studentId, 'edit', {
      byUser: actor,
      byRole: actorRole || 'system',
      changes: { is_active: { before: true, after: false } },
      note: 'family-merge-duplicate',
    });
  }
  await audit(c, familyId, 'duplicate_resolved', actor, null, { decision, students: [a.id, b.id] });
  return decision;
}

// 家庭申請核准（§14）：沒有家庭就以孩子的所屬家長為擁有者建立；申請人加入為成員；重複學員依 §9
async function approveRequest(c, { requestId, actor, actorRole }) {
  const r = await c.query(`SELECT * FROM family_join_requests WHERE id = $1 FOR UPDATE`, [requestId]);
  if (!r.rowCount) throw new FamilyError('REQUEST_NOT_FOUND', '找不到這筆申請', 404);
  const req = r.rows[0];
  if (req.status !== 'pending') throw new FamilyError('REQUEST_NOT_PENDING', '這筆申請已經處理過了');
  const target = await studentCopy(c, req.target_student_id);
  if (!target || !target.active) throw new FamilyError('TARGET_GONE', '申請的孩子資料已停用或不存在，請改用退回');
  const notices = [];

  let ownerMembership = await activeMembership(c, target.parentId, { lock: true });
  let familyId;
  if (ownerMembership) {
    familyId = ownerMembership.family_id;
  } else {
    const created = await createFamily(c, { ownerParentId: target.parentId, actor });
    familyId = created.result.id;
    notices.push(...created.notices);
  }
  const applicantMembership = await activeMembership(c, req.applicant_parent_id, { lock: true });
  if (applicantMembership && applicantMembership.family_id !== familyId) {
    throw new FamilyError('ALREADY_IN_FAMILY', '申請人已經在另一個家庭裡，請先移出再核准');
  }
  if (!applicantMembership) {
    const added = await addMember(c, { familyId, parentId: req.applicant_parent_id, relationship: req.relationship, actor });
    notices.push(...added.notices);
  }

  let duplicate = null;
  if (req.duplicate_student_id) {
    const dup = await studentCopy(c, req.duplicate_student_id);
    if (dup && dup.active && dup.id !== target.id) {
      duplicate = await applyDuplicateRule(c, { a: target, b: dup, familyId, actor, actorRole });
    }
  }
  await c.query(
    `UPDATE family_join_requests SET status = 'approved', reviewed_by = $2, reviewed_at = NOW() WHERE id = $1`,
    [requestId, actor]
  );
  const auditId = await audit(c, familyId, 'request_approved', actor, req.applicant_parent_id, { request_id: requestId, duplicate });
  notices.push(parentNotice(req.applicant_parent_id,
    '您的家庭申請已通過！現在可以一起查看孩子的課程、幫忙繳費與簽到。', `fam:${auditId}:${req.applicant_parent_id}`));
  return { result: { family_id: familyId, duplicate }, notices };
}

async function rejectRequest(c, { requestId, actor, reason }) {
  const why = String(reason || '').trim().slice(0, 200);
  if (!why) throw new FamilyError('REASON_REQUIRED', '請填寫退回原因', 400);
  const r = await c.query(`SELECT * FROM family_join_requests WHERE id = $1 FOR UPDATE`, [requestId]);
  if (!r.rowCount) throw new FamilyError('REQUEST_NOT_FOUND', '找不到這筆申請', 404);
  if (r.rows[0].status !== 'pending') throw new FamilyError('REQUEST_NOT_PENDING', '這筆申請已經處理過了');
  await c.query(
    `UPDATE family_join_requests SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), reject_reason = $3 WHERE id = $1`,
    [requestId, actor, why]
  );
  return {
    result: { ok: true },
    notices: [parentNotice(r.rows[0].applicant_parent_id,
      `您的家庭申請未通過：${why}。如有疑問請聯絡櫃台。`, `famreq:${requestId}:rejected`)],
  };
}

// 「家庭建議」一鍵建立（§7、§9）：兩份同一身分證的孩子 → 擁有者＝Ragic 上那位；另一位加入；重複依規則
async function applySuggestion(c, { studentAId, studentBId, memberRelationship, ownerRelationship = null, ownerParentId = null, actor, actorRole }) {
  requireRelationship(memberRelationship, '加入者的關係');
  const a = await studentCopy(c, studentAId);
  const b = await studentCopy(c, studentBId);
  if (!a || !b || a.parentId === b.parentId) throw new FamilyError('SUGGESTION_INVALID', '這兩筆資料不是兩個帳號的同一位孩子', 400);
  const ownerId = ownerParentId || ownerParentFor(a, b);
  if (!ownerId || ![a.parentId, b.parentId].includes(ownerId)) {
    throw new FamilyError('OWNER_REQUIRED', '無法自動判斷擁有者（兩份都在或都不在 Ragic），請指定擁有者', 400);
  }
  const memberId = ownerId === a.parentId ? b.parentId : a.parentId;
  const notices = [];
  const ownerMembership = await activeMembership(c, ownerId, { lock: true });
  let familyId;
  if (ownerMembership) familyId = ownerMembership.family_id;
  else {
    const created = await createFamily(c, { ownerParentId: ownerId, ownerRelationship, actor });
    familyId = created.result.id;
    notices.push(...created.notices);
  }
  const memberMembership = await activeMembership(c, memberId, { lock: true });
  if (memberMembership && memberMembership.family_id !== familyId) {
    throw new FamilyError('ALREADY_IN_FAMILY', '另一位家長已經在別的家庭裡，請先移出');
  }
  if (!memberMembership) {
    const added = await addMember(c, { familyId, parentId: memberId, relationship: memberRelationship, actor });
    notices.push(...added.notices);
  }
  const duplicate = (a.active && b.active)
    ? await applyDuplicateRule(c, { a, b, familyId, actor, actorRole })
    : { action: 'none', reason: 'already_inactive' };
  return { result: { family_id: familyId, duplicate }, notices };
}

// 第二階段：櫃台先登記家人的手機，對方註冊後自動加入（註冊仍照常要填孩子，重複依 §9 處理）
async function addPendingMember(c, { familyId, phone, relationship, actor }) {
  requireRelationship(relationship);
  const family = await lockFamily(c, familyId);
  if (family.status !== 'active') throw new FamilyError('FAMILY_FROZEN', '這個家庭已凍結，請先解除凍結');
  const canonical = normalizePhone(phone);
  if (!/^09\d{8}$/.test(canonical)) throw new FamilyError('PHONE_INVALID', '請輸入 09 開頭的 10 碼手機', 400);
  const existing = await c.query(`SELECT id FROM parents WHERE phone = $1 AND COALESCE(is_active, TRUE) = TRUE LIMIT 1`, [canonical]);
  if (existing.rowCount) throw new FamilyError('PARENT_EXISTS', '這支手機已經註冊過，請直接用「加入成員」', 409);
  const r = await c.query(
    `INSERT INTO family_pending_members (family_id, phone_canonical, relationship, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone_canonical) WHERE claimed_parent_id IS NULL
     DO UPDATE SET family_id = EXCLUDED.family_id, relationship = EXCLUDED.relationship,
                   created_by = EXCLUDED.created_by, created_at = NOW(), expires_at = NOW() + INTERVAL '30 days'
     RETURNING *`,
    [familyId, canonical, relationship, actor]
  );
  await audit(c, familyId, 'pending_member_added', actor, null, { phone_tail: canonical.slice(-4), relationship });
  return { result: r.rows[0], notices: [] };
}

async function removePendingMember(c, { familyId, pendingId, actor }) {
  const r = await c.query(
    `DELETE FROM family_pending_members WHERE id = $1 AND family_id = $2 AND claimed_parent_id IS NULL RETURNING phone_canonical`,
    [pendingId, familyId]
  );
  if (!r.rowCount) throw new FamilyError('PENDING_NOT_FOUND', '找不到這筆預先登記', 404);
  await audit(c, familyId, 'pending_member_removed', actor, null, { phone_tail: r.rows[0].phone_canonical.slice(-4) });
  return { result: { ok: true }, notices: [] };
}

// 註冊完成後呼叫：手機命中未過期的預先登記 → 自動加入；新帳號名下與家中孩子同一人的，依 §9 處理
async function claimPendingForParent(c, { parentId, phone }) {
  const canonical = normalizePhone(phone);
  if (!canonical) return null;
  const p = await c.query(
    `SELECT * FROM family_pending_members
      WHERE phone_canonical = $1 AND claimed_parent_id IS NULL AND expires_at > NOW()
      FOR UPDATE`,
    [canonical]
  );
  if (!p.rowCount) return null;
  const pending = p.rows[0];
  const actor = `system:pending:${pending.created_by || 'counter'}`;
  if (await activeMembership(c, parentId, { lock: true })) return null;
  const family = await lockFamily(c, pending.family_id);
  if (family.status !== 'active') return null;
  const added = await addMember(c, { familyId: pending.family_id, parentId, relationship: pending.relationship, actor });
  await c.query(
    `UPDATE family_pending_members SET claimed_parent_id = $2, claimed_at = NOW() WHERE id = $1`,
    [pending.id, parentId]
  );
  // 新帳號名下的孩子如果跟家裡孩子同一人（同身分證），依 §9 處理
  const dups = await c.query(
    `SELECT mine.id AS mine_id, other.id AS other_id
       FROM students mine
       JOIN students other ON other.id_number = mine.id_number AND other.parent_id <> mine.parent_id
       JOIN family_members fm ON fm.parent_id = other.parent_id AND fm.family_id = $2 AND fm.status = 'active'
      WHERE mine.parent_id = $1 AND COALESCE(mine.is_active, TRUE) AND COALESCE(other.is_active, TRUE)
        AND NULLIF(mine.id_number, '') IS NOT NULL`,
    [parentId, pending.family_id]
  );
  const decisions = [];
  for (const d of dups.rows) {
    decisions.push(await applyDuplicateRule(c, {
      a: await studentCopy(c, d.other_id), b: await studentCopy(c, d.mine_id),
      familyId: pending.family_id, actor, actorRole: 'system',
    }));
  }
  return { result: { family_id: pending.family_id, decisions }, notices: added.notices };
}

module.exports = {
  FamilyError,
  createFamily,
  addMember,
  setRelationship,
  revokeMember,
  transferOwner,
  setFrozen,
  approveRequest,
  rejectRequest,
  applySuggestion,
  addPendingMember,
  removePendingMember,
  claimPendingForParent,
  activeMembership,
  // 測試用
  _applyDuplicateRule: applyDuplicateRule,
};
