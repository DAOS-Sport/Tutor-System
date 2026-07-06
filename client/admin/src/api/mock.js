// Centralized mock dataset for Admin Phase 3.
// 所有 admin API 模組在 mock 模式或後端 501 時，從這裡讀寫。

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const USERS = [
  { id: 'U001', username: 'admin',   password: 'admin',   name: '系統管理員',  role: 'admin',   venue_id: null },
  { id: 'U002', username: 'manager', password: 'manager', name: '王主管',      role: 'manager', venue_id: 'B' },
  { id: 'U003', username: 'staff',   password: 'staff',   name: '小林櫃檯',    role: 'staff',   venue_id: 'B' },
];

const VENUES = [
  {
    id: 'B', code: 'B', name: '夢想體育學院 板橋館', address: '新北市板橋區文化路一段 188 號 3 樓',
    line_token: 'CHANNEL_TOKEN_B_xxxxxxxx', bank_institution_name: '玉山銀行', bank_branch_name: '板橋分行',
    account_holder: '駿斯運動事業股份有限公司', account_number: '0123-456-789012',
  },
  {
    id: 'C', code: 'C', name: '夢想體育學院 中和館', address: '新北市中和區景平路 268 號 B1',
    line_token: 'CHANNEL_TOKEN_C_xxxxxxxx', bank_institution_name: '國泰世華銀行', bank_branch_name: '中和分行',
    account_holder: '駿斯運動事業股份有限公司', account_number: '0987-654-321098',
  },
  {
    id: 'X', code: 'X', name: '夢想體育學院 新莊館', address: '新北市新莊區中正路 10 號 2 樓',
    line_token: '', bank_institution_name: '台新銀行', bank_branch_name: '新莊分行',
    account_holder: '駿斯運動事業股份有限公司', account_number: '5566-7788-990011',
  },
];

const STAFF = [
  { id: 'C001', name: '王志強', role: 'coach',   venue_id: 'B', phone: '0911000001', is_senior: true,  multiplier: 1.30, active: true },
  { id: 'C002', name: '林佳穎', role: 'coach',   venue_id: 'B', phone: '0911000002', is_senior: true,  multiplier: 1.50, active: true },
  { id: 'C003', name: '張嘉豪', role: 'coach',   venue_id: 'C', phone: '0911000003', is_senior: false, multiplier: 1.00, active: true },
  { id: 'C004', name: '黃詩涵', role: 'coach',   venue_id: 'X', phone: '0911000004', is_senior: false, multiplier: 1.10, active: true },
  { id: 'M001', name: '王主管', role: 'manager', venue_id: 'B', phone: '0922000001', is_senior: false, multiplier: 1.00, active: true },
  { id: 'S001', name: '小林櫃檯', role: 'staff', venue_id: 'B', phone: '0933000001', is_senior: false, multiplier: 1.00, active: true },
];

// Task #32 — 教練資料 mock（USE_MOCK 模式或後端 501 fallback）
// 真實環境會由 syncStaffFromRagic 在 staff approve 階段透過 ensureCoachRow 同步寫入 coaches
const COACHES_ADMIN = [
  { id: 'c-001', ragic_employee_id: 'C001', name: '王志強', phone: '0911000001',
    email: '', line_uid: 'U_c001', line_bound: true,
    is_senior: true, pricing_multiplier: 1.30,
    specialties: ['基礎技巧', '青少年班'],
    bio_rich_text: '專注青少年網球啟蒙 8 年。',
    is_active: true, intro_review_status: 'published',
    venue_ids: ['B'] },
  { id: 'c-002', ragic_employee_id: 'C002', name: '林佳穎', phone: '0911000002',
    email: 'jiaying@daos.tw', line_uid: 'U_c002', line_bound: true,
    is_senior: true, pricing_multiplier: 1.50,
    specialties: ['體能訓練', '比賽選手'],
    bio_rich_text: '前國手，10 年競技指導經驗。',
    is_active: true, intro_review_status: 'published',
    venue_ids: ['B'] },
  { id: 'c-003', ragic_employee_id: 'C003', name: '張嘉豪', phone: '0911000003',
    email: '', line_uid: '', line_bound: false,
    is_senior: false, pricing_multiplier: 1.00,
    specialties: ['基礎技巧'],
    bio_rich_text: '熱情活潑、耐心十足。',
    is_active: true, intro_review_status: 'pending',
    venue_ids: ['B', 'C'] },
  { id: 'c-004', ragic_employee_id: 'C004', name: '黃詩涵', phone: '0911000004',
    email: '', line_uid: '', line_bound: false,
    is_senior: false, pricing_multiplier: 1.10,
    specialties: ['團體班'],
    bio_rich_text: '具備 5 年場館團體班經驗。',
    is_active: true, intro_review_status: 'draft',
    venue_ids: ['C'] },
  { id: 'c-s001', ragic_employee_id: 'S001', name: '小林櫃檯', phone: '0933000001',
    email: '', line_uid: '', line_bound: false,
    is_senior: false, pricing_multiplier: 1.00,
    specialties: ['現場接待', '基礎技巧'],
    bio_rich_text: '兼任行政櫃檯與基礎課程教練。',
    is_active: true, intro_review_status: 'draft',
    venue_ids: ['B'] },
];

function withCoachProfile(row) {
  const coach = COACHES_ADMIN.find((c) => c.ragic_employee_id === row.id);
  const hasCoachProfile = !!coach;
  const coachProfileStatus = !hasCoachProfile ? 'none' : (coach.is_active ? 'active' : 'inactive');
  return {
    ...row,
    has_coach_profile: hasCoachProfile,
    is_coach_profile: hasCoachProfile && row.role !== 'coach',
    coach_profile_status: coachProfileStatus,
    known_roles: Array.from(new Set([row.role, ...(hasCoachProfile ? ['coach'] : [])])),
    coach_id: coach?.id || null,
    coach_active: coach ? !!coach.is_active : false,
    line_uid: coach?.line_uid || row.line_uid || null,
    line_uid_source: coach?.line_uid ? 'coach' : (row.line_uid ? 'login' : null),
  };
}

function setMockCoachProfile(row, active) {
  if (row.role === 'coach') return;
  let coach = COACHES_ADMIN.find((c) => c.ragic_employee_id === row.id);
  if (active) {
    if (!coach) {
      coach = {
        id: `c-${String(row.id).toLowerCase()}`,
        ragic_employee_id: row.id,
        name: row.name,
        phone: row.phone,
        email: '',
        line_uid: '',
        line_bound: false,
        is_senior: false,
        pricing_multiplier: 1.00,
        specialties: ['兼任櫃檯'],
        bio_rich_text: `${row.name} 兼任行政櫃檯與基礎課程教練。`,
        is_active: true,
        intro_review_status: 'draft',
        venue_ids: row.venue_id ? [row.venue_id] : [],
      };
      COACHES_ADMIN.push(coach);
    } else {
      coach.name = row.name;
      coach.phone = row.phone;
      coach.is_active = true;
      if (row.venue_id && !(coach.venue_ids || []).includes(row.venue_id)) {
        coach.venue_ids = [...(coach.venue_ids || []), row.venue_id];
      }
    }
  } else if (coach) {
    coach.is_active = false;
  }
}

const SETTINGS = {
  sessions_per_period:    6,
  validity_days:        365,
  expiry_notice_days:    60,
  refund_fee_rate:        0.10,
  transfer_fee:         500,
  default_session_minutes: 60,
  multi_confirm_minutes:   60,
};

const COURSE_TYPES = [
  { course_type: 1, label: '一對一', max_students: 1, min_students: 1, is_active: true, sort_order: 1, base_price: 9000 },
  { course_type: 2, label: '一對二', max_students: 2, min_students: 1, is_active: true, sort_order: 2, base_price: 6000 },
  { course_type: 3, label: '一對三', max_students: 3, min_students: 1, is_active: true, sort_order: 3, base_price: 4500 },
  { course_type: 4, label: '1對4', max_students: 4, min_students: 1, is_active: true, sort_order: 4, base_price: 3000 },
  { course_type: 5, label: '1對5', max_students: 5, min_students: 1, is_active: true, sort_order: 5, base_price: 3000 },
  { course_type: 6, label: '1對6', max_students: 6, min_students: 1, is_active: true, sort_order: 6, base_price: 3000 },
];

