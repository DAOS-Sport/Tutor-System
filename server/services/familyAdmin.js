/**
 * 家庭帳號的寫入動作（規格 docs/family_accounts_spec_2026-09-23.md §7、§9、§14、第二階段）。
 *
 * 每個動作都在呼叫端給的交易 client 裡跑，並寫 family_audit_logs；回傳 { result, notices }，
 * notices 由路由在 COMMIT 之後送 LINE（best-effort，失敗不影響已落地的資料）。
 *
 * 原則（§14）：一個孩子只有一份資料、掛在 Ragic 上的家長底下；其他家人一律透過家庭、由櫃台核准。
 * 重複學員的處理一律走 familyRules.resolveDuplicate：保留 Ragic 那份、絕不搬課程。
 *
 * 成員的唯一鍵是 LINE userId（擁有者決定，2026-09-23；跟主帳號 parents.line_uid 同一套）：
 * - 加入時記下這位家長「當下綁定的」userId（family_members.line_uid，UNIQUE）；沒綁 LINE 不能加入。
 * - 移除／退出＝解綁那個 userId：清成 NULL，稽核只記雜湊（比照 customerParents 的解除綁定）。
 *   孩子、訂單、上課紀錄都不動 —— 解綁只解除「哪一支 LINE 可以在這個家庭裡操作」。
 * - 主帳號的 LINE 被解綁或換綁後，家庭裡記的 userId 對不上 → 在家庭裡的身分自動失效
 *   （familyScope 只認對得上的）；同一支 LINE 重綁就恢復，換一支 LINE 要櫃台再「加入」一次（＝重新綁定）。
 */
const crypto = require('crypto');
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

