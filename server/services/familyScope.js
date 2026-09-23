/**
 * 家庭帳號：這位家長可以代為操作哪些家長的資料（規格 docs/family_accounts_spec_2026-09-23.md §4）。
 *
 * - 開關 FAMILY_ACCOUNTS_V1（services/featureFlags：環境變數或 application_feature_flags，
 *   可以只開給指定手機試點）。沒設定＝關閉＝回到「只有自己」的原本行為。
 * - 每個請求即時查，不寫進 JWT：櫃台移除成員或凍結家庭，下一個請求就生效。
 * - 家庭被凍結時，所有成員（含擁有者）都只剩自己。
 *
 * 路由改動一律透過這裡，不在各處自己拼 family 的 SQL。
 */
const { pool } = require('../models/db');
const { getFeatureFlag, flagAllowsPhone } = require('./featureFlags');

const FLAG_KEY = 'FAMILY_ACCOUNTS_V1';

async function isEnabledFor(parent, db = pool) {
  if (!parent?.id) return false;
  const flag = await getFeatureFlag(FLAG_KEY, db);
  return flagAllowsPhone(flag, parent.phone);
}

// 這位家長目前所屬的家庭（只看 active 成員資格）；沒有回 null
async function familyOf(parentId, db = pool) {
  const r = await db.query(
    `SELECT fm.family_id, fm.role, fm.relationship,
            f.status AS family_status, f.owner_parent_id, f.name AS family_name
       FROM family_members fm
       JOIN families f ON f.id = fm.family_id
      WHERE fm.parent_id = $1 AND fm.status = 'active'
      LIMIT 1`,
    [parentId]
  );
  return r.rows[0] || null;
}

/**
 * @returns {{ enabled: boolean, family: object|null, parentIds: string[], phones: string[] }}
 *   parentIds／phones 一定包含本人；有家庭（且未凍結、開關有開）時再加上同家庭的 active 成員。
 */
async function scopeFor(parent, db = pool) {
  const self = {
    enabled: false,
    family: null,
    parentIds: parent?.id ? [parent.id] : [],
    phones: parent?.phone ? [parent.phone] : [],
  };
  if (!(await isEnabledFor(parent, db))) return self;
  const family = await familyOf(parent.id, db);
  if (!family || family.family_status !== 'active') return { ...self, enabled: true, family };
  const r = await db.query(
    `SELECT p.id, p.phone
       FROM family_members fm
       JOIN parents p ON p.id = fm.parent_id
      WHERE fm.family_id = $1 AND fm.status = 'active'`,
    [family.family_id]
  );
  const parentIds = [...new Set([parent.id, ...r.rows.map((row) => row.id)])];
  const phones = [...new Set([parent.phone, ...r.rows.map((row) => row.phone)].filter(Boolean))];
  return { enabled: true, family, parentIds, phones };
}

// 同一個請求只算一次（路由裡多處呼叫也只查一次 DB）
function forRequest(req, db = pool) {
  if (!req._familyScopePromise) req._familyScopePromise = scopeFor(req.parent, db);
  return req._familyScopePromise;
}

async function actingParentIds(req, db = pool) {
  return (await forRequest(req, db)).parentIds;
}

async function actingPhones(req, db = pool) {
  return (await forRequest(req, db)).phones;
}

// 擁有者判斷（取消訂單等「購買人或擁有者」的動作用）
async function isFamilyOwner(req, db = pool) {
  const scope = await forRequest(req, db);
  return !!(scope.family && scope.family.family_status === 'active' && scope.family.role === 'owner');
}

/**
 * 通知收件人擴大到全家（規格 §6、決策 2）：給「孩子的所屬家長」id 清單，回傳
 * [{ parent_id, line_uid }]，含原本的家長，再加上他們所在家庭（未凍結）的 active 成員。
 * 開關依「收件人」的手機判斷：試點時只有名單內的家人會多收到。
 */
async function familyRecipients(parentIds, db = pool) {
  const ids = [...new Set((parentIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const base = (await db.query(
    `SELECT id AS parent_id, line_uid FROM parents WHERE id::text = ANY($1::text[])`,
    [ids]
  )).rows;
  const flag = await getFeatureFlag(FLAG_KEY, db);
  if (!flag.enabled) return base;
  const extra = (await db.query(
    `SELECT DISTINCT p.id AS parent_id, p.line_uid, p.phone
       FROM family_members fm1
       JOIN families f ON f.id = fm1.family_id AND f.status = 'active'
       JOIN family_members fm2 ON fm2.family_id = fm1.family_id AND fm2.status = 'active'
       JOIN parents p ON p.id = fm2.parent_id AND COALESCE(p.is_active, TRUE) = TRUE
      WHERE fm1.status = 'active' AND fm1.parent_id::text = ANY($1::text[])`,
    [ids]
  )).rows.filter((row) => flagAllowsPhone(flag, row.phone));
  const out = new Map(base.map((row) => [String(row.parent_id), row]));
  for (const row of extra) {
    if (!out.has(String(row.parent_id))) out.set(String(row.parent_id), { parent_id: row.parent_id, line_uid: row.line_uid });
  }
  return [...out.values()];
}

module.exports = {
  FLAG_KEY,
  isEnabledFor,
  familyOf,
  scopeFor,
  forRequest,
  actingParentIds,
  actingPhones,
  isFamilyOwner,
  familyRecipients,
};
