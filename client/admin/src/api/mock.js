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

// 報名 + 對帳 mock
let _seq = 1000;
function nid(prefix = 'CP') { return `${prefix}${++_seq}`; }

const ENROLLMENTS = [
  {
    id: 'CP1001', parent_name: '張媽媽', parent_phone: '0912345678', students: ['張小明'],
    coach: '王志強', venue_id: 'B', course_type: 1,
    original_price: 11700, final_price: 11115,
    transfer_last_5: '12345', status: 'pending_payment',
    submitted_at: `${todayISO()}T09:30:00`, audit_logs: [
      { at: `${todayISO()}T09:30:00`, action: '家長送出報名', by: '張媽媽' },
    ],
  },
  {
    id: 'CP1002', parent_name: '李爸爸', parent_phone: '0922333444', students: ['李小龍', '張小美'],
    coach: '林佳穎', venue_id: 'B', course_type: 2,
    original_price: 9000, final_price: 8550,
    transfer_last_5: '67890', status: 'pending_payment',
    submitted_at: `${todayISO()}T10:15:00`, audit_logs: [
      { at: `${todayISO()}T10:15:00`, action: '家長送出報名', by: '李爸爸' },
    ],
  },
  {
    id: 'CP1003', parent_name: '陳媽媽', parent_phone: '0933555777', students: ['陳小米'],
    coach: '張嘉豪', venue_id: 'C', course_type: 1,
    original_price: 9000, final_price: 8550,
    transfer_last_5: '24680', status: 'confirmed',
    submitted_at: '2026-04-28T14:00:00',
    audit_logs: [
      { at: '2026-04-28T14:00:00', action: '家長送出報名', by: '陳媽媽' },
      { at: '2026-04-28T15:20:00', action: '對帳通過', by: '王主管' },
    ],
    total_sessions: 6, used_sessions: 1,
  },
  {
    id: 'CP1004', parent_name: '張媽媽', parent_phone: '0912345678', students: ['張小明'],
    coach: '王志強', venue_id: 'B', course_type: 1,
    original_price: 11700, final_price: 11115,
    transfer_last_5: '99999', status: 'active',
    submitted_at: '2026-04-10T09:00:00',
    audit_logs: [
      { at: '2026-04-10T09:00:00', action: '家長送出報名', by: '張媽媽' },
      { at: '2026-04-10T11:00:00', action: '對帳通過', by: '王主管' },
    ],
    total_sessions: 6, used_sessions: 3,
  },
  {
    id: 'CP1005', parent_name: '陳媽媽', parent_phone: '0933555777', students: ['陳小米'],
    coach: '黃詩涵', venue_id: 'X', course_type: 3,
    original_price: 4950, final_price: 4702,
    transfer_last_5: '11122', status: 'cancelled',
    submitted_at: '2026-03-15T08:30:00',
    audit_logs: [
      { at: '2026-03-15T08:30:00', action: '家長送出報名', by: '陳媽媽' },
      { at: '2026-03-15T10:00:00', action: '對帳通過', by: '王主管' },
      { at: '2026-04-25T16:00:00', action: '主管取消', by: '王主管' },
    ],
    total_sessions: 6, used_sessions: 0,
  },
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

  staff() { return STAFF.map((s) => ({ ...s })); },
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
};
