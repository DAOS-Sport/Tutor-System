// Centralized Mock dataset for Phase 1 (no backend wiring yet).
// All API modules under client/liff/src/api/ pull from here when
// VITE_USE_MOCK !== "false" or when backend returns 501.

const VENUES = [
  {
    id: 'B',
    code: 'B',
    name: '夢想體育學院 板橋館',
    address: '新北市板橋區文化路一段 188 號 3 樓',
    bank_institution_name: '玉山銀行',
    bank_branch_name: '板橋分行',
    account_holder: '駿斯運動事業股份有限公司',
    account_number: '0123-456-789012',
  },
  {
    id: 'C',
    code: 'C',
    name: '夢想體育學院 中和館',
    address: '新北市中和區景平路 268 號 B1',
    bank_institution_name: '國泰世華銀行',
    bank_branch_name: '中和分行',
    account_holder: '駿斯運動事業股份有限公司',
    account_number: '0987-654-321098',
  },
  {
    id: 'X',
    code: 'X',
    name: '夢想體育學院 新莊館',
    address: '新北市新莊區中正路 10 號 2 樓',
    bank_institution_name: '台新銀行',
    bank_branch_name: '新莊分行',
    account_holder: '駿斯運動事業股份有限公司',
    account_number: '5566-7788-990011',
  },
];

const COACHES = [
  {
    id: 'C001',
    name: '王志強',
    venues: ['B', 'C'],
    is_senior: true,
    multiplier: 1.3,
    bio: '前國家代表隊選手，10 年青少年訓練經驗。專長：基本動作矯正與比賽節奏培養。',
    tags: ['含學習歷程服務', '比賽輔導'],
    avatar: null,
  },
  {
    id: 'C002',
    name: '林佳穎',
    venues: ['B'],
    is_senior: true,
    multiplier: 1.5,
    bio: '英國 LTA Level 3 認證教練，擅長 6-12 歲基礎培訓。',
    tags: ['含學習歷程服務', '兒童專家'],
    avatar: null,
  },
  {
    id: 'C003',
    name: '張嘉豪',
    venues: ['B', 'C', 'X'],
    is_senior: false,
    multiplier: 1.0,
    bio: '熱情活潑、耐心十足，新進教練。',
    tags: [],
    avatar: null,
  },
  {
    id: 'C004',
    name: '黃詩涵',
    venues: ['C', 'X'],
    is_senior: false,
    multiplier: 1.1,
    bio: '具備 5 年場館團體班經驗，授課風格輕鬆。',
    tags: [],
    avatar: null,
  },
];

// 各組別基本費用（單期 6 堂）
const BASE_PRICES = {
  1: 9000,
  2: 6000,
  3: 4500,
};

const PROMOTIONS = [
  {
    id: 'P_NEW2026',
    title: '新春開課優惠 95 折',
    description: '4 月底前報名任一組別，自動享 95 折',
    type: 'PERCENTAGE',
    value: 0.95,
    threshold: { type: 'PERIOD_COUNT', value: 1 },
    expires_at: '2026-05-31',
    is_auto_apply: true,
  },
  {
    id: 'P_2PERIOD',
    title: '一次購買 2 期 9 折',
    description: '同教練同組別，一次預購 2 期享 9 折',
    type: 'PERCENTAGE',
    value: 0.9,
    threshold: { type: 'PERIOD_COUNT', value: 2 },
    expires_at: '2026-12-31',
    is_auto_apply: false,
  },
];

// 模擬已存在的家長（手機 → 家長物件）
const PARENTS = {
  '0912345678': {
    id: 'P0001',
    name: '張媽媽',
    phone: '0912345678',
    gender: '女',
    email: 'mama.chang@example.com',
    primary_venue_id: 'B',
    students: [
      { id: 'S0001', name: '張小明', id_number: 'A123456789', birth_date: '2015-03-12', gender: '男' },
      { id: 'S0002', name: '張小美', id_number: 'A223456788', birth_date: '2017-08-05', gender: '女' },
    ],
  },
  '0922333444': {
    id: 'P0002',
    name: '李爸爸',
    phone: '0922333444',
    gender: '男',
    email: 'lee.papa@example.com',
    primary_venue_id: 'B',
    students: [
      { id: 'S0010', name: '李小龍', id_number: 'A187654321', birth_date: '2014-11-30', gender: '男' },
    ],
  },
  '0933555777': {
    id: 'P0003',
    name: '陳媽媽',
    phone: '0933555777',
    gender: '女',
    email: '',
    primary_venue_id: 'C',
    students: [
      { id: 'S0020', name: '陳小米', id_number: 'A287777111', birth_date: '2016-02-20', gender: '女' },
    ],
  },
};

