/**
 * 員工角色的單一事實來源（F-A06 第 1 期）。
 *
 * 在此之前，角色清單散在五個地方而且互相矛盾：
 *   StaffPage 篩選     5 個（標籤「主管」）
 *   StaffEditModal     4 個 ← 缺救生員
 *   format.roleLabel   5 個（標籤「場館主管」）
 *   BACKOFFICE_ROLES   3 個
 *   staff.VALID_ROLES  4 個 ← 缺救生員
 * 症狀是「篩選選得到救生員，編輯卻指派不了」，而且同一個 manager 在不同畫面
 * 叫不同名字。這種漂移不會有人主動發現 —— 只會在某天有人問「為什麼存不進去」。
 *
 * ── 兩份清單刻意分開 ──
 * ASSIGNABLE：可以指派給員工的身份。
 * BACKOFFICE：可以登入後台的角色。
 * 合成一份會很方便，但那等於「把救生員加進選單」就順手發了後台權限給他 ——
 * 那是 F-A06 第 2 期要審慎處理的事，不該當成清單整併的副作用。
 */
'use strict';

// 陣列順序即優先序（高 → 低）。一個人身兼數職時，admin_staff.role 這個
// 「代表值」取其中最高的那一個 —— 登入與既有查詢都靠它，必須是單值。
// 實際權限不看代表值，而是所有身分取聯集（見 services/rolePermissions）。
const ROLES = Object.freeze([
  { key: 'admin',     label: '系統管理員', backoffice: true  },
  { key: 'manager',   label: '場館主管',   backoffice: true  },
  { key: 'staff',     label: '行政櫃檯',   backoffice: true  },
  { key: 'coach',     label: '教練',       backoffice: false },
  { key: 'lifeguard', label: '救生員',     backoffice: false },
]);

const ASSIGNABLE_ROLES = Object.freeze(ROLES.map((r) => r.key));
const BACKOFFICE_ROLES = Object.freeze(ROLES.filter((r) => r.backoffice).map((r) => r.key));
const ROLE_LABELS = Object.freeze(Object.fromEntries(ROLES.map((r) => [r.key, r.label])));

/** 一組身分裡優先序最高的那一個。給「代表值」用，不是權限判定。 */
function highestRole(list) {
  const set = new Set((list || []).map(String));
  return ASSIGNABLE_ROLES.find((r) => set.has(r)) || null;
}

function roleLabel(key) {
  return ROLE_LABELS[key] || String(key || '');
}

module.exports = { ROLES, ASSIGNABLE_ROLES, BACKOFFICE_ROLES, ROLE_LABELS, roleLabel, highestRole };

