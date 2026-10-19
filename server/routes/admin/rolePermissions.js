/**
 * F-A06 角色權限管理
 *
 *   GET /api/admin/role-permissions        → 頁面清單 + 角色清單 + 完整矩陣（管理員）
 *   PUT /api/admin/role-permissions/:role  → 覆寫某角色的可見頁面（管理員）
 *   GET /api/admin/role-permissions/mine   → 目前登入者看得到哪些頁面（所有後台角色）
 *   GET /api/admin/role-permissions/audit  → 權限變更紀錄（B 期，唯讀）
 *
 * /mine 給側邊選單用。選單不再自己寫死一份 roles 陣列 —— 那份東西正是
 * 這個功能要取代的：它只控制「看不看得到」，跟後端真正的閘門是兩套，
 * 於是永遠有「藏起來但打得進去」的風險。
 */
const express = require('express');
const router = express.Router();

const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
// F-A06：權限改由「角色權限管理」的設定決定。
const { requireResource } = require('../../middlewares/requireResource');
const { ADMIN_RESOURCES, ADMIN_ACTIONS } = require('../../constants/adminResources');
const { ROLES } = require('../../constants/roles');
const { pool } = require('../../models/db');
const svc = require('../../services/rolePermissions');
const audit = require('../../services/permissionAudit');

/** 權限表的縱軸：每個頁面，後面跟著它底下的動作。 */
function permissionRows() {
  const out = [];
  for (const r of ADMIN_RESOURCES) {
    out.push({ key: r.key, group: r.group, path: r.path, label: r.label, kind: 'page' });
    for (const a of ADMIN_ACTIONS) {
      if (a.resource !== r.key) continue;
      out.push({ key: a.key, group: r.group, path: null, label: a.label, kind: 'action', parent: r.key });
    }
  }
  return out;
}

// /mine 要讓所有後台角色都打得到，否則非管理員登入後選單會是空的。
router.get('/mine', requireAdminAuth, async (req, res) => {
  try {
    const role = req.adminUser.role;
    // 回「實際生效」而不是角色預設 —— 選單要反映個人例外，
    // 否則被單獨收回權限的人仍會看到入口，點進去才吃 403。
    const who = { role, userId: req.adminUser.sub };
    const allowed = await svc.effectiveResources(who);
    // 動作（C 期）另外一欄：allowed 只放頁面，選單與「看得到幾頁」的計數才不會失真。
    const actions = await svc.effectiveActions(who);
    res.json({ role, allowed, actions });
  } catch (err) {
    console.error('[admin/role-permissions mine]', err);
    res.status(500).json({ error: '讀取權限失敗' });
  }
});

router.get('/', requireAdminAuth, requireResource('role-permissions'), async (req, res) => {
  try {
    res.json({
      // 動作（C 期）緊接在所屬頁面後面，畫面上縮排顯示在那一頁底下。
      resources: permissionRows(),
      // immutable 讓前端知道那一欄要畫成鎖住的，而不是可以勾卻存不了。
      // 只列會用到後台的身分。教練走 LIFF，列出來那一欄永遠是空的，
      // 還會讓人以為自己漏設了什麼。
      roles: ROLES.filter((r) => r.portal === 'admin').map((r) => ({
        key: r.key, label: r.label, backoffice: r.backoffice, immutable: r.key === 'admin',
      })),
      matrix: await svc.getMatrix(),
    });
  } catch (err) {
    console.error('[admin/role-permissions list]', err);
    res.status(500).json({ error: '讀取角色權限失敗' });
  }
});

// 寫入一律限管理員本人，不看設定表。
// 只用 requireResource 的話會開出一條提權路徑：管理員把這一頁勾給主管，
// 主管就能把任何權限發給自己，包含再把管理員的頁面拿走。
// 讀取（GET /）可以跟著設定走，讓被授權的人看得到現況；能改的只有管理員。
router.put('/:role', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const keys = req.body?.resource_keys;
    if (!Array.isArray(keys)) {
      return res.status(400).json({ error: 'resource_keys 必須是陣列', code: 'RESOURCE_KEYS_REQUIRED' });
    }
    // 整個 adminUser 交給 service：變更紀錄要同時記帳號代號與名字。
    const actor = req.adminUser;
    const out = await svc.setRolePermissions(req.params.role, keys, actor);
    res.json({ ok: true, ...out });
  } catch (err) {
    if (err.code === 'ADMIN_ROLE_IMMUTABLE') return res.status(409).json({ error: err.message, code: err.code });
    if (err.code === 'UNKNOWN_ROLE' || err.code === 'UNKNOWN_RESOURCE') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[admin/role-permissions put]', err);
    res.status(500).json({ error: '更新角色權限失敗' });
  }
});

