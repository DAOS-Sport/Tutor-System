/**
 * 權限變更紀錄（角色權限 B 期）。
 *
 * role_permissions 與 user_permission_overrides 存檔都是「整組刪掉再寫入」，
 * 原本只留下最後一次是誰改的。「誰在什麼時候把退款頁開給某人」查不到，
 * 出事時也無從還原。這裡在同一個交易裡多寫一筆差異，只增不改。
 *
 * 只記有差異的存檔：按了儲存但什麼都沒改，不留一筆空紀錄。
 */
'use strict';

const { pool } = require('../models/db');

const TARGET_TYPES = Object.freeze(['role', 'user', 'staff_roles']);

/** 統一操作者格式。舊呼叫端傳字串（名字），新的傳 req.adminUser。 */
function actorOf(actor) {
  if (!actor) return { id: null, name: 'system' };
  if (typeof actor === 'string') return { id: null, name: actor };
  return {
    id: actor.sub != null ? String(actor.sub) : (actor.id != null ? String(actor.id) : null),
    name: actor.name || actor.username || 'admin',
  };
}

/**
 * 兩份「key → 值」比對出差異。值為 undefined 表示沒有這一項。
 * 回 [{ key, from, to }]，依 key 排序，方便畫面與測試比對。
 */
function diff(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];
  for (const key of [...keys].sort()) {
    const from = before && Object.prototype.hasOwnProperty.call(before, key) ? before[key] : null;
    const to = after && Object.prototype.hasOwnProperty.call(after, key) ? after[key] : null;
    if (from !== to) out.push({ key, from, to });
  }
  return out;
}

/** 一組 key 轉成 { key: true }，給 diff 用。 */
function setToMap(keys) {
  const m = {};
  for (const k of keys || []) m[k] = true;
  return m;
}

/**
 * 寫一筆紀錄。必須傳入交易中的 client —— 權限改了、紀錄沒寫進去，
 * 或紀錄寫了、權限卻回滾，兩種都會讓紀錄失去可信度。
 */
async function record(client, { actor, targetType, targetId, targetLabel = null, changes }) {
  if (!TARGET_TYPES.includes(targetType)) throw new Error(`permissionAudit: 未知的對象類型 ${targetType}`);
  if (!changes || !changes.length) return false;
  const a = actorOf(actor);
  await client.query(
    `INSERT INTO permission_audit_log (actor_id, actor_name, target_type, target_id, target_label, changes)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [a.id, a.name, targetType, String(targetId), targetLabel, JSON.stringify(changes)]
  );
  return true;
}

/** 最新的在前。給「角色權限管理 → 變更紀錄」分頁。 */
async function list({ limit = 50, offset = 0, targetType = null, targetId = null } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const args = [];
  const where = [];
  if (targetType) { args.push(String(targetType)); where.push(`target_type = $${args.length}`); }
  if (targetId) { args.push(String(targetId)); where.push(`target_id = $${args.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await pool.query(`SELECT count(*)::int AS n FROM permission_audit_log ${w}`, args);
  args.push(lim, off);
  const r = await pool.query(
    `SELECT id, created_at, actor_id, actor_name, target_type, target_id, target_label, changes
       FROM permission_audit_log ${w}
      ORDER BY created_at DESC, id DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );
  return { total: total.rows[0].n, rows: r.rows };
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS permission_audit_log (
    id           BIGSERIAL PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_id     TEXT,
    actor_name   TEXT NOT NULL,
    target_type  TEXT NOT NULL CHECK (target_type IN ('role', 'user', 'staff_roles')),
    target_id    TEXT NOT NULL,
    target_label TEXT,
    changes      JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_permission_audit_created ON permission_audit_log (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_permission_audit_target ON permission_audit_log (target_type, target_id);
`;

module.exports = { record, list, diff, setToMap, actorOf, TARGET_TYPES, SCHEMA_SQL };