// 模擬已開通的課程期（屬於 P0001 張媽媽）
const COURSE_PERIODS = [
  {
    id: 'CP0001',
    parent_id: 'P0001',
    coach: { id: 'C001', name: '王志強', is_senior: true },
    venue: { id: 'B', name: '夢想體育學院 板橋館' },
    course_type: 1,
    students: [{ id: 'S0001', name: '張小明' }],
    total_sessions: 6,
    used_sessions: 2,
    expires_at: '2026-12-15',
    original_price: 9000,
    final_price: 11115, // 9000 * 1.3 * 0.95
    payment_status: 'active',
    is_experience_course: false,
  },
  {
    id: 'CP0002',
    parent_id: 'P0001',
    coach: { id: 'C002', name: '林佳穎', is_senior: true },
    venue: { id: 'B', name: '夢想體育學院 板橋館' },
    course_type: 2,
    students: [
      { id: 'S0002', name: '張小美' },
      { id: 'S0010', name: '李小龍' },
    ],
    total_sessions: 6,
    used_sessions: 0,
    expires_at: '2027-04-30',
    original_price: 6000,
    final_price: 8550, // 6000 * 1.5 * 0.95
    payment_status: 'pending_payment',
    transfer_last_5: '12345',
    is_experience_course: false,
  },
  {
    id: 'CP0003',
    parent_id: 'P0001',
    coach: { id: 'C003', name: '張嘉豪', is_senior: false },
    venue: { id: 'C', name: '夢想體育學院 中和館' },
    course_type: 1,
    students: [{ id: 'S0001', name: '張小明' }],
    total_sessions: 6,
    used_sessions: 6,
    expires_at: '2026-02-15',
    original_price: 9000,
    final_price: 9000,
    payment_status: 'completed',
    is_experience_course: false,
  },
];

let _periodSeq = 100;

export const mockDb = {
  venues: () => VENUES.slice(),
  venue: (id) => VENUES.find((v) => v.id === id) || null,

  coaches: ({ venueId } = {}) =>
    COACHES.filter((c) => !venueId || c.venues.includes(venueId)).map((c) => ({ ...c })),
  coach: (id) => COACHES.find((c) => c.id === id) || null,

  promotions: () => PROMOTIONS.slice(),

  basePrice: (courseType) => BASE_PRICES[courseType] || 0,

  parentByPhone: (phone) => {
    const p = PARENTS[String(phone || '').trim()];
    return p ? JSON.parse(JSON.stringify(p)) : null;
  },

  createParent: (data) => {
    const id = `P${String(Object.keys(PARENTS).length + 1).padStart(4, '0')}`;
    const parent = {
      id,
      name: data.name,
      phone: data.phone,
      gender: data.gender || '',
      email: data.email || '',
      primary_venue_id: data.primary_venue_id || null,
      students: (data.students || []).map((s, i) => ({
        id: `S${id}-${i + 1}`,
        name: s.name,
        id_number: s.id_number,
        birth_date: s.birth_date,
        gender: s.gender || '',
      })),
    };
    PARENTS[parent.phone] = parent;
    return JSON.parse(JSON.stringify(parent));
  },

  myCourses: (parentId) =>
    COURSE_PERIODS.filter((cp) => cp.parent_id === parentId).map((cp) => JSON.parse(JSON.stringify(cp))),

  createEnrollment: (payload) => {
    const id = `CP${String(++_periodSeq).padStart(4, '0')}`;
    const period = {
      id,
      parent_id: payload.parent_id,
      coach: payload.coach,
      venue: payload.venue,
      course_type: payload.course_type,
      students: payload.students,
      total_sessions: 6,
      used_sessions: 0,
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      original_price: payload.original_price,
      final_price: payload.final_price,
      payment_status: 'pending_payment',
      transfer_last_5: payload.transfer_last_5,
      is_experience_course: false,
    };
    COURSE_PERIODS.push(period);
    return JSON.parse(JSON.stringify(period));
  },
};