// 成員列記的 userId 還對得上主帳號目前綁定的 LINE
async function isBoundMember(c, membership) {
  if (!membership?.line_uid) return false;
  const r = await c.query(`SELECT 1 FROM parents WHERE id = $1 AND line_uid = $2`, [membership.parent_id, membership.line_uid]);
  return r.rowCount > 0;
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

const LINE_UID_RE = /^U[0-9a-f]{32}$/i;
const uidHash = (uid) => crypto.createHash('sha256').update(String(uid)).digest('hex');

// 這位家長目前綁定的 LINE userId；沒綁（或是 demo 哨兵值）就不能加入家庭
function boundLineUid(parent) {
  const uid = String(parent?.line_uid || '');
  if (!LINE_UID_RE.test(uid)) {
    throw new FamilyError('LINE_NOT_BOUND', `${parent?.name || '這位家長'}還沒綁定 LINE，請先完成 LINE 綁定再加入家庭`);
  }
  return uid;
}

// family_members.line_uid 是 UNIQUE：同一支 LINE 已經綁在別的家庭就擋下
async function insertMember(c, { familyId, parentId, role, relationship, actor, uid }) {
  await c.query('SAVEPOINT family_member_insert');
  try {
    await c.query(
      `INSERT INTO family_members (family_id, parent_id, line_uid, role, status, relationship, linked_by, linked_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, NOW())`,
      [familyId, parentId, uid, role, relationship, actor]
    );
    await c.query('RELEASE SAVEPOINT family_member_insert');
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT family_member_insert').catch(() => {});
    if (err.code === '23505') throw new FamilyError('LINE_IN_OTHER_FAMILY', '這個 LINE 帳號已經綁定在另一個家庭，請先解綁');
    throw err;
  }
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
  const uid = boundLineUid(owner);
  if (await activeMembership(c, ownerParentId, { lock: true })) {
    throw new FamilyError('ALREADY_IN_FAMILY', '這位家長已經在另一個家庭裡，請先移出');
  }
  const f = await c.query(
    `INSERT INTO families (owner_parent_id, name, created_by, status) VALUES ($1, $2, $3, 'active') RETURNING *`,
    [ownerParentId, name, actor]
  );
  const family = f.rows[0];
  await insertMember(c, { familyId: family.id, parentId: ownerParentId, role: 'owner', relationship: ownerRelationship, actor, uid });
  const auditId = await audit(c, family.id, 'family_created', actor, ownerParentId, { owner_relationship: ownerRelationship });
  return {
    result: family,
    notices: [parentNotice(ownerParentId,
      `櫃台已為您建立「家庭」。之後加入的家人可以一起查看孩子的課程、幫忙繳費與簽到。`,
      `fam:${auditId}:${ownerParentId}`)],
    owner,
  };
}

// ── 準備中的家庭（擁有者 2026-09-23）──────────────────────────────────────
// 還沒有家庭的家長按「邀請家人加入」時，只先建一個「沒有成員的家庭」放連結；有人用連結加入時才正式成立，
// 邀請人當擁有者。只按了按鈕不會變成一人家庭 —— 擁有者不能自己退出，一人家庭會讓他之後加入不了配偶的家庭。
// 準備中的家庭沒有任何 active 成員，所以家長端、後台、資料範圍都看不到它（都從成員資格找家庭）。
async function pendingFamilyOf(c, parentId, { create = false, actor = null } = {}) {
  if (create) await c.query(`SELECT pg_advisory_xact_lock(hashtext('family_pending:' || $1))`, [String(parentId)]);
  const r = await c.query(
    `SELECT f.id FROM families f
      WHERE f.owner_parent_id = $1 AND f.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM family_members m WHERE m.family_id = f.id AND m.status = 'active')
      ORDER BY f.created_at DESC LIMIT 1`,
    [parentId]
  );
  if (r.rowCount || !create) return r.rows[0]?.id || null;
  const f = await c.query(
    `INSERT INTO families (owner_parent_id, created_by, status) VALUES ($1, $2, 'active') RETURNING id`,
    [parentId, actor]
  );
  await audit(c, f.rows[0].id, 'family_prepared', actor, parentId, {});
  return f.rows[0].id;
}

// 準備中的家庭正式成立：邀請人（families.owner_parent_id）以他目前的 LINE 成為擁有者
async function activatePendingFamily(c, family, { actor, ownerRelationship = null }) {
  if (ownerRelationship) requireRelationship(ownerRelationship, '擁有者的關係');
  const ownerId = family.owner_parent_id;
  if (!ownerId) throw new FamilyError('INVITE_INVALID', '邀請連結無效，請向邀請您的家人或櫃台索取新的連結', 404);
  if (await activeMembership(c, ownerId, { lock: true })) {
    throw new FamilyError('ALREADY_IN_FAMILY', '這位家長已經在另一個家庭裡，請先移出');
  }
  const uid = boundLineUid(await loadParent(c, ownerId));
  await insertMember(c, { familyId: family.id, parentId: ownerId, role: 'owner', relationship: ownerRelationship, actor, uid });
  await audit(c, family.id, 'family_created', actor, ownerId, { owner_relationship: ownerRelationship, via: 'pending' });
}

// 這位家長所在的家庭；還沒有的話，先用他準備中的家庭（有邀請連結在等），都沒有才新建 —— 他當擁有者。
// 核准申請、新增學員綁定、櫃台添加成員、家庭建議都走這裡，免得同一個人同時有準備中和正式兩個家庭。
async function familyIdForParent(c, parentId, { actor, ownerRelationship = null } = {}) {
  const m = await activeMembership(c, parentId, { lock: true });
  if (m) return m.family_id;
  const pendingId = await pendingFamilyOf(c, parentId);
  if (pendingId) {
    await activatePendingFamily(c, await lockFamily(c, pendingId), { actor, ownerRelationship });
    return pendingId;
  }
  return (await createFamily(c, { ownerParentId: parentId, ownerRelationship, actor })).result.id;
}

async function addMember(c, { familyId, parentId, relationship, actor }) {
  // 關係選填（櫃台用手機＋姓名加成員時不問關係，之後可以在成員列表補）；有填就要是合法值
  relationship = relationship || null;
  if (relationship) requireRelationship(relationship);
  const family = await lockFamily(c, familyId);
  if (family.status !== 'active') throw new FamilyError('FAMILY_FROZEN', '這個家庭目前停用中，請聯絡櫃台');
  const parent = await loadParent(c, parentId);
  const uid = boundLineUid(parent);
  const existing = await activeMembership(c, parentId, { lock: true });
  if (existing && existing.family_id !== familyId) throw new FamilyError('ALREADY_IN_FAMILY', '這位家長已經在另一個家庭裡，請先移出');
  if (existing && existing.line_uid === uid) throw new FamilyError('ALREADY_MEMBER', '這位家長已經是這個家庭的成員');
  if (existing) {
    // 已是成員，但主帳號換了 LINE：櫃台再加一次＝重新綁定到目前這支 LINE
    await c.query(`UPDATE family_members SET line_uid = $2, linked_by = $3, linked_at = NOW() WHERE id = $1`, [existing.id, uid, actor]);
    await audit(c, familyId, 'member_rebound', actor, parentId, {
      old_uid_hash: existing.line_uid ? uidHash(existing.line_uid) : null, new_uid_hash: uidHash(uid),
    });
    return { result: { family_id: familyId, parent_id: parentId, rebound: true }, notices: [] };
  }
  await insertMember(c, { familyId, parentId, role: 'member', relationship, actor, uid });
  const auditId = await audit(c, familyId, 'member_added', actor, parentId, { relationship, uid_hash: uidHash(uid) });
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

// by：'counter'（櫃台）、'owner'（擁有者在個人頁解綁加入的家人）、'self'（成員自己退出）。
// 擁有者（原本辦理學員的那位）不能被解綁，只能編輯（擁有者 2026-09-23）。
async function revokeMember(c, { familyId, parentId, actor, reason = null, self = false, by = self ? 'self' : 'counter' }) {
  await lockFamily(c, familyId);
  const m = await c.query(
    `SELECT role, line_uid FROM family_members WHERE family_id = $1 AND parent_id = $2 AND status = 'active' FOR UPDATE`,
    [familyId, parentId]
  );
  if (!m.rowCount) throw new FamilyError('MEMBER_NOT_FOUND', '這位家長不在這個家庭裡', 404);
  if (m.rows[0].role === 'owner') {
    throw new FamilyError('OWNER_CANNOT_LEAVE', by === 'self'
      ? '擁有者不能自己退出，請聯絡櫃台'
      : '擁有者不能解綁，只能編輯');
  }
  const parent = await loadParent(c, parentId);
  // 解綁 userId：清成 NULL（UNIQUE 才放得開，之後可以加入別的家庭），稽核只留雜湊
  await c.query(
    `UPDATE family_members SET status = 'revoked', line_uid = NULL, revoked_by = $3, revoked_at = NOW(), note = COALESCE($4, note)
      WHERE family_id = $1 AND parent_id = $2 AND status = 'active'`,
    [familyId, parentId, actor, reason]
  );
  const action = { self: 'member_left', owner: 'member_revoked_by_owner' }[by] || 'member_revoked';
  const auditId = await audit(c, familyId, action, actor, parentId, {
    reason, uid_hash: m.rows[0].line_uid ? uidHash(m.rows[0].line_uid) : null,
  });
  const how = { self: '退出', owner: '被擁有者解綁，離開' }[by] || '被櫃台移出';
  return {
    result: { ok: true },
    notices: [
      familyNotice(familyId, `${parent.name || '一位家人'}已${how}您的家庭，之後不能再查看家中孩子的課程。如有疑問請聯絡櫃台。`, `fam:${auditId}`),
      parentNotice(parentId, {
        self: '您已退出家庭。',
        owner: '您已被家庭擁有者解綁，之後只看得到自己名下的資料。如有疑問請聯絡擁有者或櫃台。',
      }[by] || '您已被移出家庭，如有疑問請聯絡櫃台。', `fam:${auditId}:${parentId}`),
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


// 「這份資料身上有沒有課」（§9 的 periods）：已開通的課期，加上還沒開通的訂單（對帳時會依
// student_ids 綁到這份）與沒取消的團購。只看課期的話，有未對帳訂單的那份會被停用，對帳後課就
// 掛在停用的資料上。後台預覽（建議清單、申請清單）也用這段，預覽和實際處理才不會說法不一。
// alias 只接程式內的固定字串。
function courseLoadSql(alias) {
  return `((SELECT COUNT(*)::int FROM course_period_enrollments e WHERE e.student_id = ${alias}.id)
     + (SELECT COUNT(*)::int FROM admin_enrollments ae
         WHERE ${alias}.id = ANY(ae.student_ids) AND ae.status NOT IN ('cancelled','refunded'))
     + (SELECT COUNT(*)::int FROM group_order_members gm
          JOIN group_orders go ON go.id = gm.group_order_id
         WHERE ${alias}.id = ANY(gm.student_ids) AND go.status <> 'cancelled'))`;
}

async function studentCopy(c, studentId) {
  const r = await c.query(
    `SELECT s.id, s.parent_id, s.name, s.is_active, (s.ragic_record_id IS NOT NULL) AS in_ragic,
            ${courseLoadSql('s')} AS periods
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

  const familyId = await familyIdForParent(c, target.parentId, { actor });
  const applicantMembership = await activeMembership(c, req.applicant_parent_id, { lock: true });
  if (applicantMembership && applicantMembership.family_id !== familyId) {
    throw new FamilyError('ALREADY_IN_FAMILY', '申請人已經在另一個家庭裡，請先移出再核准');
  }
  if (!applicantMembership || !(await isBoundMember(c, applicantMembership))) {
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
  // 申請人名下「其他」跟家人重複的孩子也一起依 §9 處理（跟邀請加入一致；例：爸爸申請的是予澄，
  // 他名下還有一份生日打錯的宇弘）。上面處理過的那份已經停用，這裡不會再算一次。
  const others = await resolveNewMemberDuplicates(c, { parentId: req.applicant_parent_id, familyId, actor });
  await c.query(
    `UPDATE family_join_requests SET status = 'approved', reviewed_by = $2, reviewed_at = NOW() WHERE id = $1`,
    [requestId, actor]
  );
  const auditId = await audit(c, familyId, 'request_approved', actor, req.applicant_parent_id, { request_id: requestId, duplicate, others });
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
  const familyId = await familyIdForParent(c, ownerId, { actor, ownerRelationship });
  const memberMembership = await activeMembership(c, memberId, { lock: true });
  if (memberMembership && memberMembership.family_id !== familyId) {
    throw new FamilyError('ALREADY_IN_FAMILY', '另一位家長已經在別的家庭裡，請先移出');
  }
  if (!memberMembership || !(await isBoundMember(c, memberMembership))) {
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
  if (family.status !== 'active') throw new FamilyError('FAMILY_FROZEN', '這個家庭目前停用中，請聯絡櫃台');
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

// 預先登記的認領（A 最簡單版，擁有者 2026-09-23 定案）：
//   手機命中未過期的預先登記，而且這位家長名下有一位孩子的「身分證＋生日」跟家裡某位孩子相同，才加入。
//   註冊本來就要填孩子（含身分證、生日），所以通常不用多做任何事；不相符就不加入、也不另外提示，
//   要加入請走合併申請。註冊不驗證手機所有權，只憑手機加入等於知道號碼就能進別人家（櫃台打錯一碼也是）。
//   加入時綁的是這位家長目前的 LINE userId；沒綁 LINE 就先不處理（之後綁好再開個人頁會再試）。
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
  const me = await loadParent(c, parentId);
  if (!LINE_UID_RE.test(String(me.line_uid || ''))) return null;
  const proof = await c.query(
    `SELECT 1
       FROM students mine
       JOIN students other
         ON UPPER(other.id_number) = UPPER(mine.id_number)
        AND other.birth_date = mine.birth_date
        AND other.parent_id <> mine.parent_id
        AND COALESCE(other.is_active, TRUE)
       JOIN family_members fm ON fm.parent_id = other.parent_id AND fm.family_id = $2 AND fm.status = 'active'
      WHERE mine.parent_id = $1 AND COALESCE(mine.is_active, TRUE)
        AND NULLIF(mine.id_number, '') IS NOT NULL AND mine.birth_date IS NOT NULL
      LIMIT 1`,
    [parentId, pending.family_id]
  );
  if (!proof.rowCount) return null;
  const added = await addMember(c, { familyId: pending.family_id, parentId, relationship: pending.relationship, actor });
  await c.query(
    `UPDATE family_pending_members SET claimed_parent_id = $2, claimed_at = NOW() WHERE id = $1`,
    [pending.id, parentId]
  );
  const decisions = await resolveNewMemberDuplicates(c, { parentId, familyId: pending.family_id, actor });
  return { result: { family_id: pending.family_id, decisions }, notices: added.notices };
}

// 新成員名下的孩子如果跟家裡孩子同一人（同身分證），依 §9 處理（預先登記認領、邀請連結共用）
// 新增學員時，身分證＋姓名都對得上別的帳號的孩子（擁有者 2026-09-23：「有打學生姓名跟身分證字號就好，就給過，
// 不然他一直卡住」）→ 直接加入那位孩子所在的家庭；還沒有家庭就以孩子的家長為擁有者建立。
// 不另建一份學員、不碰 Ragic；新成員名下重複的孩子依 §9 處理。
async function linkByStudent(c, { parentId, studentId, actor }) {
  const target = await studentCopy(c, studentId);
  if (!target || !target.active) throw new FamilyError('TARGET_GONE', '這位孩子的資料已停用，請聯絡櫃台', 409);
  // 建立家庭的通知是「櫃台已為您建立」，這裡不適用；對方會收到「某某已加入您的家庭」
  const familyId = await familyIdForParent(c, target.parentId, { actor });
  const added = await addMember(c, { familyId, parentId, relationship: null, actor });
  const decisions = await resolveNewMemberDuplicates(c, { parentId, familyId, actor });
  await audit(c, familyId, 'member_linked_by_student', actor, parentId, { student_id: studentId, decisions });
  return { result: { family_id: familyId, owner_parent_id: target.parentId, decisions }, notices: added.notices };
}

async function resolveNewMemberDuplicates(c, { parentId, familyId, actor }) {
  const dups = await c.query(
    `SELECT mine.id AS mine_id, other.id AS other_id
       FROM students mine
       JOIN students other ON other.id_number = mine.id_number AND other.parent_id <> mine.parent_id
       JOIN family_members fm ON fm.parent_id = other.parent_id AND fm.family_id = $2 AND fm.status = 'active'
      WHERE mine.parent_id = $1 AND COALESCE(mine.is_active, TRUE) AND COALESCE(other.is_active, TRUE)
        AND NULLIF(mine.id_number, '') IS NOT NULL`,
    [parentId, familyId]
  );
  const decisions = [];
  for (const d of dups.rows) {
    decisions.push(await applyDuplicateRule(c, {
      a: await studentCopy(c, d.other_id), b: await studentCopy(c, d.mine_id),
      familyId, actor, actorRole: 'system',
    }));
  }
  return decisions;
}

// ── 邀請連結（擁有者 2026-09-23）──────────────────────────────────────────
// 櫃台產生、傳給家人；家人用 LINE 打開、登入後按「加入家庭」→ 綁定他當下的 LINE userId。
// 只能用一次、7 天有效、櫃台可作廢。連結等同鑰匙，所以一定單次、會過期，加入後通知全家。
// 邀請連結網址：家長端 LIFF 網址（跟推播連結同一個來源）＋ /family/join/<token>；
// 沒設定 LIFF 網址時回相對路徑，畫面自己補網域。後台與家長端共用。
function inviteUrl(token) {
  const base = String(process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}/family/join/${token}` : `/liff/family/join/${token}`;
}
function shapeInvite(row) {
  return {
    id: row.id, url: inviteUrl(row.token), relationship: row.relationship,
    relationship_label: row.relationship ? relationshipLabel(row.relationship) : null,
    created_at: row.created_at, expires_at: row.expires_at, created_by: row.created_by,
  };
}
// 一個家庭同時最多幾條還能用的連結（防止濫發；用掉、作廢、過期的不算）
const MAX_OPEN_INVITES = 5;

async function createInvite(c, { familyId, relationship = null, actor }) {
  relationship = relationship || null;
  if (relationship) requireRelationship(relationship);
  const family = await lockFamily(c, familyId);
  if (family.status !== 'active') throw new FamilyError('FAMILY_FROZEN', '這個家庭目前停用中，請聯絡櫃台');
  const open = await c.query(
    `SELECT COUNT(*)::int AS n FROM family_invites
      WHERE family_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    [familyId]
  );
  if (open.rows[0].n >= MAX_OPEN_INVITES) {
    throw new FamilyError('INVITE_LIMIT', `這個家庭已經有 ${MAX_OPEN_INVITES} 條還沒用的邀請連結，請先作廢不用的再產生`, 429);
  }
  const token = crypto.randomBytes(16).toString('hex');
  const r = await c.query(
    `INSERT INTO family_invites (family_id, token, relationship, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [familyId, token, relationship, actor]
  );
  await audit(c, familyId, 'invite_created', actor, null, { invite_id: r.rows[0].id, relationship });
  return { result: r.rows[0], notices: [] };
}

async function revokeInvite(c, { familyId, inviteId, actor }) {
  const r = await c.query(
    `UPDATE family_invites SET revoked_at = NOW(), revoked_by = $3
      WHERE id = $1 AND family_id = $2 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,
    [inviteId, familyId, actor]
  );
  if (!r.rowCount) throw new FamilyError('INVITE_NOT_FOUND', '找不到這個邀請，或已經使用／作廢', 404);
  await audit(c, familyId, 'invite_revoked', actor, null, { invite_id: inviteId });
  return { result: { ok: true }, notices: [] };
}

// 邀請目前能不能用；不能用時回原因（給預覽頁與加入時共用）
function inviteProblem(inv) {
  if (!inv) return new FamilyError('INVITE_INVALID', '邀請連結無效，請向邀請您的家人或櫃台索取新的連結', 404);
  if (inv.revoked_at) return new FamilyError('INVITE_REVOKED', '這個邀請連結已經作廢，請向邀請您的家人或櫃台索取新的連結', 410);
  if (inv.used_at) return new FamilyError('INVITE_USED', '這個邀請連結已經有人用過了，請向邀請您的家人或櫃台索取新的連結', 410);
  if (new Date(inv.expires_at).getTime() < Date.now()) return new FamilyError('INVITE_EXPIRED', '這個邀請連結已經過期，請向邀請您的家人或櫃台索取新的連結', 410);
  return null;
}

async function acceptInvite(c, { token, parentId, relationship = null }) {
  const r = await c.query(`SELECT * FROM family_invites WHERE token = $1 FOR UPDATE`, [String(token || '')]);
  const inv = r.rows[0] || null;
  const problem = inviteProblem(inv);
  if (problem) throw problem;
  const actor = `parent:${parentId}:invite`;
  const family = await lockFamily(c, inv.family_id);
  if (String(family.owner_parent_id) === String(parentId)) {
    throw new FamilyError('INVITE_SELF', '這是您自己產生的邀請連結，請傳給家人使用', 409);
  }
  const active = await c.query(`SELECT 1 FROM family_members WHERE family_id = $1 AND status = 'active' LIMIT 1`, [family.id]);
  if (!active.rowCount) {
    // 準備中的家庭（邀請人當時還沒有家庭）→ 第一位家人加入時成立，邀請人當擁有者
    try {
      await activatePendingFamily(c, family, { actor });
    } catch (err) {
      if (!(err instanceof FamilyError)) throw err;
      throw new FamilyError('INVITE_OWNER_UNAVAILABLE', err.code === 'ALREADY_IN_FAMILY'
        ? '邀請您的家人已經加入別的家庭，這個連結不能用了，請向他索取新的連結'
        : '邀請您的家人目前無法使用家庭功能（LINE 綁定失效），請他重新登入後再產生新的連結', 410);
    }
  }
  const added = await addMember(c, {
    familyId: inv.family_id, parentId, relationship: relationship || inv.relationship || null, actor,
  });
  await c.query(`UPDATE family_invites SET used_by_parent_id = $2, used_at = NOW() WHERE id = $1`, [inv.id, parentId]);
  await audit(c, inv.family_id, 'invite_accepted', actor, parentId, { invite_id: inv.id });
  const decisions = await resolveNewMemberDuplicates(c, { parentId, familyId: inv.family_id, actor });
  return { result: { family_id: inv.family_id, decisions }, notices: added.notices };
}

module.exports = {
  courseLoadSql,
  FamilyError,
  createFamily,
  addMember,
  setRelationship,
  revokeMember,
  transferOwner,
  approveRequest,
  rejectRequest,
  applySuggestion,
  addPendingMember,
  removePendingMember,
  claimPendingForParent,
  activeMembership,
  pendingFamilyOf,
  familyIdForParent,
  resolveNewMemberDuplicates,
  linkByStudent,
  createInvite,
  revokeInvite,
  acceptInvite,
  inviteProblem,
  inviteUrl,
  shapeInvite,
  MAX_OPEN_INVITES,
  // 測試用
  _applyDuplicateRule: applyDuplicateRule,
};
