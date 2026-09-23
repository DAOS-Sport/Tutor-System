/**
 * 家長端個人頁的「家庭」區塊（規格 docs/family_accounts_spec_2026-09-23.md §8、§14）。
 *
 * 回傳 null＝開關沒開（前端什麼都不顯示，與原本一致）；否則：
 *   {
 *     family: null | { id, name, status, role, relationship, relationship_label,
 *                      members: [{ parent_id, name, role, relationship, relationship_label, is_self }],
 *                      students: [家人名下的孩子（唯讀，不含身分證等敏感欄位）] },
 *     join_request: null | { id, status, relationship, created_at, reject_reason, target_student_name },
 *     duplicates: [{ student_id, name }]   我名下「與別的帳號同一個身分證」的孩子（不在同一家庭）→ 頂端提示申請合併
 *   }
 * 刻意不把家人的孩子混進 me.students：那份清單是「我名下、可以編輯」的孩子，混進去會讓人誤改。
 */
const { pool } = require('../models/db');
const familyScope = require('./familyScope');
const familyAdmin = require('./familyAdmin');
const familyNotify = require('./familyNotify');
const { relationshipLabel } = require('./familyRules');
const { normalizePhone } = require('./identityNormalizer');
const { formatPlainDate } = require('../utils/dateTime');

// 櫃台預先登記過這支手機（第二階段）→ 家長打開個人頁時認領（條件見 familyAdmin.claimPendingForParent）。
// 掛在這裡而不是註冊流程：註冊有十幾個成功出口（LINE、Z03 認領、Ragic 來源…），家長也可能是
// 櫃台在 Ragic 建檔後才用手機綁定登入；個人頁是每條路徑都會經過的地方。
// best-effort：失敗只記錄，不影響個人頁。
async function claimPendingOnVisit(parent, db) {
  if (typeof db.connect !== 'function') return false; // 呼叫端給的是交易中的 client：不在這裡另開交易
  const canonical = normalizePhone(parent.phone);
  if (!canonical) return false;
  const hit = await db.query(
    `SELECT 1 FROM family_pending_members
      WHERE phone_canonical = $1 AND claimed_parent_id IS NULL AND expires_at > NOW() LIMIT 1`,
    [canonical]
  );
  if (!hit.rowCount) return false;
  const c = await db.connect();
  let out = null;
  try {
    await c.query('BEGIN');
    out = await familyAdmin.claimPendingForParent(c, { parentId: parent.id, phone: parent.phone });
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.warn('[familyProfile] 預先登記認領失敗：', err.code || '', err.message);
    return false;
  } finally {
    c.release();
  }
  if (out?.notices?.length) familyNotify.sendNotices(out.notices).catch(() => {});
  return !!out;
}

async function familyBlock(parent, db = pool) {
  let scope = await familyScope.scopeFor(parent, db);
  if (!scope.enabled) return null;
  if (!scope.family && await claimPendingOnVisit(parent, db)) {
    scope = await familyScope.scopeFor(parent, db);
  }

  let family = null;
  const fam = scope.family;
  if (fam) {
    const members = await db.query(
      `SELECT fm.parent_id, p.name, fm.role, fm.relationship
         FROM family_members fm
         JOIN parents p ON p.id = fm.parent_id
        WHERE fm.family_id = $1 AND fm.status = 'active'
        ORDER BY (fm.role = 'owner') DESC, fm.linked_at ASC NULLS LAST`,
      [fam.family_id]
    );
    const otherIds = members.rows.map((m) => m.parent_id).filter((id) => String(id) !== String(parent.id));
    const kids = fam.family_status === 'active' && otherIds.length
      ? (await db.query(
        `SELECT s.id, s.name, s.birth_date, s.gender, s.parent_id
           FROM students s
          WHERE s.parent_id::text = ANY($1::text[]) AND COALESCE(s.is_active, TRUE) = TRUE
          ORDER BY s.created_at ASC`,
        [otherIds.map(String)]
      )).rows
      : [];
    const nameOf = new Map(members.rows.map((m) => [String(m.parent_id), m]));
    family = {
      id: fam.family_id,
      name: fam.family_name || null,
      status: fam.family_status,
      role: fam.role,
      relationship: fam.relationship,
      relationship_label: relationshipLabel(fam.relationship),
      members: members.rows.map((m) => ({
        parent_id: m.parent_id,
        name: m.name,
        role: m.role,
        relationship: m.relationship,
        relationship_label: relationshipLabel(m.relationship),
        is_self: String(m.parent_id) === String(parent.id),
      })),
      students: kids.map((k) => {
        const owner = nameOf.get(String(k.parent_id));
        return {
          id: k.id,
          name: k.name,
          birth_date: formatPlainDate(k.birth_date),
          gender: k.gender,
          owner_parent_id: k.parent_id,
          owner_name: owner?.name || null,
          owner_relationship_label: owner ? relationshipLabel(owner.relationship) : null,
        };
      }),
    };
  }

  const jr = await db.query(
    `SELECT r.id, r.status, r.relationship, r.created_at, r.reject_reason, s.name AS target_student_name
       FROM family_join_requests r
       JOIN students s ON s.id = r.target_student_id
      WHERE r.applicant_parent_id = $1
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [parent.id]
  );
  const latest = jr.rows[0] || null;
  // 只回「審核中」或「最近 30 天被退回」的，讓家長知道結果；已核准的就是已經在家庭裡
  const joinRequest = latest && (latest.status === 'pending'
    || (latest.status === 'rejected' && Date.now() - new Date(latest.created_at).getTime() < 30 * 86400000))
    ? { ...latest, relationship_label: relationshipLabel(latest.relationship) }
    : null;

  // 我名下、跟「不在同一家庭」的別的帳號同一個身分證的孩子 → 頂端提示申請合併（§14）
  const dup = await db.query(
    `SELECT DISTINCT mine.id AS student_id, mine.name
       FROM students mine
       JOIN students other
         ON other.id_number = mine.id_number
        AND other.parent_id <> mine.parent_id
        AND COALESCE(other.is_active, TRUE) = TRUE
      WHERE mine.parent_id = $1
        AND COALESCE(mine.is_active, TRUE) = TRUE
        AND NULLIF(mine.id_number, '') IS NOT NULL
        AND NOT (other.parent_id::text = ANY($2::text[]))`,
    [parent.id, scope.parentIds.map(String)]
  );

  // 還是家庭成員，但主帳號換過 LINE（記的 userId 對不上）→ 前端請他聯絡櫃台重新綁定，不給申請表
  const rebindRequired = !scope.family && (await db.query(
    `SELECT 1 FROM family_members WHERE parent_id = $1 AND status = 'active' LIMIT 1`,
    [parent.id]
  )).rowCount > 0;

  return {
    family,
    join_request: joinRequest,
    duplicates: dup.rows,
    rebind_required: rebindRequired,
  };
}

module.exports = { familyBlock };
