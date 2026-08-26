/**
 * F-A06 角色權限管理
 *
 *   GET /api/admin/role-permissions        → 頁面清單 + 角色清單 + 完整矩陣（管理員）
 *   PUT /api/admin/role-permissions/:role  → 覆寫某角色的可見頁面（管理員）
 *   GET /api/admin/role-permissions/mine   → 目前登入者看得到哪些頁面（所有後台角色）
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
const { ADMIN_RESOURCES } = require('../../constants/adminResources');
const { ROLES } = require('../../constants/roles');
const svc = require('../../services/rolePermissions');

// /mine 要讓所有後台角色都打得到，否則非管理員登入後選單會是空的。
router.get('/mine', requireAdminAuth, async (req, res) => {
  try {
    const role = req.adminUser.role;
    res.json({ role, allowed: await svc.allowedResources(role) });
  } catch (err) {
    console.error('[admin/role-permissions mine]', err);
    res.status(500).json({ error: '讀取權限失敗' });
  }
});

router.get('/', requireAdminAuth, requireResource('role-permissions'), async (req, res) => {
  try {
    res.json({
      resources: ADMIN_RESOURCES.map((r) => ({
        key: r.key, group: r.group, path: r.path, label: r.label,
      })),
      // immutable 讓前端知道那一欄要畫成鎖住的，而不是可以勾卻存不了。
      roles: ROLES.map((r) => ({
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
    const actor = req.adminUser?.name || req.adminUser?.username || 'admin';
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

module.exports = router;

