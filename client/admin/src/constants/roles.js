/**
 * 員工角色的單一事實來源（前端）。
 *
 * 與 server/constants/roles.js 內容必須一致；前後端是兩個獨立的建置，
 * 沒辦法直接共用模組，所以用 tests/role_source_of_truth_test.js 盯住兩份不會漂移。
 * 那個測試存在的理由很具體：這五個角色原本散在五個檔案、互相矛盾，
 * 而「篩選選得到、編輯存不了」這種症狀不會有人主動回報。
 */
export const ROLES = [
  { key: 'admin',     label: '系統管理員', backoffice: true  },
  { key: 'manager',   label: '場館主管',   backoffice: true  },
  { key: 'staff',     label: '行政櫃檯',   backoffice: true  },
  { key: 'coach',     label: '教練',       backoffice: false },
  { key: 'lifeguard', label: '救生員',     backoffice: false },
];

/** 可以指派給員工的身份（編輯視窗的下拉）。 */
export const ROLE_OPTIONS = ROLES.map((r) => ({ value: r.key, label: r.label }));

/** 篩選用：多一個「全部」。 */
export const ROLE_FILTER_OPTIONS = [{ value: '', label: '全部' }, ...ROLE_OPTIONS];

export const ROLE_LABELS = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));

export function roleLabel(key) {
  return ROLE_LABELS[key] || String(key || '');
}

