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
const { ROLES, PORTAL_ADMIN_ROLES } = require('../constants/roles');

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
    SELECT u.id AS user_id, s.role, s.is_counter, s.is_coach, s.is_lifeguard,
           COALESCE(ARRAY(
             SELECT r.role FROM admin_staff_roles r WHERE r.staff_id = s.id
           ), '{}') AS manual_roles
      FROM admin_users u
      JOIN admin_staff s ON s.id = u.staff_id`);
  const im = new Map();
  for (const row of idq.rows) {
    const set = new Set();
    // Ragic 推導的身分（唯讀，來自 H01 應徵職務）
    if (row.is_counter) set.add('staff');
    if (row.is_coach) set.add('coach');
    if (row.is_lifeguard) set.add('lifeguard');
    // 後台手動指派的身分。與 Ragic 取聯集而不是取代 ——
    // Ragic 說他是救生員就是救生員，管理員只能再加，不能在這裡否認，
    // 否認了下次同步也會回來，那種「存了又變回去」最讓人不信任系統。
    for (const r of row.manual_roles || []) if (r) set.add(r);
    // admin_staff.role 是「代表值」，最後才加，而且要過濾。
    //
    // 這個欄位有 CHECK constraint、一定要有值，所以純教練與純救生員都落在
    // 保底值 'staff' —— 原本這裡是無條件 set.add(row.role)，於是那些人的
    // 身分聯集裡憑空多一個「行政櫃檯」，拿到客戶資料、對帳、退款的全部權限，
    // 而且畫面上完全看不出來（他們的徽章顯示的是救生員）。
    //
    // 判準與 auth.js 的 _usableRole、staff.js 的 rowToStaff 一致 ——
    // 三個地方各寫一套的話，同一個人在列表上、登入時、算權限時會是不同身分。
    if (row.role && (row.role === 'admin' || row.role === 'manager'
        || row.is_counter || (!row.is_coach && !row.is_lifeguard))) {
      set.add(row.role);
    }
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
  const out = new Set();
  const fromDb = user && user.userId && identityCache.get(String(user.userId));
  if (fromDb) for (const r of fromDb) out.add(r);
  // token 上的角色也算一個身分，不是「查不到才用」的後備。
  //
  // 原本是「資料庫查得到就整組取代」。於是當 admin_users.role = 'admin'
  // 但 admin_staff.role 已被改成 'manager' 時，這裡算出 {manager} ——
  // 而 requireAdminRole、getScopedVenueIds、前端 can()、RequireAuth 這四個
  // 地方全都認 token 上的 admin。症狀是：側邊選單畫出全部 34 個入口、
  // 每一頁點進去都 403，但那個人偏偏改得動角色權限設定本身。
  //
  // 這裡採用 token 是安全的：它由 auth.js 的 _effectiveLoginUser 產生，
  // 而那裡已經用 _usableRole 濾掉了保底值。
  if (user && user.role) out.add(String(user.role));
  return out;
}

/** 某個登入帳號的例外：Map(resource_key → boolean)。 */
async function _overridesFor(userId) {
  await _load();
  return (userId && overrideCache.get(String(userId))) || new Map();
}

async function canAccess(role, resourceKey) {
  if (role === 'admin') return true;
  if (!isResourceKey(resourceKey)) return false;   // 認不得的鍵一律拒絕
  // 不走後台的身分（教練）一律不發後台權限。舊資料裡可能還留著 coach 的列，
  // 那些列現在寫不進去了，但已經存在的仍會被身分聯集讀到 —— 在這裡一併擋掉，
  // 才不用去猜資料庫裡還有沒有殘留。
  if (!PORTAL_ADMIN_ROLES.includes(role)) return false;
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
  // 只列會用到後台的身分。原本走 ROLES 全集，於是矩陣多出一個 coach 欄 ——
  // API 送給前端時又把它濾掉，結果是「設定得了、看不見、卻會生效」。
  for (const key of PORTAL_ADMIN_ROLES) {
    out[key] = key === 'admin' ? [...RESOURCE_KEYS] : [...(m.get(key) || [])];
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
  // 驗證用 PORTAL_ADMIN_ROLES 而不是 ROLES 全集：畫面上沒有 coach 這一欄，
  // 但 PUT /api/admin/role-permissions/coach 原本是一支開著的 API。
  // 寫進去的列沒有任何畫面看得到、也刪不掉，卻會經由身分聯集實際發給
  // 「教練兼救生員」這種同時有後台帳號的人。
  if (!PORTAL_ADMIN_ROLES.includes(role)) {
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

