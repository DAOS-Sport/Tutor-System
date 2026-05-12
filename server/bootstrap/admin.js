/**
 * Admin Phase 3 後端 bootstrap：
 * - 啟動時保證 admin_* 系列表存在（idempotent，沿用 db/migrations/002_admin_tables.sql）
 * - 第一次啟動時 seed 預設資料（員工 / 場館 / 系統設定 / 課程介紹 / 報名 / 時段）
 *   讓後台 build 加 VITE_USE_MOCK=false 後即可立即跑通。
 *
 * 密碼一律用 bcrypt hash 存 admin_users.password_hash。
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../models/db');

const MIGRATION_FILE = path.join(__dirname, '..', '..', 'db', 'migrations', '002_admin_tables.sql');

function relDays(days, hh = 9, mm = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

/**
 * 預設帳號 — 為了讓 dev / staging 啟動就能登入，但「帳號 = 密碼」這種 well-known
 * credential 不得進到 production。
 *
 * 規則：
 * - non-production：使用 DEFAULT_USERS 內的弱密碼，方便開發 / demo / 自動化測試
 * - production：必須提供 ADMIN_BOOTSTRAP_PASSWORD；若沒提供，跳過 user seed
 *   且警告 operator 必須手動建立第一個帳號（避免任何 well-known credential
 *   流入 production）。
 */
const DEFAULT_USERS = [
  { id: 'U001', username: 'admin',   password: 'admin',   name: '系統管理員', role: 'admin',   venue_id: null },
  { id: 'U002', username: 'manager', password: 'manager', name: '王主管',     role: 'manager', venue_id: 'B' },
  { id: 'U003', username: 'staff',   password: 'staff',   name: '小林櫃檯',   role: 'staff',   venue_id: 'B' },
];

const IS_PROD = process.env.NODE_ENV === 'production';

const DEFAULT_VENUES = [
  { id: 'B', code: 'B', name: '夢想體育學院 板橋館', address: '新北市板橋區文化路一段 188 號 3 樓',
    line_token: 'CHANNEL_TOKEN_B_xxxxxxxx', bank_institution_name: '玉山銀行', bank_branch_name: '板橋分行',
    account_holder: '駿斯運動事業股份有限公司', account_number: '0123-456-789012' },
  { id: 'C', code: 'C', name: '夢想體育學院 中和館', address: '新北市中和區景平路 268 號 B1',
    line_token: 'CHANNEL_TOKEN_C_xxxxxxxx', bank_institution_name: '國泰世華銀行', bank_branch_name: '中和分行',
    account_holder: '駿斯運動事業股份有限公司', account_number: '0987-654-321098' },
  { id: 'X', code: 'X', name: '夢想體育學院 新莊館', address: '新北市新莊區中正路 10 號 2 樓',
    line_token: '', bank_institution_name: '台新銀行', bank_branch_name: '新莊分行',
    account_holder: '駿斯運動事業股份有限公司', account_number: '5566-7788-990011' },
];

const DEFAULT_STAFF = [
  { id: 'C001', name: '王志強', role: 'coach',   venue_id: 'B', phone: '0911000001', is_senior: true,  multiplier: 1.30, active: true },
  { id: 'C002', name: '林佳穎', role: 'coach',   venue_id: 'B', phone: '0911000002', is_senior: true,  multiplier: 1.50, active: true },
  { id: 'C003', name: '張嘉豪', role: 'coach',   venue_id: 'C', phone: '0911000003', is_senior: false, multiplier: 1.00, active: true },
  { id: 'C004', name: '黃詩涵', role: 'coach',   venue_id: 'X', phone: '0911000004', is_senior: false, multiplier: 1.10, active: true },
  { id: 'M001', name: '王主管', role: 'manager', venue_id: 'B', phone: '0922000001', is_senior: false, multiplier: 1.00, active: true },
  { id: 'S001', name: '小林櫃檯', role: 'staff', venue_id: 'B', phone: '0933000001', is_senior: false, multiplier: 1.00, active: true },
];

const DEFAULT_SETTINGS = {
  sessions_per_period:    6,
  validity_days:        365,
  expiry_notice_days:    60,
  refund_fee_rate:        0.10,
  transfer_fee:         500,
  default_session_minutes: 60,
  multi_confirm_minutes:   60,
};

