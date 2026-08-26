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
let overrideCache = null;
let identityCache = null;
let cachedAt = 0;

function invalidate() { cache = null; overrideCache = null; identityCache = null; cachedAt = 0; }

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
  // 個人例外跟角色設定一起載、一起失效。分開載會出現「角色已更新、例外還是舊的」
  // 這種半新半舊的判定，而那種錯只會在特定組合下出現，極難重現。
  const o = await pool.query('SELECT user_id, resource_key, allowed FROM user_permission_overrides');
  const om = new Map();
  for (const row of o.rows) {
    if (!om.has(row.user_id)) om.set(row.user_id, new Map());
    om.get(row.user_id).set(row.resource_key, !!row.allowed);
  }
  // 一個人可以同時是好幾種身分：教練兼救生員、櫃檯兼救生員、主管兼櫃檯。
  // admin_staff.role 只存得下「優先序最高的那一個」，其餘身分在 is_coach /
  // is_counter / is_lifeguard 這三個旗標裡。
  //
  // 權限必須取聯集，不能只看 role —— 否則把「簽到驗證」開給救生員之後，
  // 14 位教練兼救生員仍然看不到，因為他們的 role 是 coach。
  // 而那種錯不會有人回報成 bug，只會變成「這個系統怪怪的」。
  const idq = await pool.query(`
    SELECT u.id AS user_id, s.role, s.is_counter, s.is_coach, s.is_lifeguard
      FROM admin_users u
      JOIN admin_staff s ON s.id = u.staff_id`);
  const im = new Map();
  for (const row of idq.rows) {
    const set = new Set();
    if (row.role) set.add(row.role);
    if (row.is_counter) set.add('staff');
    if (row.is_coach) set.add('coach');
    if (row.is_lifeguard) set.add('lifeguard');
    im.set(String(row.user_id), set);
  }

  cache = m;
  overrideCache = om;
  identityCache = im;
  cachedAt = now;
  return m;
}

/**
 * 這個登入帳號的全部身分。
 *
 * 查不到就退回 token 上的單一角色 —— 有些帳號沒有連到 admin_staff
 * （內建的系統帳號、測試帳號）。那種情況沿用舊行為，不會突然少掉權限。
 */
async function _rolesOf(user) {
  await _load();
  const fromDb = user && user.userId && identityCache.get(String(user.userId));
  if (fromDb && fromDb.size) return fromDb;
  return new Set(user && user.role ? [user.role] : []);
}

/** 某個登入帳號的例外：Map(resource_key → boolean)。 */
async function _overridesFor(userId) {
  await _load();
  return (userId && overrideCache.get(String(userId))) || new Map();
}

async function canAccess(role, resourceKey) {
  if (role === 'admin') return true;
  if (!isResourceKey(resourceKey)) return false;   // 認不得的鍵一律拒絕
  const m = await _load();
  return !!(m.get(role) && m.get(role).has(resourceKey));
}

/**
 * 含個人例外的判定。這是後端閘門實際使用的入口。
 *
 * 順序：admin 全開 → 個人例外 → 角色預設 → 拒絕。
 * 個人例外壓在角色之上是刻意的 —— 例外存在的意義就是「這個人跟他的角色不一樣」，
 * 反過來讓角色蓋掉例外的話，收回某個人的權限就永遠做不到。
 */
async function canUserAccess(user, resourceKey) {
  if (!isResourceKey(resourceKey)) return false;
  const roles = await _rolesOf(user);
  if (roles.has('admin')) return true;
  // 個人例外仍然壓在角色之上，且對整個人生效（不分身分）——
  // 「這個人不該碰退款」不會因為他多了一個身分就失效。
  const ov = await _overridesFor(user && user.userId);
  if (ov.has(resourceKey)) return ov.get(resourceKey);
  for (const r of roles) {
    if (await canAccess(r, resourceKey)) return true;
  }
  return false;
}

/** 某個登入帳號實際看得到的頁面（角色預設套上個人例外）。 */
async function effectiveResources(user) {
  const roles = await _rolesOf(user);
  if (roles.has('admin')) return [...RESOURCE_KEYS];
  const ov = await _overridesFor(user && user.userId);
  const base = new Set();
  for (const r of roles) for (const k of await allowedResources(r)) base.add(k);
  for (const [k, allowed] of ov) {
    if (allowed) base.add(k); else base.delete(k);
  }
  return RESOURCE_KEYS.filter((k) => base.has(k));
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

/** 某個登入帳號目前設定的例外（給後台編輯用）。 */
async function getUserOverrides(userId) {
  const ov = await _overridesFor(userId);
  return Object.fromEntries(ov);
}

/**
 * 覆寫某個登入帳號的例外。傳 { resource_key: true|false }；
 * 沒列出來的就是「沒有例外，跟著角色走」。
 */
async function setUserOverrides(userId, overrides, actor = 'admin') {
  const uid = String(userId || '').trim();
  if (!uid) {
    const err = new Error('缺少帳號代號');
    err.code = 'USER_REQUIRED';
    throw err;
  }
  const entries = Object.entries(overrides || {});
  const bad = entries.map(([k]) => k).filter((k) => !isResourceKey(k));
  if (bad.length) {
    const err = new Error(`未知的頁面代號：${bad.join('、')}`);
    err.code = 'UNKNOWN_RESOURCE';
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_permission_overrides WHERE user_id = $1', [uid]);
    if (entries.length) {
      const values = entries.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3}, $${entries.length * 2 + 2})`).join(', ');
      const args = [uid];
      for (const [k, v] of entries) args.push(k, !!v);
      args.push(actor);
      await client.query(
        `INSERT INTO user_permission_overrides (user_id, resource_key, allowed, updated_by) VALUES ${values}`,
        args
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
  return { user_id: uid, count: entries.length };
}

module.exports = {
  canAccess, canUserAccess, allowedResources, effectiveResources, rolesOf: _rolesOf,
  getMatrix, setRolePermissions, getUserOverrides, setUserOverrides, invalidate,
};