// ── 第二層：個別人員例外 ─────────────────────────────────────────────────
//
// 只列「有後台登入帳號」的人。員工有四百多位，但能登入的十幾個 ——
// 沒有帳號的人沒有權限可談，列出來只會讓這張表難用。
router.get('/users', requireAdminAuth, requireResource('role-permissions'), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.id, u.username, COALESCE(NULLIF(u.name,''), s.name, u.username) AS name,
             u.role, u.is_active, s.id AS staff_id,
             (SELECT count(*)::int FROM user_permission_overrides o WHERE o.user_id = u.id) AS override_count
        FROM admin_users u
        LEFT JOIN admin_staff s ON s.id = u.staff_id
       ORDER BY (u.is_active IS NOT FALSE) DESC, u.role, name`);
    res.json(r.rows);
  } catch (err) {
    console.error('[admin/role-permissions users]', err);
    res.status(500).json({ error: '讀取帳號清單失敗' });
  }
});

router.get('/users/:userId', requireAdminAuth, requireResource('role-permissions'), async (req, res) => {
  try {
    const u = await pool.query(
      `SELECT u.id, u.username, COALESCE(NULLIF(u.name,''), s.name, u.username) AS name, u.role
         FROM admin_users u LEFT JOIN admin_staff s ON s.id = u.staff_id
        WHERE u.id = $1`, [req.params.userId]);
    if (!u.rowCount) return res.status(404).json({ error: '找不到這個帳號' });
    const user = u.rows[0];
    res.json({
      user,
      // 三份都給，讓畫面能標出「這一格跟角色不一樣」：
      role_allowed: [
        ...await svc.allowedResources(user.role),
        ...await svc.allowedActions(user.role),
      ],
      overrides: await svc.getUserOverrides(user.id),
      effective: [
        ...await svc.effectiveResources({ role: user.role, userId: user.id }),
        ...await svc.effectiveActions({ role: user.role, userId: user.id }),
      ],
    });
  } catch (err) {
    console.error('[admin/role-permissions user detail]', err);
    res.status(500).json({ error: '讀取個人權限失敗' });
  }
});

// 寫入限管理員本人，理由同 PUT /:role —— 否則被授權者能替自己開通任何頁面。
router.put('/users/:userId', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const ov = req.body?.overrides;
    if (!ov || typeof ov !== 'object' || Array.isArray(ov)) {
      return res.status(400).json({ error: 'overrides 必須是物件', code: 'OVERRIDES_REQUIRED' });
    }
    // 整個 adminUser 交給 service：變更紀錄要同時記帳號代號與名字。
    const actor = req.adminUser;
    const out = await svc.setUserOverrides(req.params.userId, ov, actor);
    res.json({ ok: true, ...out });
  } catch (err) {
    if (err.code === 'UNKNOWN_RESOURCE' || err.code === 'USER_REQUIRED') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[admin/role-permissions user put]', err);
    res.status(500).json({ error: '更新個人權限失敗' });
  }
});

// ── 角色權限 B 期：變更紀錄 ─────────────────────────────────────────────
// 唯讀，看得到「角色權限管理」這一頁的人就看得到。紀錄只增不改，沒有寫入端點。
router.get('/audit', requireAdminAuth, requireResource('role-permissions'), async (req, res) => {
  try {
    const { limit, offset, target_type: targetType, target_id: targetId } = req.query || {};
    if (targetType && !audit.TARGET_TYPES.includes(String(targetType))) {
      return res.status(400).json({ error: '未知的對象類型', code: 'UNKNOWN_TARGET_TYPE' });
    }
    res.json(await audit.list({ limit, offset, targetType, targetId }));
  } catch (err) {
    console.error('[admin/role-permissions audit]', err);
    res.status(500).json({ error: '讀取變更紀錄失敗' });
  }
});

module.exports = router;

