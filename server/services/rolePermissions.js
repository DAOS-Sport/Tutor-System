/**
 * F-A06 角色權限的唯一判定入口。
 *
 * 設計上只有三條規則，刻意不多：
 *   1. admin 永遠全開 —— 不入表、不可調整，否則有人能在畫面上把自己鎖在門外
 *   2. 有列＝允許，缺列＝拒絕（fail-closed）—— 新頁面預設對所有人關閉
 *   3. 判定結果有 15 秒快取 —— 每次選單渲染都查一次 DB 太貴，而權限改動不急著秒生效
 */
'use strict';

const { pool } = require('../models/db');
const { RESOURCE_KEYS, isResourceKey } = require('../constants/adminResources');
const { ROLES } = require('../constants/roles');

const CACHE_MS = 15_000;
let cache = null;
let cachedAt = 0;

function invalidate() { cache = null; cachedAt = 0; }

/** 回 { role: Set(resource_key) }。admin 不在裡面 —— 它走 canAccess 的捷徑。 */
async function _load() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_MS) return cache;
  const r = await pool.query('SELECT role, resource_key FROM role_permissions');
  const m = new Map();
  for (const row of r.rows) {
    if (!m.has(row.role)) m.set(row.role, new Set());
    m.get(row.role).add(row.resource_key);
  }
  cache = m;
  cachedAt = now;
  return m;
}

async function canAccess(role, resourceKey) {
  if (role === 'admin') return true;
  if (!isResourceKey(resourceKey)) return false;   // 認不得的鍵一律拒絕
  const m = await _load();
  return !!(m.get(role) && m.get(role).has(resourceKey));
}

/** 某個角色看得到的所有頁面（給選單用）。 */
async function allowedResources(role) {
  if (role === 'admin') return [...RESOURCE_KEYS];
  const m = await _load();
  const set = m.get(role);
  return set ? RESOURCE_KEYS.filter((k) => set.has(k)) : [];
}

/** 完整矩陣（給 F-A06 頁面）。admin 那一欄回全部，並標成不可編輯。 */
async function getMatrix() {
  const m = await _load();
  const out = {};
  for (const r of ROLES) {
    out[r.key] = r.key === 'admin' ? [...RESOURCE_KEYS] : [...(m.get(r.key) || [])];
  }
  return out;
}

/**
 * 覆寫某個角色的可見頁面。整組取代而非逐項增刪 ——
 * 前端送來的就是畫面上勾選的完整狀態，逐項 diff 只會多一種不同步的可能。
 */
async function setRolePermissions(role, resourceKeys, actor = 'admin') {
  if (role === 'admin') {
    const err = new Error('系統管理員的權限不可調整');
    err.code = 'ADMIN_ROLE_IMMUTABLE';
    throw err;
  }
  if (!ROLES.some((r) => r.key === role)) {
    const err = new Error(`未知的角色：${role}`);
    err.code = 'UNKNOWN_ROLE';
    throw err;
  }
  const keys = [...new Set((resourceKeys || []).map(String))];
  const bad = keys.filter((k) => !isResourceKey(k));
  if (bad.length) {
    const err = new Error(`未知的頁面代號：${bad.join('、')}`);
    err.code = 'UNKNOWN_RESOURCE';
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM role_permissions WHERE role = $1', [role]);
    if (keys.length) {
      const values = keys.map((_, i) => `($1, $${i + 2}, $${keys.length + 2})`).join(', ');
      await client.query(
        `INSERT INTO role_permissions (role, resource_key, updated_by) VALUES ${values}`,
        [role, ...keys, actor]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  invalidate();
  return { role, count: keys.length };
}

module.exports = { canAccess, allowedResources, getMatrix, setRolePermissions, invalidate };

