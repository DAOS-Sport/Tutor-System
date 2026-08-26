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

function roleLabel(key) {
  return ROLE_LABELS[key] || String(key || '');
}

module.exports = { ROLES, ASSIGNABLE_ROLES, BACKOFFICE_ROLES, ROLE_LABELS, roleLabel };