const DEFAULT_COURSE_INTROS = [
  { course_type: 1, title: '1 對 1 個別班', body: '完全客製化的訓練內容，最高效率提升個人技術。', image_url: '' },
  { course_type: 2, title: '1 對 2 雙人班', body: '與好友或家人共同上課，互相學習，CP 值高。',     image_url: '' },
  { course_type: 3, title: '1 對 3 三人班', body: '小團體互動性最強，適合朋友揪團、節省花費。',   image_url: '' },
];

// 報名 + audit log seed（與 mock.js 同步）
const DEFAULT_ENROLLMENTS = [
  // ===== 待對帳 8 筆 =====
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

  // ===== 已對帳尚未開課 3 筆 =====
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

  // ===== 進行中 7 筆 =====
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

  // ===== 取消 / 退費 4 筆 =====
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
    total_sessions: 6, used_sessions: 2, refund_amount: 6669,
    audit_logs: [
      { at: relDays(-50, 11, 0), action: '家長送出報名', by: '何爸爸' },
      { at: relDays(-50, 12, 0), action: '對帳通過', by: '王主管' },
      { at: relDays(-10, 14, 30), action: '退課（理由：搬家無法繼續上課，退款 NT$ 6,669）', by: '王主管', reason: '搬家無法繼續上課', refund_amount: 6669 },
    ] },
  { id: 'CP1020', parent_name: '葉媽媽', parent_phone: '0922567890', students: ['葉小晨'],
    coach: '張嘉豪', venue_id: 'C', course_type: 1, original_price: 9000, final_price: 8550,
    transfer_last_5: '77000', status: 'refunded', submitted_at: relDays(-60, 10, 0),
    total_sessions: 6, used_sessions: 4, refund_amount: 2565,
    audit_logs: [
      { at: relDays(-60, 10, 0), action: '家長送出報名', by: '葉媽媽' },
      { at: relDays(-60, 11, 0), action: '對帳通過', by: '王主管' },
      { at: relDays(-15, 15, 0), action: '退課（理由：時間衝突，退款 NT$ 2,565）', by: '王主管', reason: '時間衝突', refund_amount: 2565 },
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
];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DEFAULT_TODAY_SESSIONS = [
  { id: 'SE001', date: todayISO(), start_time: '14:00', end_time: '15:00', venue_id: 'B', coach: '王志強', students: ['張小明'], course_type: 1, checkin_status: 'checked_in' },
  { id: 'SE002', date: todayISO(), start_time: '15:00', end_time: '16:00', venue_id: 'B', coach: '林佳穎', students: ['張小美', '李小龍'], course_type: 2, checkin_status: 'not_yet' },
  { id: 'SE003', date: todayISO(), start_time: '17:00', end_time: '18:00', venue_id: 'C', coach: '張嘉豪', students: ['陳小米'], course_type: 1, checkin_status: 'not_yet' },
  { id: 'SE004', date: todayISO(), start_time: '18:00', end_time: '19:00', venue_id: 'X', coach: '黃詩涵', students: ['Lulu', 'Tom', 'Amy'], course_type: 3, checkin_status: 'absent' },
];

const DEFAULT_CANCELLED_SESSIONS = [
  { id: 'SX001', date: '2026-04-22', start_time: '15:00', period_id: 'CP1004', parent_name: '張媽媽', coach: '王志強', venue_id: 'B', refunded: false },
  { id: 'SX002', date: '2026-04-25', start_time: '17:00', period_id: 'CP1005', parent_name: '陳媽媽', coach: '黃詩涵', venue_id: 'X', refunded: true },
];

async function ensureSchema() {
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  await pool.query(sql);
  // Task #32 補強：admin_venues 加 is_active，與 LIFF venues.is_active 對齊，
  // 讓 syncVenuesFromRagic 能對兩表一致軟下架。
  await pool.query(
    `ALTER TABLE admin_venues ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`
  );
  // Task #39：對帳時記錄發票資訊
  await pool.query(`ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(20)`);
  await pool.query(`ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS invoice_image_url TEXT`);
  await pool.query(`ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS invoice_url TEXT`);
  await pool.query(`ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS invoice_issued_at TIMESTAMPTZ`);
  // 多組家庭：額外家長手機（供 LIFF 課程查詢 OR 條件）
  await pool.query(`ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS extra_parent_phones TEXT[] NOT NULL DEFAULT '{}'`);
  // 後台備注欄
  await pool.query(`ALTER TABLE admin_enrollments ADD COLUMN IF NOT EXISTS notes TEXT`);
}

async function seedIfEmpty() {
  // Task #51 5A-5b：admin_users / admin_staff seed 已移除，全部改寫到 employees。
  // - admin_users seed → employees seed（admin/manager/staff 三個 seed 帳號的「username」放在 email 欄；
  //                       roles[] 用新 role 名：admin→system_admin / manager→manager / staff→counter）
  // - admin_staff seed → 不再 seed（coaches 已於 Task #51 step 1 一次性遷入 employees）
  //
  // 帳號 seed/同步行為（同舊版邏輯，只是 target 換成 employees）：
  //   - employees 中無 seed 帳號：首次 seed
  //       * IS_PROD + 無 ADMIN_BOOTSTRAP_PASSWORD：warn skip
  //       * 否則：INSERT 三筆，密碼用 env 或 DEFAULT_USERS 弱密碼
  //   - 已存在 + ADMIN_BOOTSTRAP_PASSWORD：production 每次同步；dev 只有 ADMIN_FORCE_RESET_ON_BOOT=true 才同步
  //   - 已存在 + 無 ADMIN_BOOTSTRAP_PASSWORD + IS_PROD：noop（正常情況）
  const ROLE_MAP = { admin: 'system_admin', manager: 'manager', staff: 'counter' };
  const seedEmails = DEFAULT_USERS.map((x) => x.username);
  const u = await pool.query(
    `SELECT COUNT(*)::int AS n FROM employees WHERE email = ANY($1::text[])`,
    [seedEmails]
  );
  const bootstrapPwd = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (u.rows[0].n === 0) {
    if (IS_PROD && !bootstrapPwd) {
      console.warn(
        '[admin bootstrap] SKIPPED employees admin seed in production: ' +
        '請在 Replit Secrets 設定 ADMIN_BOOTSTRAP_PASSWORD（將會套用到 admin/manager/staff 三個 seed 帳號）後再重新啟動。' +
        '若已透過其他方式建立第一個 admin 帳號，可忽略此警告。'
      );
    } else {
      const useEnvPwd = !!bootstrapPwd;
      for (const x of DEFAULT_USERS) {
        const pwd = useEnvPwd ? bootstrapPwd : x.password;
        const hash = await bcrypt.hash(pwd, 10);
        await pool.query(
          `INSERT INTO employees (email, password_hash, name, roles, venue_id, is_active)
           VALUES ($1, $2, $3, $4::text[], $5, TRUE)
           ON CONFLICT (email) DO NOTHING`,
          [x.username, hash, x.name, [ROLE_MAP[x.role]], x.venue_id]
        );
      }
      if (useEnvPwd) {
        console.log('[admin bootstrap] seeded employees admin accounts (3 accounts, password = ADMIN_BOOTSTRAP_PASSWORD)');
      } else {
        console.log('[admin bootstrap] seeded employees admin accounts (3 dev accounts: admin/manager/staff with weak passwords — NODE_ENV != production)');
      }
    }
  } else if (bootstrapPwd && (IS_PROD || process.env.ADMIN_FORCE_RESET_ON_BOOT === 'true')) {
    const hash = await bcrypt.hash(bootstrapPwd, 10);
    await pool.query(
      `UPDATE employees SET password_hash = $1 WHERE email = ANY($2::text[])`,
      [hash, seedEmails]
    );
    console.log('[admin bootstrap] synced seed employee passwords from ADMIN_BOOTSTRAP_PASSWORD (IS_PROD=' + IS_PROD + ')');
  } else if (!bootstrapPwd && IS_PROD) {
    console.log('[admin bootstrap] employees admin accounts already seeded, skipping password sync (no ADMIN_BOOTSTRAP_PASSWORD)');
  }

  // Venues
  const v = await pool.query('SELECT COUNT(*)::int AS n FROM admin_venues');
  if (v.rows[0].n === 0) {
    for (const x of DEFAULT_VENUES) {
      await pool.query(
        `INSERT INTO admin_venues (id, code, name, address, line_token, bank_institution_name, bank_branch_name, account_holder, account_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [x.id, x.code, x.name, x.address, x.line_token, x.bank_institution_name, x.bank_branch_name, x.account_holder, x.account_number]
      );
    }
    console.log('[admin bootstrap] seeded admin_venues (3 venues)');
  }

  // Task #51 5A-5b：admin_staff seed 已移除（DEFAULT_STAFF 同保留為歷史參考但不再 INSERT）。
  // coaches 已於 Task #51 step 1 一次性遷入 employees；非教練的 manager/counter 由 Ragic sync
  // 或 employees admin seed 維護，不需要 admin_staff 這條 legacy 路徑。

  // Settings
  const st = await pool.query('SELECT COUNT(*)::int AS n FROM admin_settings');
  if (st.rows[0].n === 0) {
    for (const [k, val] of Object.entries(DEFAULT_SETTINGS)) {
      await pool.query(
        `INSERT INTO admin_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [k, val]
      );
    }
    console.log('[admin bootstrap] seeded admin_settings (7 keys)');
  }

  // Course intros
  const c = await pool.query('SELECT COUNT(*)::int AS n FROM admin_course_intros');
  if (c.rows[0].n === 0) {
    for (const x of DEFAULT_COURSE_INTROS) {
      await pool.query(
        `INSERT INTO admin_course_intros (course_type, title, body, image_url)
         VALUES ($1,$2,$3,$4) ON CONFLICT (course_type) DO NOTHING`,
        [x.course_type, x.title, x.body, x.image_url]
      );
    }
    console.log('[admin bootstrap] seeded admin_course_intros (3 types)');
  }

  // Enrollments + audit logs
  const e = await pool.query('SELECT COUNT(*)::int AS n FROM admin_enrollments');
  if (e.rows[0].n === 0) {
    for (const x of DEFAULT_ENROLLMENTS) {
      await pool.query(
        `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, coach, venue_id, course_type,
          original_price, final_price, transfer_last_5, status, submitted_at,
          total_sessions, used_sessions, refund_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [x.id, x.parent_name, x.parent_phone, x.students, x.coach, x.venue_id, x.course_type,
         x.original_price, x.final_price, x.transfer_last_5, x.status, x.submitted_at,
         x.total_sessions || null, x.used_sessions || null, x.refund_amount || null]
      );
      for (const a of x.audit_logs) {
        await pool.query(
          `INSERT INTO admin_enrollment_audit_logs (enrollment_id, at, action, by_user, reason, refund_amount)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [x.id, a.at, a.action, a.by, a.reason || null, a.refund_amount || null]
        );
      }
    }
    console.log(`[admin bootstrap] seeded admin_enrollments (${DEFAULT_ENROLLMENTS.length} records)`);
  }

  // Today sessions
  const ts = await pool.query('SELECT COUNT(*)::int AS n FROM admin_today_sessions');
  if (ts.rows[0].n === 0) {
    for (const x of DEFAULT_TODAY_SESSIONS) {
      await pool.query(
        `INSERT INTO admin_today_sessions (id, date, start_time, end_time, venue_id, coach, students, course_type, checkin_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [x.id, x.date, x.start_time, x.end_time, x.venue_id, x.coach, x.students, x.course_type, x.checkin_status]
      );
    }
    console.log('[admin bootstrap] seeded admin_today_sessions (4 sessions)');
  }

  // Cancelled sessions
  const cs = await pool.query('SELECT COUNT(*)::int AS n FROM admin_cancelled_sessions');
  if (cs.rows[0].n === 0) {
    for (const x of DEFAULT_CANCELLED_SESSIONS) {
      await pool.query(
        `INSERT INTO admin_cancelled_sessions (id, date, start_time, period_id, parent_name, coach, venue_id, refunded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [x.id, x.date, x.start_time, x.period_id, x.parent_name, x.coach, x.venue_id, x.refunded]
      );
    }
    console.log('[admin bootstrap] seeded admin_cancelled_sessions (2 records)');
  }
}

async function bootstrap() {
  try {
    await ensureSchema();
    await seedIfEmpty();
    console.log('[admin bootstrap] ready (admin_* tables verified)');
  } catch (err) {
    console.error('[admin bootstrap] FAILED:', err.message);
    throw err;
  }
}

module.exports = { bootstrap };
