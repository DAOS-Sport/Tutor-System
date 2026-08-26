import { callApi } from './client';

export const rolePermissionsApi = {
  // 完整矩陣（僅管理員）
  list: () => callApi('/role-permissions', {}, () => ({ resources: [], roles: [], matrix: {} })),
  // 覆寫某角色的可見頁面
  setRole: (role, resourceKeys) =>
    callApi(`/role-permissions/${role}`, { method: 'put', data: { resource_keys: resourceKeys } },
      () => ({ ok: true })),
  // 目前登入者看得到哪些頁面（選單與路由守衛用）
  mine: () => callApi('/role-permissions/mine', {}, () => ({ role: 'admin', allowed: [] })),
};

