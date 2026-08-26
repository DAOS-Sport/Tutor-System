/**
 * 員工角色的單一事實來源（前端）。
 *
 * 與 server/constants/roles.js 內容必須一致；前後端是兩個獨立的建置，
 * 沒辦法直接共用模組，所以用 tests/role_source_of_truth_test.js 盯住兩份不會漂移。
 * 那個測試存在的理由很具體：這五個角色原本散在五個檔案、互相矛盾，
 * 而「篩選選得到、編輯存不了」這種症狀不會有人主動回報。
 */
// 陣列順序即優先序（高 → 低）。身兼數職時的「代表值」取最高者。
// portal＝這個身分用哪個入口。'liff' 的不會出現在 F-A06 權限表 ——
// 教練有專屬入口，後台頁面對他沒有意義。
// backoffice 是另一件事：現在能不能登入後台（救生員 portal=admin 但尚未開放）。
export const ROLES = [
  { key: 'admin',     label: '系統管理員', backoffice: true,  portal: 'admin' },
  { key: 'manager',   label: '場館主管',   backoffice: true,  portal: 'admin' },
  { key: 'staff',     label: '行政櫃檯',   backoffice: true,  portal: 'admin' },
  { key: 'coach',     label: '教練',       backoffice: false, portal: 'liff'  },
  { key: 'lifeguard', label: '救生員',     backoffice: true,  portal: 'admin' },
];

/** 可以指派給員工的身份（編輯視窗的下拉）。 */
export const ROLE_OPTIONS = ROLES.map((r) => ({ value: r.key, label: r.label }));

/** 篩選用：多一個「全部」。 */
export const ROLE_FILTER_OPTIONS = [{ value: '', label: '全部' }, ...ROLE_OPTIONS];

export const ROLE_LABELS = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));

export function roleLabel(key) {
  return ROLE_LABELS[key] || String(key || '');
}


/** 一組身分裡優先序最高的那一個。給「代表值」用，不是權限判定。 */
export function highestRole(list) {
  const set = new Set((list || []).map(String));
  return ROLES.map((r) => r.key).find((k) => set.has(k)) || null;
}