const COURSE_INTROS = {
  1: { title: '1 對 1 個別班', body: '完全客製化的訓練內容，最高效率提升個人技術。', image_url: '', title_overridden: true },
  2: { title: '1 對 2 雙人班', body: '與好友或家人共同上課，互相學習，CP 值高。',     image_url: '', title_overridden: true },
  3: { title: '1 對 3 三人班', body: '小團體互動性最強，適合朋友揪團、節省花費。',   image_url: '', title_overridden: true },
  4: { title: '1對4', body: '', image_url: '', title_overridden: false },
  5: { title: '1對5', body: '', image_url: '', title_overridden: false },
  6: { title: '1對6', body: '', image_url: '', title_overridden: false },
};

// 報名 + 對帳 mock — 24 筆，混 pending/confirmed/active/cancelled/refunded
let _seq = 1000;
function nid(prefix = 'CP') { return `${prefix}${++_seq}`; }

// 為 dev 方便：把「相對日」轉成 ISO datetime
function relDays(days, hh = 9, mm = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.toISOString().slice(0, 10)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

const ENROLLMENTS = [
  // ===== 待對帳 8 筆（pending_payment）=====
  { id: 'CP1001', parent_name: '張媽媽', parent_phone: '0912345678', students: ['張小明'],
    coach: '王志強', venue_id: 'B', course_type: 1, original_price: 11700, final_price: 11115,
    transfer_last_5: '12345', status: 'pending_payment', submitted_at: relDays(0, 9, 30),
    audit_logs: [{ at: relDays(0, 9, 30), action: '家長送出報名', by: '張媽媽' }] },
  { id: 'CP1002', parent_name: '李爸爸', parent_phone: '0922333444', students: ['李小龍', '張小美'],
    coach: '林佳穎', venue_id: 'B', course_type: 2, original_price: 9000, final_price: 8550,
    transfer_last_5: '67890', status: 'pending_payment', submitted_at: relDays(0, 10, 15),
    audit_logs: [{ at: relDays(0, 10, 15), action: '家長送出報名', by: '李爸爸' }] },
  { id: 'CP1006', parent_name: '吳爸爸', parent_phone: '0955123456', students: ['吳大寶'],
    coach: '王志強', venue_id: 'B', course_type: 1, original_price: 11700, final_price: 11115,
    transfer_last_5: '33344', status: 'pending_payment', submitted_at: relDays(-1, 14, 20),
    audit_logs: [{ at: relDays(-1, 14, 20), action: '家長送出報名', by: '吳爸爸' }] },
  { id: 'CP1007', parent_name: '林媽媽', parent_phone: '0966234567', students: ['林小綠', '林小紅'],
    coach: '張嘉豪', venue_id: 'C', course_type: 2, original_price: 6000, final_price: 5700,
    transfer_last_5: '55566', status: 'pending_payment', submitted_at: relDays(-1, 11, 5),
    audit_logs: [{ at: relDays(-1, 11, 5), action: '家長送出報名', by: '林媽媽' }] },
  { id: 'CP1008', parent_name: '蔡媽媽', parent_phone: '0977345678', students: ['蔡安安', '蔡平平', '蔡靜靜'],
    coach: '黃詩涵', venue_id: 'X', course_type: 3, original_price: 4950, final_price: 4702,
    transfer_last_5: '77788', status: 'pending_payment', submitted_at: relDays(-2, 9, 0),
    audit_logs: [{ at: relDays(-2, 9, 0), action: '家長送出報名', by: '蔡媽媽' }] },
  { id: 'CP1009', parent_name: '謝爸爸', parent_phone: '0988456789', students: ['謝小恩'],
    coach: '林佳穎', venue_id: 'B', course_type: 1, original_price: 13500, final_price: 12825,
    transfer_last_5: '88899', status: 'pending_payment', submitted_at: relDays(-2, 16, 30),
    audit_logs: [{ at: relDays(-2, 16, 30), action: '家長送出報名', by: '謝爸爸' }] },
  { id: 'CP1010', parent_name: '黃媽媽', parent_phone: '0999567890', students: ['黃小傑'],
    coach: '張嘉豪', venue_id: 'C', course_type: 1, original_price: 9000, final_price: 8550,
    transfer_last_5: '00011', status: 'pending_payment', submitted_at: relDays(-3, 13, 0),
    audit_logs: [{ at: relDays(-3, 13, 0), action: '家長送出報名', by: '黃媽媽' }] },
  { id: 'CP1011', parent_name: '楊媽媽', parent_phone: '0911678901', students: ['楊小綺', '王小華'],
    coach: '王志強', venue_id: 'B', course_type: 2, original_price: 7800, final_price: 7410,
    transfer_last_5: '22233', status: 'pending_payment', submitted_at: relDays(-3, 17, 45),
    audit_logs: [{ at: relDays(-3, 17, 45), action: '家長送出報名', by: '楊媽媽' }] },

  // ===== 已對帳尚未開課 3 筆（confirmed）=====
  { id: 'CP1003', parent_name: '陳媽媽', parent_phone: '0933555777', students: ['陳小米'],
    coach: '張嘉豪', venue_id: 'C', course_type: 1, original_price: 9000, final_price: 8550,
    transfer_last_5: '24680', status: 'confirmed', submitted_at: relDays(-4, 14, 0),
    total_sessions: 6, used_sessions: 1,
    audit_logs: [
      { at: relDays(-4, 14, 0), action: '家長送出報名', by: '陳媽媽' },
      { at: relDays(-4, 15, 20), action: '對帳通過', by: '王主管' },
    ] },
  { id: 'CP1012', parent_name: '蘇爸爸', parent_phone: '0922789012', students: ['蘇小明'],
    coach: '林佳穎', venue_id: 'B', course_type: 1, original_price: 13500, final_price: 12825,
    transfer_last_5: '44455', status: 'confirmed', submitted_at: relDays(-5, 10, 30),
    total_sessions: 6, used_sessions: 0,
    audit_logs: [
      { at: relDays(-5, 10, 30), action: '家長送出報名', by: '蘇爸爸' },
      { at: relDays(-5, 11, 0), action: '對帳通過', by: '王主管' },
    ] },
  { id: 'CP1013', parent_name: '鄭媽媽', parent_phone: '0933890123', students: ['鄭小俠', '鄭小俐'],
    coach: '黃詩涵', venue_id: 'X', course_type: 2, original_price: 6600, final_price: 6270,
    transfer_last_5: '66677', status: 'confirmed', submitted_at: relDays(-6, 9, 15),
    total_sessions: 6, used_sessions: 0,
    audit_logs: [
      { at: relDays(-6, 9, 15), action: '家長送出報名', by: '鄭媽媽' },
      { at: relDays(-6, 10, 0), action: '對帳通過', by: '王主管' },
    ] },

  // ===== 進行中 6 筆（active）=====
  { id: 'CP1004', parent_name: '張媽媽', parent_phone: '0912345678', students: ['張小明'],
    coach: '王志強', venue_id: 'B', course_type: 1, original_price: 11700, final_price: 11115,
    transfer_last_5: '99999', status: 'active', submitted_at: relDays(-22, 9, 0),
    total_sessions: 6, used_sessions: 3,
    audit_logs: [
      { at: relDays(-22, 9, 0), action: '家長送出報名', by: '張媽媽' },
      { at: relDays(-22, 11, 0), action: '對帳通過', by: '王主管' },
    ] },
  { id: 'CP1014', parent_name: '王媽媽', parent_phone: '0944901234', students: ['王小皓'],
    coach: '林佳穎', venue_id: 'B', course_type: 1, original_price: 13500, final_price: 12825,
    transfer_last_5: '11000', status: 'active', submitted_at: relDays(-30, 9, 0),
    total_sessions: 6, used_sessions: 5,
    audit_logs: [
      { at: relDays(-30, 9, 0), action: '家長送出報名', by: '王媽媽' },
      { at: relDays(-30, 10, 0), action: '對帳通過', by: '王主管' },
    ] },
  { id: 'CP1015', parent_name: '陳爸爸', parent_phone: '0955012345', students: ['陳小宇'],
    coach: '張嘉豪', venue_id: 'C', course_type: 1, original_price: 9000, final_price: 8550,
    transfer_last_5: '22000', status: 'active', submitted_at: relDays(-15, 14, 0),
    total_sessions: 6, used_sessions: 2,
    audit_logs: [
      { at: relDays(-15, 14, 0), action: '家長送出報名', by: '陳爸爸' },
      { at: relDays(-15, 15, 0), action: '對帳通過', by: '王主管' },
    ] },
  { id: 'CP1016', parent_name: '林爸爸', parent_phone: '0966123456', students: ['林小杰', '林小妤'],
    coach: '王志強', venue_id: 'B', course_type: 2, original_price: 7800, final_price: 7410,
    transfer_last_5: '33000', status: 'active', submitted_at: relDays(-18, 16, 0),
    total_sessions: 6, used_sessions: 4,
    audit_logs: [
      { at: relDays(-18, 16, 0), action: '家長送出報名', by: '林爸爸' },
      { at: relDays(-18, 17, 0), action: '對帳通過', by: '王主管' },
    ] },
  { id: 'CP1017', parent_name: '徐媽媽', parent_phone: '0977234567', students: ['徐小柔'],
    coach: '黃詩涵', venue_id: 'X', course_type: 1, original_price: 9900, final_price: 9405,
    transfer_last_5: '44000', status: 'active', submitted_at: relDays(-25, 10, 0),
    total_sessions: 6, used_sessions: 1,
    audit_logs: [
      { at: relDays(-25, 10, 0), action: '家長送出報名', by: '徐媽媽' },
      { at: relDays(-25, 11, 0), action: '對帳通過', by: '王主管' },
    ] },
  { id: 'CP1018', parent_name: '高媽媽', parent_phone: '0988345678', students: ['高小琳'],
    coach: '林佳穎', venue_id: 'B', course_type: 1, original_price: 13500, final_price: 12825,
    transfer_last_5: '55000', status: 'active', submitted_at: relDays(-12, 9, 0),
    total_sessions: 6, used_sessions: 0,
    audit_logs: [
      { at: relDays(-12, 9, 0), action: '家長送出報名', by: '高媽媽' },
      { at: relDays(-12, 10, 0), action: '對帳通過', by: '王主管' },
    ] },

  // ===== 取消 / 退費 4 筆（cancelled / refunded）=====
  { id: 'CP1005', parent_name: '陳媽媽', parent_phone: '0933555777', students: ['陳小米'],
    coach: '黃詩涵', venue_id: 'X', course_type: 3, original_price: 4950, final_price: 4702,
    transfer_last_5: '11122', status: 'cancelled', submitted_at: relDays(-45, 8, 30),
    total_sessions: 6, used_sessions: 0,
    audit_logs: [
      { at: relDays(-45, 8, 30), action: '家長送出報名', by: '陳媽媽' },
      { at: relDays(-45, 10, 0), action: '對帳通過', by: '王主管' },
      { at: relDays(-7, 16, 0), action: '主管取消', by: '王主管' },
    ] },
  { id: 'CP1019', parent_name: '何爸爸', parent_phone: '0911456789', students: ['何小晴'],
    coach: '王志強', venue_id: 'B', course_type: 1, original_price: 11700, final_price: 11115,
    transfer_last_5: '66000', status: 'refunded', submitted_at: relDays(-50, 11, 0),
    total_sessions: 6, used_sessions: 2,
    audit_logs: [
      { at: relDays(-50, 11, 0), action: '家長送出報名', by: '何爸爸' },
      { at: relDays(-50, 12, 0), action: '對帳通過', by: '王主管' },
      { at: relDays(-10, 14, 30), action: '退課（理由：搬家無法繼續上課，退款 NT$ 6,669）', by: '王主管' },
    ] },
  { id: 'CP1020', parent_name: '葉媽媽', parent_phone: '0922567890', students: ['葉小晨'],
    coach: '張嘉豪', venue_id: 'C', course_type: 1, original_price: 9000, final_price: 8550,
    transfer_last_5: '77000', status: 'refunded', submitted_at: relDays(-60, 10, 0),
    total_sessions: 6, used_sessions: 4,
    audit_logs: [
      { at: relDays(-60, 10, 0), action: '家長送出報名', by: '葉媽媽' },
      { at: relDays(-60, 11, 0), action: '對帳通過', by: '王主管' },
      { at: relDays(-15, 15, 0), action: '退課（理由：時間衝突，退款 NT$ 2,565）', by: '王主管' },
    ] },
  { id: 'CP1021', parent_name: '邱媽媽', parent_phone: '0933678901', students: ['邱小宸'],
    coach: '林佳穎', venue_id: 'B', course_type: 1, original_price: 13500, final_price: 12825,
    transfer_last_5: '88000', status: 'cancelled', submitted_at: relDays(-35, 13, 0),
    total_sessions: 6, used_sessions: 0,
    audit_logs: [
      { at: relDays(-35, 13, 0), action: '家長送出報名', by: '邱媽媽' },
      { at: relDays(-35, 14, 0), action: '對帳通過', by: '王主管' },
      { at: relDays(-3, 9, 0), action: '主管取消', by: '王主管' },
    ] },

  // ===== 進行中（補到 24 筆，剛好涵蓋三場館 + 三組別 + 多數教練）=====
  { id: 'CP1022', parent_name: '游爸爸', parent_phone: '0944789012', students: ['游小薇', '小婷', '小芯'],
    coach: '黃詩涵', venue_id: 'X', course_type: 3, original_price: 4950, final_price: 4702,
    transfer_last_5: '99000', status: 'active', submitted_at: relDays(-20, 11, 0),
    total_sessions: 6, used_sessions: 3,
    audit_logs: [
      { at: relDays(-20, 11, 0), action: '家長送出報名', by: '游爸爸' },
      { at: relDays(-20, 12, 0), action: '對帳通過', by: '王主管' },
    ] },
  { id: 'CP1023', parent_name: '宋媽媽', parent_phone: '0955890123', students: ['宋小芳'],
    coach: '張嘉豪', venue_id: 'C', course_type: 1, original_price: 9000, final_price: 8550,
    transfer_last_5: '12300', status: 'active', submitted_at: relDays(-8, 9, 0),
    total_sessions: 6, used_sessions: 1,
    audit_logs: [
      { at: relDays(-8, 9, 0), action: '家長送出報名', by: '宋媽媽' },
      { at: relDays(-8, 10, 30), action: '對帳通過', by: '王主管' },
    ] },
  { id: 'CP1024', parent_name: '紀媽媽', parent_phone: '0966901234', students: ['紀小美', '紀小華'],
    coach: '王志強', venue_id: 'B', course_type: 2, original_price: 7800, final_price: 7410,
    transfer_last_5: '45600', status: 'active', submitted_at: relDays(-5, 16, 0),
    total_sessions: 6, used_sessions: 0,
    audit_logs: [
      { at: relDays(-5, 16, 0), action: '家長送出報名', by: '紀媽媽' },
      { at: relDays(-5, 17, 0), action: '對帳通過', by: '王主管' },
    ] },
];

const SESSIONS = [
  { id: 'SE001', date: todayISO(), start: '14:00', end: '15:00', venue_id: 'B', coach: '王志強', students: ['張小明'], course_type: 1, checkin_status: 'checked_in' },
  { id: 'SE002', date: todayISO(), start: '15:00', end: '16:00', venue_id: 'B', coach: '林佳穎', students: ['張小美', '李小龍'], course_type: 2, checkin_status: 'not_yet' },
  { id: 'SE003', date: todayISO(), start: '17:00', end: '18:00', venue_id: 'C', coach: '張嘉豪', students: ['陳小米'], course_type: 1, checkin_status: 'not_yet' },
  { id: 'SE004', date: todayISO(), start: '18:00', end: '19:00', venue_id: 'X', coach: '黃詩涵', students: ['Lulu', 'Tom', 'Amy'], course_type: 3, checkin_status: 'absent' },
];

// 已取消、可復活的時段（給 F-M05）
const CANCELLED_SESSIONS = [
  { id: 'SX001', date: '2026-04-22', start: '15:00', period_id: 'CP1004', parent_name: '張媽媽', coach: '王志強', venue_id: 'B', refunded: false },
  { id: 'SX002', date: '2026-04-25', start: '17:00', period_id: 'CP1005', parent_name: '陳媽媽', coach: '黃詩涵', venue_id: 'X', refunded: true },
];

// ---- Ragic 連線狀態 mock ----
// 真實的 ragicStatusApi 直連後端、刻意不吃 mock（這頁只反映線上即時同步狀態），
// 因此 demo / VITE_USE_MOCK 模式下原本「連開都開不了」。此處補一份假快照，
// 讓這頁在無後端時也能開，並讓「立即同步」按出「同步中 → 成功」動畫（5 秒輪詢驅動）。
function _ragicNextCron(now = new Date()) {
  // 對齊 server/routes/admin/ragicStatus.js 的 '*/10 * * * *'
  const next = new Date(now.getTime());
  next.setSeconds(0, 0);
  const m = next.getMinutes();
  next.setMinutes(m + (10 - (m % 10)));
  return next.toISOString();
}
const RAGIC_MOCK_ENV = {
  RAGIC_API_KEY: true, RAGIC_BASE_URL: true,
  RAGIC_FORM_H01: true, RAGIC_FORM_H05: true,
  RAGIC_FORM_Z01: true, RAGIC_FORM_Z02: true,
};
const RAGIC_MOCK_LIVE_PROBE = {
  ok: true,
  cached: false,
  checked_at: new Date(Date.now() - 30000).toISOString(),
  forms: {
    h01: { label: 'H01 員工 API', env: 'RAGIC_FORM_H01', configured: true, status: 'ok', ok: true, empty: false, record_count: 1, duration_ms: 420 },
    h05: { label: 'H05 場館 API', env: 'RAGIC_FORM_H05', configured: true, status: 'ok', ok: true, empty: false, record_count: 1, duration_ms: 380 },
    z01: { label: 'Z01 家長 API', env: 'RAGIC_FORM_Z01', configured: true, status: 'ok', ok: true, empty: false, record_count: 1, duration_ms: 510 },
    z02: { label: 'Z02 學員 API', env: 'RAGIC_FORM_Z02', configured: true, status: 'ok', ok: true, empty: false, record_count: 1, duration_ms: 490 },
  },
};
// 模組級可變狀態：ragicSync() 會就地改它，下一次 ragicStatus() 回傳更新後的深拷貝。
// admin_enabled：demo 模式下的「Ragic 連線狀態」手動開關初始值，皆預設開啟。
const RAGIC_MOCK_FORMS = {
  staff: {
    form_code: 'H01_STAFF', label: 'H01 員工 + 教練 (admin_staff + coaches)', kind: 'sync',
    admin_enabled: true,
    in_progress: false, last_status: 'ok', last_triggered_by: 'cron', last_error: null,
    last_run_at: new Date(Date.now() - 6 * 60000).toISOString(),
    last_success_at: new Date(Date.now() - 6 * 60000).toISOString(),
    last_count: 125, last_duration_ms: 21299,
  },
  venues: {
    form_code: 'H05_VENUES', label: 'H05 場館 (venues)', kind: 'sync',
    admin_enabled: true,
    in_progress: false, last_status: 'ok', last_triggered_by: 'cron', last_error: null,
    last_run_at: new Date(Date.now() - 6 * 60000).toISOString(),
    last_success_at: new Date(Date.now() - 6 * 60000).toISOString(),
    last_count: 3, last_duration_ms: 1840,
  },
  parents: {
    form_code: 'Z01_PARENTS', label: 'Z01 家長（連線健康檢查）', kind: 'healthcheck',
    admin_enabled: true,
    in_progress: false, last_status: 'ok', last_triggered_by: 'cron', last_error: null,
    last_run_at: new Date(Date.now() - 6 * 60000).toISOString(),
    last_success_at: new Date(Date.now() - 6 * 60000).toISOString(),
    last_count: 0, last_duration_ms: 540,
  },
  students: {
    form_code: 'Z02_STUDENTS', label: 'Z02 學員（連線健康檢查）', kind: 'healthcheck',
    admin_enabled: true,
    in_progress: false, last_status: 'ok', last_triggered_by: 'cron', last_error: null,
    last_run_at: new Date(Date.now() - 6 * 60000).toISOString(),
    last_success_at: new Date(Date.now() - 6 * 60000).toISOString(),
    last_count: 0, last_duration_ms: 610,
  },
  backup: {
    form_code: 'Z01_Z02_BACKUP', label: 'Z01/Z02 本地→Ragic 每日備份同步', kind: 'sync',
    admin_enabled: true,
    in_progress: false, last_status: 'ok', last_triggered_by: 'cron', last_error: null,
    last_run_at: new Date(Date.now() - 5 * 3600000).toISOString(),
    last_success_at: new Date(Date.now() - 5 * 3600000).toISOString(),
    last_count: 2, last_duration_ms: 980,
  },
  pull: {
    form_code: 'Z01_Z02_PULL', label: 'Z01/Z02 Ragic→本地 每日全量同步', kind: 'sync',
    admin_enabled: true,
    in_progress: false, last_status: 'ok', last_triggered_by: 'cron', last_error: null,
    last_run_at: new Date(Date.now() - 6 * 3600000).toISOString(),
    last_success_at: new Date(Date.now() - 6 * 3600000).toISOString(),
    last_count: 118, last_duration_ms: 15400,
  },
};

// ── 客戶資料管理 mock（Z01 家長&學員關係 / Z02 學員資料含購買紀錄）──────────────
const CUSTOMER_PARENTS = [
  { id: 'p-uuid-001', line_uid: 'U11223344556677889900abcdef', phone: '0919488314', name: 'Mandy',
    gender: '生理女', email: 'mandy@example.com', primary_venue_id: 'B', identity: '一般身份',
    home_phone: '02-29887766', home_address: '新北市板橋區文化路一段188號', line_id: 'mandy_line',
    ragic_record_id: 'ragic-node-101', is_active: true, last_synced_at: '2026-06-30 19:12', family_id: 'fam-uuid-101' },
  { id: 'p-uuid-002', line_uid: 'U99887766554433221100fedcba', phone: '0935141499', name: '戴凱莉',
    gender: '生理女', email: 'kelly.tai@example.com', primary_venue_id: 'C', identity: '一般身份',
    home_phone: '02-27654321', home_address: '台北市信義區忠孝東路五段100號', line_id: 'kelly_line_99',
    ragic_record_id: 'ragic-node-102', is_active: true, last_synced_at: '2026-06-28 14:30', family_id: 'fam-uuid-102' },
  { id: 'p-uuid-003', line_uid: null, phone: '0919136455', name: '蕭宇成',
    gender: '生理男', email: 'yc.hsiao@example.com', primary_venue_id: 'X', identity: '教練/員工',
    home_phone: '03-5778899', home_address: '新竹市東區光復路二段101號', line_id: 'yucheng_s',
    ragic_record_id: 'ragic-node-103', is_active: true, last_synced_at: '2026-06-29 09:15', family_id: 'fam-uuid-103' },
  { id: 'p-uuid-004', line_uid: null, phone: '0900000000', name: '行政櫃檯(測試)',
    gender: '生理男', email: 'counter.test@example.com', primary_venue_id: 'B', identity: '行政櫃檯',
    home_phone: '02-25001122', home_address: '新北市板橋區文化路一段200號', line_id: '',
    ragic_record_id: 'ragic-node-104', is_active: false, last_synced_at: '2026-06-25 18:22', family_id: 'fam-uuid-104' },
];
const CUSTOMER_STUDENTS = [
  { id: 's-uuid-201', parent_id: 'p-uuid-001', name: '張景祥', id_number: 'A133677361', gender: '生理男',
    birth_date: '2019-04-04', blood_type: '不清楚', student_code: 'STD-133677', ragic_record_id: 'ragic-stud-201',
    is_active: true, last_synced_at: '2026-06-30 19:12' },
  { id: 's-uuid-202', parent_id: 'p-uuid-002', name: '林小寶', id_number: 'A123456789', gender: '生理男',
    birth_date: '2018-05-12', blood_type: 'O', student_code: 'STD-112001', ragic_record_id: 'ragic-stud-202',
    is_active: true, last_synced_at: '2026-06-28 14:30' },
  { id: 's-uuid-203', parent_id: 'p-uuid-001', name: '張景惠', id_number: 'A233677362', gender: '生理女',
    birth_date: '2021-09-01', blood_type: 'A', student_code: 'STD-133678', ragic_record_id: 'ragic-stud-203',
    is_active: true, last_synced_at: '2026-06-30 19:12' },
];
const CUSTOMER_PURCHASES = {
  's-uuid-201': [
    { id: 'pur-1', category: '常態團體班', course_type: 1, status: '已報名', sessions: '0/6', price: '4800', date: '2026-06-10', period_number: 1, expires_at: '2026-09-10' },
    { id: 'pur-2', category: '課後班', course_type: 2, status: '進行中', sessions: '2/12', price: '9600', date: '2026-06-12', period_number: 1, expires_at: '2026-12-12' },
  ],
  's-uuid-202': [
    { id: 'pur-3', category: '常態團體班', course_type: 1, status: '已完成', sessions: '6/6', price: '4800', date: '2026-05-01', period_number: 2, expires_at: '2026-08-01' },
  ],
};

export const mockDb = {
  // ── 客戶資料管理 ───────────────────────────────────────────
  customerParents(filters = {}) {
    const { status = 'all', venueId = '', name = '', phone = '', identity = '' } = filters;
    return CUSTOMER_PARENTS.filter((p) => {
      if (status === 'active' && !p.is_active) return false;
      if (status === 'inactive' && p.is_active) return false;
      if (venueId && p.primary_venue_id !== venueId) return false;
      if (identity && p.identity !== identity) return false;
      if (name && !(p.name || '').includes(name)) return false;
      if (phone && !(p.phone || '').includes(phone)) return false;
      return true;
    }).map((p) => ({
      ...p, line_bound: !!p.line_uid,
      student_count: CUSTOMER_STUDENTS.filter((s) => s.parent_id === p.id).length,
    }));
  },
  customerParentDetail(id) {
    const p = CUSTOMER_PARENTS.find((x) => x.id === id);
    if (!p) return null;
    return { ...p, line_bound: !!p.line_uid, students: CUSTOMER_STUDENTS.filter((s) => s.parent_id === id) };
  },
  createCustomerParent(body = {}) {
    const id = `p-uuid-${Date.now()}`;
    const p = {
      id, line_uid: null, phone: body.phone || '', name: body.name || '新家長',
      gender: body.gender || '', email: body.email || '', primary_venue_id: body.primary_venue_id || '',
      identity: body.identity || '一般身份', home_phone: body.home_phone || '', home_address: body.home_address || '',
      line_id: body.line_id || '', ragic_record_id: null, is_active: true, last_synced_at: null,
      family_id: `fam-uuid-${Date.now()}`,
    };
    CUSTOMER_PARENTS.unshift(p);
    return { ...p, line_bound: false, student_count: 0 };
  },
  updateCustomerParent(id, patch = {}) {
    const p = CUSTOMER_PARENTS.find((x) => x.id === id);
    if (!p) return null;
    const { students, ...fields } = patch;
    Object.assign(p, fields, { last_synced_at: '剛剛 (已本地編輯)' });
    if (Array.isArray(students)) {
      for (const s of students) {
        const hit = CUSTOMER_STUDENTS.find((x) => x.id === s.id);
        if (hit) Object.assign(hit, s);
        else if ((s.name || '').trim()) {
          CUSTOMER_STUDENTS.push({
            ...s, id: s.id || `s-uuid-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            parent_id: id, ragic_record_id: null, is_active: s.is_active !== false, last_synced_at: null,
          });
        }
      }
    }
    return this.customerParentDetail(id);
  },
  customerStudents(filters = {}) {
    const { name = '', gender = '', code = '', parentId = '' } = filters;
    return CUSTOMER_STUDENTS.filter((s) => {
      if (parentId && s.parent_id !== parentId) return false;
      if (gender && s.gender !== gender) return false;
      if (name && !(s.name || '').includes(name)) return false;
      if (code && !((s.student_code || '').includes(code) || (s.id_number || '').includes(code))) return false;
      return true;
    }).map((s) => this._withParent(s));
  },
  customerStudentDetail(id) {
    const s = CUSTOMER_STUDENTS.find((x) => x.id === id);
    if (!s) return null;
    return { ...this._withParent(s), purchases: CUSTOMER_PURCHASES[id] || [] };
  },
  updateCustomerStudent(id, patch = {}) {
    const s = CUSTOMER_STUDENTS.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch, { last_synced_at: '剛剛 (已本地編輯)' });
    return this._withParent(s);
  },
  _withParent(s) {
    const p = CUSTOMER_PARENTS.find((x) => x.id === s.parent_id) || {};
    return {
      ...s, parent_name: p.name || '', parent_phone: p.phone || '', parent_gender: p.gender || '',
      parent_identity: p.identity || '', parent_email: p.email || '', parent_venue_id: p.primary_venue_id || '',
    };
  },

  login(username, password) {
    const u = USERS.find((x) => x.username === username && x.password === password);
    return u ? { id: u.id, username: u.username, name: u.name, role: u.role, venue_id: u.venue_id, token: `mock-${u.id}-${Date.now()}` } : null;
  },

  // GET /ragic-status 的 demo 版（見上方 RAGIC_MOCK_* 說明）
  ragicStatus() {
    const env = { ...RAGIC_MOCK_ENV };
    const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
    const now = new Date();
    return {
      enabled: missing.length === 0,
      env,
      missing_env: missing,
      live_probe: JSON.parse(JSON.stringify({
        ...RAGIC_MOCK_LIVE_PROBE,
        cached: true,
      })),
      cron_schedule: '*/10 * * * *',
      next_cron_run_at: _ragicNextCron(now),
      // 深拷貝：避免頁面拿到 module 內部物件而被後續 setTimeout 變更「偷改」既有 render
      forms: JSON.parse(JSON.stringify(RAGIC_MOCK_FORMS)),
      now: now.toISOString(),
    };
  },
  // POST /ragic-status/sync?form=... 的 demo 版：先把目標表標成同步中，
  // 2.5 秒後就地標完成；頁面靠 5 秒輪詢 ragicStatus() 看到「同步中 → 成功」。
  ragicSync(form = 'all') {
    const jobs = form === 'all' ? Object.keys(RAGIC_MOCK_FORMS) : [form];
    for (const j of jobs) {
      const f = RAGIC_MOCK_FORMS[j];
      if (!f) continue;
      f.in_progress = true;
      f.last_triggered_by = 'manual';
      setTimeout(() => {
        const done = new Date();
        f.in_progress = false;
        f.last_status = 'ok';
        f.last_error = null;
        f.last_run_at = done.toISOString();
        f.last_success_at = done.toISOString();
        f.last_duration_ms = f.kind === 'healthcheck' ? 520 : 18000 + (f.last_count || 0) * 20;
      }, 2500);
    }
    return {
      ok: true, accepted: true, queued_jobs: jobs,
      message: '（demo）已排入背景同步，狀態會自動更新…',
    };
  },
  // POST /ragic-status/toggle 的 demo 版：就地改 admin_enabled，下一次 ragicStatus() 反映。
  ragicToggle(job, enabled) {
    const f = RAGIC_MOCK_FORMS[job];
    if (f) f.admin_enabled = !!enabled;
    return { ok: true, job, enabled: !!enabled, forms: JSON.parse(JSON.stringify(RAGIC_MOCK_FORMS)) };
  },

  staff(filters = {}) {
    let arr = STAFF.map((s) => withCoachProfile(s));
    const { status, venueId, role, name, phone, senior } = filters;
    if (status === 'active')   arr = arr.filter((s) => s.active);
    else if (status === 'inactive') arr = arr.filter((s) => !s.active);
    if (venueId) arr = arr.filter((s) => s.venue_id === venueId);
    if (role)    arr = arr.filter((s) => s.role === role);
    if (name)    arr = arr.filter((s) => (s.name || '').includes(name));
    if (phone)   arr = arr.filter((s) => (s.phone || '').includes(phone));
    if (senior === 'yes') arr = arr.filter((s) => s.is_senior);
    else if (senior === 'no') arr = arr.filter((s) => !s.is_senior);
    return arr;
  },
  updateStaff(id, patch) {
    const s = STAFF.find((x) => x.id === id);
    if (!s) return null;
    const { coach_active, ...staffPatch } = patch || {};
    Object.assign(s, staffPatch);
    if (coach_active !== undefined) setMockCoachProfile(s, !!coach_active);
    return withCoachProfile(s);
  },

  venues() { return VENUES.map((v) => ({ ...v })); },
  updateVenue(id, patch) {
    const v = VENUES.find((x) => x.id === id);
    if (!v) return null;
    Object.assign(v, patch);
    return { ...v };
  },

  // ── Task #32 教練資料 (F-C-Admin) ─────────────────────────────────────
  coaches(filters = {}) {
    let arr = COACHES_ADMIN.map((c) => ({ ...c, specialties: [...(c.specialties || [])], venue_ids: [...(c.venue_ids || [])] }));
    const { status, venueId, name, phone, senior } = filters;
    if (status === 'active')   arr = arr.filter((c) => c.is_active);
    else if (status === 'inactive') arr = arr.filter((c) => !c.is_active);
    if (venueId) arr = arr.filter((c) => (c.venue_ids || []).includes(venueId));
    if (name)    arr = arr.filter((c) => (c.name || '').includes(name));
    if (phone)   arr = arr.filter((c) => (c.phone || '').includes(phone));
    if (senior === 'yes') arr = arr.filter((c) => c.is_senior);
    else if (senior === 'no') arr = arr.filter((c) => !c.is_senior);
    return arr;
  },
  coachDetail(id) {
    const c = COACHES_ADMIN.find((x) => x.id === id);
    if (!c) return null;
    return { ...c, specialties: [...(c.specialties || [])], venue_ids: [...(c.venue_ids || [])], bio_media: [] };
  },
  updateCoach(id, patch) {
    const c = COACHES_ADMIN.find((x) => x.id === id);
    if (!c) return null;
    if (Array.isArray(patch.venue_ids)) c.venue_ids = [...patch.venue_ids];
    if (Array.isArray(patch.specialties)) c.specialties = [...patch.specialties];
    for (const k of ['email', 'is_senior', 'pricing_multiplier', 'bio_rich_text', 'is_active']) {
      if (patch[k] !== undefined) c[k] = patch[k];
    }
    return { ...c, specialties: [...c.specialties], venue_ids: [...c.venue_ids] };
  },

  settings() { return { ...SETTINGS }; },
  updateSettings(patch) { Object.assign(SETTINGS, patch); return { ...SETTINGS }; },

  courseTypes() { return COURSE_TYPES.map((t) => ({ ...t })); },
  createCourseType({ course_type, label, max_students }) {
    const ct = parseInt(course_type, 10);
    if (COURSE_TYPES.some((t) => t.course_type === ct)) {
      const e = new Error('exists'); e.response = { data: { error: `課程需求 ${ct} 已存在` } }; throw e;
    }
    const row = { course_type: ct, label, max_students: parseInt(max_students, 10), is_active: true, sort_order: COURSE_TYPES.length + 1 };
    COURSE_TYPES.push(row);
    return { ...row };
  },
  updateCourseType(type, patch) {
    const ct = parseInt(type, 10);
    const row = COURSE_TYPES.find((t) => t.course_type === ct);
    if (!row) return null;
    const oldLabel = row.label;
    Object.assign(row, patch);
    // Task #67：label 變更時同步未被覆寫的介紹 title
    if (patch && patch.label !== undefined && patch.label !== oldLabel) {
      const k = String(ct);
      const intro = COURSE_INTROS[k];
      if (intro && !intro.title_overridden) intro.title = row.label;
    }
    return { ...row };
  },
  deleteCourseType(type) {
    const ct = parseInt(type, 10);
    const i = COURSE_TYPES.findIndex((t) => t.course_type === ct);
    if (i >= 0) COURSE_TYPES.splice(i, 1);
    // Task #67：FK CASCADE 模擬 — 刪掉對應介紹
    delete COURSE_INTROS[String(ct)];
    return { ok: true };
  },

  courseIntros() {
    return COURSE_TYPES
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order || a.course_type - b.course_type)
      .map((c) => {
        const i = COURSE_INTROS[String(c.course_type)] || { title: c.label, body: '', image_url: '', title_overridden: false };
        return {
          course_type: c.course_type,
          label: c.label,
          is_active: c.is_active,
          sort_order: c.sort_order,
          base_price: Number(c.base_price || 0),
          title: i.title || c.label,
          body: i.body || '',
          image_url: i.image_url || '',
          title_overridden: !!i.title_overridden,
        };
      });
  },
  updateCourseIntro(courseType, patch) {
    const k = String(courseType);
    const cfg = COURSE_TYPES.find((c) => c.course_type === parseInt(k, 10));
    const label = cfg ? cfg.label : '';
    const cur = COURSE_INTROS[k] || { title: label, body: '', image_url: '', title_overridden: false };
    const next = { ...cur, ...patch };
    if (patch && patch.title !== undefined) {
      next.title_overridden = patch.title !== label;
    }
    COURSE_INTROS[k] = next;
    if (patch && patch.base_price !== undefined && cfg) {
      cfg.base_price = Number(patch.base_price) || 0;
    }
    return {
      course_type: parseInt(k, 10),
      title: next.title,
      body: next.body || '',
      image_url: next.image_url || '',
      title_overridden: !!next.title_overridden,
      base_price: cfg ? Number(cfg.base_price || 0) : 0,
    };
  },

  enrollments({ status, search, venueId } = {}) {
    let list = ENROLLMENTS.map((e) => ({ ...e, audit_logs: e.audit_logs.map((a) => ({ ...a })) }));
    if (status) list = list.filter((e) => e.status === status);
    if (venueId) list = list.filter((e) => e.venue_id === venueId);
    if (search) {
      const k = search.toLowerCase();
      list = list.filter((e) =>
        e.parent_name.toLowerCase().includes(k) ||
        e.parent_phone.includes(k) ||
        e.coach.toLowerCase().includes(k) ||
        e.students.some((s) => s.toLowerCase().includes(k)) ||
        e.id.toLowerCase().includes(k)
      );
    }
    return list.sort((a, b) => (b.submitted_at > a.submitted_at ? 1 : -1));
  },

  updateEnrollment(id, patch) {
    const e = ENROLLMENTS.find((x) => x.id === id);
    if (!e) throw new Error('報名不存在');
    if (['cancelled', 'refunded'].includes(e.status)) throw new Error('已結案報名不可編輯');
    if (patch.parent_name !== undefined) e.parent_name = patch.parent_name;
    if (patch.parent_phone !== undefined) e.parent_phone = patch.parent_phone;
    if (Array.isArray(patch.students)) e.students = patch.students;
    if (patch.coach !== undefined) e.coach = patch.coach;
    if (patch.course_type !== undefined) e.course_type = Number(patch.course_type);
    if (patch.original_price !== undefined) e.original_price = Number(patch.original_price);
    if (patch.final_price !== undefined) e.final_price = Number(patch.final_price);
    if (patch.transfer_last_5 !== undefined) e.transfer_last_5 = patch.transfer_last_5;
    if (Array.isArray(patch.extra_parent_phones)) e.extra_parent_phones = patch.extra_parent_phones;
    if (patch.notes !== undefined) e.notes = patch.notes;
    e.audit_logs.push({ at: new Date().toISOString().slice(0, 19), action: '後台編輯報名資料', by: 'admin' });
    return { ...e, audit_logs: e.audit_logs.map((a) => ({ ...a })) };
  },

  reconcile(id, by) {
    const e = ENROLLMENTS.find((x) => x.id === id);
    if (!e) return null;
    e.status = 'confirmed';
    e.total_sessions = SETTINGS.sessions_per_period;
    e.used_sessions = 0;
    e.audit_logs.push({ at: new Date().toISOString().slice(0, 19), action: '對帳通過', by });
    return { ...e };
  },

  refundEnrollment(id, reason, by) {
    const e = ENROLLMENTS.find((x) => x.id === id);
    if (!e) return null;
    const used = e.used_sessions || 0;
    const total = e.total_sessions || SETTINGS.sessions_per_period;
    const remainRatio = Math.max(0, (total - used) / total);
    const refund = Math.round(e.final_price * remainRatio * (1 - SETTINGS.refund_fee_rate));
    e.status = 'refunded';
    e.audit_logs.push({
      at: new Date().toISOString().slice(0, 19),
      action: `退課（理由：${reason}，退款 NT$ ${refund.toLocaleString()}）`,
      by,
    });
    return { ...e, refund_amount: refund };
  },

  refundPreview(id) {
    const e = ENROLLMENTS.find((x) => x.id === id);
    if (!e) return null;
    const used = e.used_sessions || 0;
    const total = e.total_sessions || SETTINGS.sessions_per_period;
    const remainRatio = Math.max(0, (total - used) / total);
    const refund = Math.round(e.final_price * remainRatio * (1 - SETTINGS.refund_fee_rate));
    return {
      enrollment: { ...e },
      total, used, remainRatio, fee_rate: SETTINGS.refund_fee_rate, refund_amount: refund,
    };
  },

  todaySessions(venueId) {
    return SESSIONS.filter((s) => !venueId || s.venue_id === venueId).map((s) => ({ ...s }));
  },

  // Task #55：依日期範圍 + 多場館篩選；mock 內僅有今日 4 筆，仍可示範回傳結構
  rangeSessions({ from, to, venueIds }) {
    return SESSIONS
      .filter((s) => (!from || s.date >= from) && (!to || s.date <= to))
      .filter((s) => !venueIds || !venueIds.length || venueIds.includes(s.venue_id))
      .map((s) => ({ ...s }));
  },

  // Task #60：mock 即時報到列表（依日期 + 場館過濾，最新在最上方）
  checkins({ venueId, date } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const day = date || today;
    const base = SESSIONS.filter((s) => s.date === day && (!venueId || s.venue_id === venueId));
    const now = Date.now();
    return base.map((s, i) => ({
      checkin_id: `mock-${s.id}-${i}`,
      at: new Date(now - i * 5 * 60 * 1000).toISOString(),
      session_id: s.id,
      period_id: s.id,
      venue_id: s.venue_id,
      venue_name: s.venue_name || s.venue_id,
      course_type: s.course_type || 1,
      coach: s.coach || '',
      student: (s.students && s.students[0]) || '示範學員',
    }));
  },

  verifyCheckin({ phone, periodId }) {
    const e = ENROLLMENTS.find((x) =>
      (!periodId || x.id === periodId) &&
      (!phone || x.parent_phone === phone)
    );
    if (!e) return { found: false };
    const session = SESSIONS.find((s) => s.coach === e.coach && s.venue_id === e.venue_id);
    return {
      found: true,
      enrollment: { ...e },
      session: session ? { ...session } : null,
    };
  },

  cancelledSessions() { return CANCELLED_SESSIONS.map((s) => ({ ...s })); },
  reviveSession(id) {
    const s = CANCELLED_SESSIONS.find((x) => x.id === id);
    if (!s) return null;
    s.refunded = true;
    const e = ENROLLMENTS.find((x) => x.id === s.period_id);
    if (e && e.used_sessions > 0) e.used_sessions -= 1;
    return { ...s };
  },

  _newId: (prefix) => nid(prefix),

  // ── 聊天監察（F-M03/F-A07 mock） ───────────────────────────────────
  adminChatRooms: ({ search, q } = {}) => {
    // 接受 search（與後端 /api/admin/chat/rooms?search= 對齊）；保留 q 為向後相容別名
    const kw = (search || q || '').trim();
    return CHAT_ROOMS_ADMIN.map((r) => {
      const msgs = CHAT_MSG_ADMIN[r.id] || [];
      const lm = msgs[msgs.length - 1];
      // 與 server services/chatRooms.js _hydrate 對齊的 shape
      const last_message = lm ? {
        sender_type: lm.sender_type,
        message_type: lm.message_type,
        content: lm.content || null,
        media_filename: lm.media_filename || null,
        created_at: lm.created_at,
      } : null;
      return { ...r, last_message, message_count: msgs.length };
    }).filter((r) => !kw
      || r.coach?.name?.includes(kw)
      || (r.student_names || []).some((n) => n.includes(kw))
      || r.id.includes(kw));
  },
  adminChatRoom: (id) => {
    const r = CHAT_ROOMS_ADMIN.find((x) => x.id === id);
    return r ? JSON.parse(JSON.stringify(r)) : null;
  },
  adminChatMessages: (roomId) => (CHAT_MSG_ADMIN[roomId] || []).map((m) => ({ ...m })),
  adminChatExport: (roomId) => {
    const room = CHAT_ROOMS_ADMIN.find((r) => r.id === roomId);
    return {
      room: room ? { ...room } : null,
      exported_at: new Date().toISOString(),
      messages: (CHAT_MSG_ADMIN[roomId] || []).map((m) => ({ ...m })),
    };
  },

  adminKeywords: () => KEYWORDS.map((k) => ({ ...k })),
  adminCreateKeyword: ({ keyword, category = '其他', is_active = true }) => {
    const k = { id: nid('KW'), keyword: keyword.trim(), category, is_active,
      created_at: new Date().toISOString() };
    KEYWORDS.push(k);
    return { ...k };
  },
  adminUpdateKeyword: (id, patch) => {
    const k = KEYWORDS.find((x) => x.id === id);
    if (!k) throw new Error('關鍵字不存在');
    Object.assign(k, patch);
    return { ...k };
  },
  adminDeleteKeyword: (id) => {
    const i = KEYWORDS.findIndex((x) => x.id === id);
    if (i === -1) throw new Error('關鍵字不存在');
    KEYWORDS.splice(i, 1);
    return { ok: true };
  },

  adminAlerts: ({ status } = {}) => ALERTS
    .filter((a) => !status || a.status === status)
    .map((a) => ({ ...a })),
  adminUpdateAlert: (id, patch) => {
    const a = ALERTS.find((x) => x.id === id);
    if (!a) throw new Error('警示不存在');
    Object.assign(a, patch, { reviewed_at: new Date().toISOString() });
    return { ...a };
  },

  activePromotions: () => PROMOTIONS
    .filter((p) => p.status === 'active')
    .map((p) => ({ ...p })),
  allPromotions: ({ status, q } = {}) => PROMOTIONS
    .filter((p) => (!status || p.status === status) && (!q || p.name.includes(q) || (p.coupon_code || '').includes(q)))
    .map((p) => ({ ...p })),
  createPromotion(payload = {}) {
    const now = new Date().toISOString();
    const row = {
      id: nid('P'),
      name: payload.name || '',
      description: payload.description || '',
      type: payload.type || 'PERCENTAGE',
      discount_value: String(payload.discount_value != null ? payload.discount_value : ''),
      min_threshold_type: payload.min_threshold_type || null,
      min_threshold_value: payload.min_threshold_value || null,
      applicable_course_types: payload.applicable_course_types && payload.applicable_course_types.length ? [...payload.applicable_course_types] : null,
      applicable_venue_ids: payload.applicable_venue_ids && payload.applicable_venue_ids.length ? [...payload.applicable_venue_ids] : null,
      coupon_code: payload.coupon_code ? String(payload.coupon_code).toUpperCase() : null,
      start_date: payload.start_date || todayISO(),
      end_date: payload.end_date || todayISO(),
      max_uses: payload.max_uses || null,
      current_uses: 0,
      status: 'draft', review_note: null,
      created_by: 'U001', reviewed_by: null, reviewed_at: null, submitted_at: null,
      created_at: now, updated_at: now,
    };
    PROMOTIONS.unshift(row);
    return { ...row };
  },
  updatePromotion(id, patch = {}) {
    const p = PROMOTIONS.find((x) => x.id === id);
    if (!p) { const e = new Error('not found'); e.response = { data: { error: '優惠不存在' } }; throw e; }
    if (!['draft', 'rejected'].includes(p.status)) {
      const e = new Error('not editable'); e.response = { data: { error: `狀態 ${p.status} 不可編輯，已啟用的優惠請刪除後重建` } }; throw e;
    }
    for (const k of ['name', 'description', 'type', 'min_threshold_type', 'min_threshold_value', 'start_date', 'end_date', 'max_uses']) {
      if (patch[k] !== undefined) p[k] = patch[k];
    }
    if (patch.discount_value !== undefined) p.discount_value = String(patch.discount_value);
    if (patch.applicable_course_types !== undefined) p.applicable_course_types = patch.applicable_course_types && patch.applicable_course_types.length ? [...patch.applicable_course_types] : null;
    if (patch.applicable_venue_ids !== undefined) p.applicable_venue_ids = patch.applicable_venue_ids && patch.applicable_venue_ids.length ? [...patch.applicable_venue_ids] : null;
    if (patch.coupon_code !== undefined) p.coupon_code = patch.coupon_code ? String(patch.coupon_code).toUpperCase() : null;
    p.updated_at = new Date().toISOString();
    return { ...p };
  },
  transitionPromotion(id, toStatus) {
    const p = PROMOTIONS.find((x) => x.id === id);
    if (!p) { const e = new Error('not found'); e.response = { data: { error: '優惠不存在' } }; throw e; }
    // 對齊後端狀態機：上架僅限 draft/rejected；停用不可對已停用者重複執行
    const allowedFrom = toStatus === 'active'
      ? ['draft', 'rejected']
      : toStatus === 'archived'
        ? ['draft', 'pending_review', 'active', 'rejected']
        : null;
    if (allowedFrom && !allowedFrom.includes(p.status)) {
      const e = new Error('bad transition');
      e.response = { data: { error: `當前狀態 ${p.status} 無法執行此操作` } };
      throw e;
    }
    p.status = toStatus;
    p.updated_at = new Date().toISOString();
    if (toStatus === 'active') { p.reviewed_at = p.updated_at; p.reviewed_by = 'U001'; }
    return { ...p };
  },
  deletePromotion(id) {
    const i = PROMOTIONS.findIndex((x) => x.id === id);
    if (i === -1) { const e = new Error('not found'); e.response = { data: { error: '優惠不存在' } }; throw e; }
    if ((PROMOTIONS[i].current_uses || 0) > 0) {
      const e = new Error('has usage'); e.response = { data: { error: '此優惠已有使用紀錄，無法刪除，請改用「停用」' } }; throw e;
    }
    PROMOTIONS.splice(i, 1);
    return { ok: true, deleted: id };
  },
};

// ── Phase 4 mock 資料：admin 聊天監察 + 關鍵字 + 警示 ─────────────────
const CHAT_ROOMS_ADMIN = [
  { id: 'CR001', coach: { id: 'C001', name: '王志強' }, venue: { id: 'B', name: '夢想體育學院 板橋館' },
    course_type: 1, period_status: 'active', student_names: ['張小明'] },
  { id: 'CR002', coach: { id: 'C002', name: '林佳穎' }, venue: { id: 'B', name: '夢想體育學院 板橋館' },
    course_type: 2, period_status: 'pending_payment', student_names: ['張小美', '李小龍'] },
];
const CHAT_MSG_ADMIN = {
  CR001: [
    { id: 'MSG001', message_type: 'text', sender_type: 'coach', sender_name: '王志強',
      content: '張媽媽您好，今天上課表現很好！', created_at: new Date(Date.now() - 86400000).toISOString() },
    { id: 'MSG002', message_type: 'text', sender_type: 'parent', sender_name: '張媽媽',
      content: '太棒了，謝謝教練！可以加你 line 嗎？', created_at: new Date(Date.now() - 86000000).toISOString() },
    { id: 'MSG003', message_type: 'text', sender_type: 'coach', sender_name: '王志強',
      content: '不好意思，學院規定統一在這裡溝通哦～', created_at: new Date(Date.now() - 3600000).toISOString() },
  ],
  CR002: [],
};
const KEYWORDS = [
  { id: 'KW001', keyword: '加 line', category: '私下交易', is_active: true, created_at: new Date().toISOString() },
  { id: 'KW002', keyword: '私下',    category: '私下交易', is_active: true, created_at: new Date().toISOString() },
  { id: 'KW003', keyword: '紅包',    category: '違規收費', is_active: true, created_at: new Date().toISOString() },
  { id: 'KW004', keyword: '退費',    category: '客訴風險', is_active: true, created_at: new Date().toISOString() },
];
const ALERTS = [
  { id: 'AL001', triggered_keyword: '加 line', status: 'pending',
    coach_name: '王志強', venue_name: '夢想體育學院 板橋館',
    chat_room_id: 'CR001', message_id: 'MSG002',
    sender_type: 'parent',
    message_content: '太棒了，謝謝教練！可以加你 line 嗎？',
    message_at: new Date(Date.now() - 86000000).toISOString(),
    created_at: new Date(Date.now() - 86000000).toISOString(),
    reviewed_at: null, review_note: null },
];

const PROMOTIONS = [
  {
    id: 'P001', name: '春節 95 折', description: '全館自動套用',
    type: 'PERCENTAGE', discount_value: '0.9500',
    min_threshold_type: null, min_threshold_value: null,
    applicable_course_types: null, applicable_venue_ids: null,
    coupon_code: null,
    start_date: todayISO(), end_date: (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().slice(0, 10); })(),
    max_uses: null, current_uses: 12,
    status: 'active', review_note: null,
    created_by: 'U001', reviewed_by: 'U001',
    reviewed_at: new Date(Date.now() - 86400000 * 3).toISOString(),
    submitted_at: new Date(Date.now() - 86400000 * 4).toISOString(),
    created_at: new Date(Date.now() - 86400000 * 5).toISOString(),
    updated_at: new Date(Date.now() - 86400000 * 3).toISOString(),
  },
  {
    id: 'P002', name: '新生優惠 NT$500', description: '首次報名 1 對 1 折抵 500',
    type: 'FIXED_AMOUNT', discount_value: '500',
    min_threshold_type: 'PERIOD_COUNT', min_threshold_value: 1,
    applicable_course_types: [1], applicable_venue_ids: null,
    coupon_code: 'NEW500',
    start_date: todayISO(), end_date: (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })(),
    max_uses: 50, current_uses: 8,
    status: 'active', review_note: null,
    created_by: 'U002', reviewed_by: 'U001',
    reviewed_at: new Date(Date.now() - 86400000 * 2).toISOString(),
    submitted_at: new Date(Date.now() - 86400000 * 3).toISOString(),
    created_at: new Date(Date.now() - 86400000 * 4).toISOString(),
    updated_at: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
];
