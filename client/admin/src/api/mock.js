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
// 真實環境會由 syncCoachesFromRagic 填入 coaches 表
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
];

const SETTINGS = {
  sessions_per_period:    6,
  validity_days:        365,
  expiry_notice_days:    60,
  refund_fee_rate:        0.10,
  transfer_fee:         500,
  default_session_minutes: 60,
  multi_confirm_minutes:   60,
};

const COURSE_INTROS = {
  1: { title: '1 對 1 個別班', body: '完全客製化的訓練內容，最高效率提升個人技術。', image_url: '' },
  2: { title: '1 對 2 雙人班', body: '與好友或家人共同上課，互相學習，CP 值高。',     image_url: '' },
  3: { title: '1 對 3 三人班', body: '小團體互動性最強，適合朋友揪團、節省花費。',   image_url: '' },
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

export const mockDb = {
  login(username, password) {
    const u = USERS.find((x) => x.username === username && x.password === password);
    return u ? { id: u.id, username: u.username, name: u.name, role: u.role, venue_id: u.venue_id, token: `mock-${u.id}-${Date.now()}` } : null;
  },

  staff(filters = {}) {
    let arr = STAFF.map((s) => ({ ...s }));
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
    Object.assign(s, patch);
    return { ...s };
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

  courseIntros() { return JSON.parse(JSON.stringify(COURSE_INTROS)); },
  updateCourseIntro(courseType, patch) {
    const k = String(courseType);
    if (!COURSE_INTROS[k]) return null;
    COURSE_INTROS[k] = { ...COURSE_INTROS[k], ...patch };
    return { ...COURSE_INTROS[k] };
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
