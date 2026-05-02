// Centralized Mock dataset for Phase 1 (no backend wiring yet).
// All API modules under client/liff/src/api/ pull from here when
// VITE_USE_MOCK !== "false" or when backend returns 501.

const VENUES = [
  { id: 'B', code: 'B', name: '夢想體育學院 板橋館', address: '新北市板橋區文化路一段 188 號 3 樓',
    bank_institution_name: '玉山銀行', bank_branch_name: '板橋分行',
    account_holder: '駿斯運動事業股份有限公司', account_number: '0123-456-789012' },
  { id: 'C', code: 'C', name: '夢想體育學院 中和館', address: '新北市中和區景平路 268 號 B1',
    bank_institution_name: '國泰世華銀行', bank_branch_name: '中和分行',
    account_holder: '駿斯運動事業股份有限公司', account_number: '0987-654-321098' },
  { id: 'X', code: 'X', name: '夢想體育學院 新莊館', address: '新北市新莊區中正路 10 號 2 樓',
    bank_institution_name: '台新銀行', bank_branch_name: '新莊分行',
    account_holder: '駿斯運動事業股份有限公司', account_number: '5566-7788-990011' },
];

// 教練：phone 是教練端登入欄位（與 admin bootstrap DEFAULT_STAFF 對齊）
const COACHES = [
  { id: 'C001', name: '王志強', phone: '0911000001', venues: ['B', 'C'], is_senior: true,  multiplier: 1.3,
    bio: '前國家代表隊選手，10 年青少年訓練經驗。專長：基本動作矯正與比賽節奏培養。', tags: ['含學習歷程服務', '比賽輔導'], avatar: null },
  { id: 'C002', name: '林佳穎', phone: '0911000002', venues: ['B'], is_senior: true,  multiplier: 1.5,
    bio: '英國 LTA Level 3 認證教練，擅長 6-12 歲基礎培訓。', tags: ['含學習歷程服務', '兒童專家'], avatar: null },
  { id: 'C003', name: '張嘉豪', phone: '0911000003', venues: ['B', 'C', 'X'], is_senior: false, multiplier: 1.0,
    bio: '熱情活潑、耐心十足，新進教練。', tags: [], avatar: null },
  { id: 'C004', name: '黃詩涵', phone: '0911000004', venues: ['C', 'X'], is_senior: false, multiplier: 1.1,
    bio: '具備 5 年場館團體班經驗，授課風格輕鬆。', tags: [], avatar: null },
];

const BASE_PRICES = { 1: 9000, 2: 6000, 3: 4500 };

const PROMOTIONS = [
  { id: 'P_NEW2026', title: '新春開課優惠 95 折', description: '4 月底前報名任一組別，自動享 95 折',
    type: 'PERCENTAGE', value: 0.95, threshold: { type: 'PERIOD_COUNT', value: 1 },
    expires_at: '2026-05-31', is_auto_apply: true },
  { id: 'P_2PERIOD', title: '一次購買 2 期 9 折', description: '同教練同組別，一次預購 2 期享 9 折',
    type: 'PERCENTAGE', value: 0.9, threshold: { type: 'PERIOD_COUNT', value: 2 },
    expires_at: '2026-12-31', is_auto_apply: false },
];

const PARENTS = {
  '0912345678': { id: 'P0001', name: '張媽媽', phone: '0912345678', gender: '女', email: 'mama.chang@example.com',
    primary_venue_id: 'B', students: [
      { id: 'S0001', name: '張小明', id_number: 'A123456789', birth_date: '2015-03-12', gender: '男' },
      { id: 'S0002', name: '張小美', id_number: 'A223456788', birth_date: '2017-08-05', gender: '女' }] },
  '0922333444': { id: 'P0002', name: '李爸爸', phone: '0922333444', gender: '男', email: 'lee.papa@example.com',
    primary_venue_id: 'B', students: [
      { id: 'S0010', name: '李小龍', id_number: 'A187654321', birth_date: '2014-11-30', gender: '男' }] },
  '0933555777': { id: 'P0003', name: '陳媽媽', phone: '0933555777', gender: '女', email: '',
    primary_venue_id: 'C', students: [
      { id: 'S0020', name: '陳小米', id_number: 'A287777111', birth_date: '2016-02-20', gender: '女' }] },
};

const COURSE_PERIODS = [
  { id: 'CP0001', parent_id: 'P0001', coach: { id: 'C001', name: '王志強', is_senior: true },
    venue: { id: 'B', name: '夢想體育學院 板橋館' }, course_type: 1,
    students: [{ id: 'S0001', name: '張小明' }], total_sessions: 6, used_sessions: 2,
    expires_at: '2026-12-15', original_price: 9000, final_price: 11115,
    payment_status: 'active', is_experience_course: false },
  { id: 'CP0002', parent_id: 'P0001', coach: { id: 'C002', name: '林佳穎', is_senior: true },
    venue: { id: 'B', name: '夢想體育學院 板橋館' }, course_type: 2,
    students: [{ id: 'S0002', name: '張小美' }, { id: 'S0010', name: '李小龍' }],
    total_sessions: 6, used_sessions: 0, expires_at: '2027-04-30',
    original_price: 6000, final_price: 8550, payment_status: 'pending_payment', transfer_last_5: '12345',
    is_experience_course: false },
  { id: 'CP0003', parent_id: 'P0001', coach: { id: 'C003', name: '張嘉豪', is_senior: false },
    venue: { id: 'C', name: '夢想體育學院 中和館' }, course_type: 1,
    students: [{ id: 'S0001', name: '張小明' }], total_sessions: 6, used_sessions: 6,
    expires_at: '2026-02-15', original_price: 9000, final_price: 9000,
    payment_status: 'completed', is_experience_course: false },
];

let _periodSeq = 100;
let _slotSeq = 1;
let _mediaSeq = 1;

// ── 教練槽位 + 已預約 sessions（給教練端 LIFF 用） ──────────────────
function makeISO(daysFromToday, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// 動態本週示範資料：以王志強 (C001) 為主
function buildInitialSlots() {
  const items = [];
  const plan = [
    { day: 0, hour: 14, status: 'booked',    venue: 'B', students: ['張小明'],            ct: 1 },
    { day: 0, hour: 15, status: 'booked',    venue: 'B', students: ['張小美', '李小龍'],   ct: 2 },
    { day: 0, hour: 16, status: 'available', venue: 'B' },
    { day: 0, hour: 17, status: 'available', venue: 'B' },
    { day: 1, hour: 14, status: 'available', venue: 'B' },
    { day: 1, hour: 15, status: 'available', venue: 'B' },
    { day: 1, hour: 16, status: 'blocked',   venue: 'B', notes: '個人請假' },
    { day: 2, hour: 10, status: 'available', venue: 'C' },
    { day: 3, hour: 19, status: 'booked',    venue: 'C', students: ['陳小米'],            ct: 1 },
    { day: 4, hour: 18, status: 'available', venue: 'B' },
  ];
  for (const p of plan) {
    const id = `SL${String(_slotSeq++).padStart(4, '0')}`;
    const startISO = makeISO(p.day, p.hour);
    items.push({
      id,
      coach_id: 'C001',
      venue_id: p.venue,
      venue_name: VENUES.find(v => v.id === p.venue).name,
      start_at: startISO,
      duration_minutes: 60,
      status: p.status,
      notes: p.notes || null,
      booked_session_id: p.status === 'booked' ? `SE${id}` : null,
      session_id: p.status === 'booked' ? `SE${id}` : null,
      course_period_id: p.status === 'booked' ? `CPB${id}` : null,
      course_type: p.status === 'booked' ? p.ct : null,
      student_names: p.status === 'booked' ? p.students : [],
    });
  }
  return items;
}

const COACH_SLOTS = buildInitialSlots();

// 教練介紹媒體
const COACH_MEDIA = {
  C001: [
    { id: 'M001', media_type: 'image', storage_url: 'https://picsum.photos/seed/c001a/600/400', alt_text: '訓練現場 1', sort_order: 0 },
    { id: 'M002', media_type: 'image', storage_url: 'https://picsum.photos/seed/c001b/600/400', alt_text: '比賽合照',   sort_order: 1 },
    { id: 'M003', media_type: 'image', storage_url: 'https://picsum.photos/seed/c001c/600/400', alt_text: '證書照片',   sort_order: 2 },
  ],
  C002: [], C003: [], C004: [],
};

function _slotsByCoach(coachId, fromISO, toISO) {
  const from = fromISO ? new Date(fromISO).getTime() : 0;
  const to   = toISO   ? new Date(toISO).getTime()   : Number.MAX_SAFE_INTEGER;
  return COACH_SLOTS
    .filter(s => s.coach_id === coachId)
    .filter(s => {
      const t = new Date(s.start_at).getTime();
      return t >= from && t < to;
    })
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
    .map(s => JSON.parse(JSON.stringify(s)));
}

function _hasOverlap(coachId, startAt, durMin, excludeId = null) {
  const start = new Date(startAt).getTime();
  const end = start + durMin * 60_000;
  return COACH_SLOTS.some(s => {
    if (s.coach_id !== coachId) return false;
    if (excludeId && s.id === excludeId) return false;
    if (!['available', 'pending_group_confirm', 'booked'].includes(s.status)) return false;
    const sStart = new Date(s.start_at).getTime();
    const sEnd = sStart + (s.duration_minutes || 60) * 60_000;
    return start < sEnd && end > sStart;
  });
}

export const mockDb = {
  // ── 既有 (parent flow) ────────────────────────────────────────────
  venues: () => VENUES.slice(),
  venue: (id) => VENUES.find((v) => v.id === id) || null,
  coaches: ({ venueId } = {}) =>
    COACHES.filter((c) => !venueId || c.venues.includes(venueId)).map((c) => ({ ...c })),
  coach: (id) => {
    const c = COACHES.find((x) => x.id === id);
    return c ? { ...c, venue_ids: c.venues } : null;
  },
  promotions: () => PROMOTIONS.slice(),
  basePrice: (courseType) => BASE_PRICES[courseType] || 0,

  parentByPhone: (phone) => {
    const p = PARENTS[String(phone || '').trim()];
    return p ? JSON.parse(JSON.stringify(p)) : null;
  },
  createParent: (data) => {
    const id = `P${String(Object.keys(PARENTS).length + 1).padStart(4, '0')}`;
    const parent = {
      id, name: data.name, phone: data.phone, gender: data.gender || '',
      email: data.email || '', primary_venue_id: data.primary_venue_id || null,
      students: (data.students || []).map((s, i) => ({
        id: `S${id}-${i + 1}`, name: s.name, id_number: s.id_number,
        birth_date: s.birth_date, gender: s.gender || '',
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
      id, parent_id: payload.parent_id, coach: payload.coach, venue: payload.venue,
      course_type: payload.course_type, students: payload.students,
      total_sessions: 6, used_sessions: 0,
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      original_price: payload.original_price, final_price: payload.final_price,
      payment_status: 'pending_payment', transfer_last_5: payload.transfer_last_5,
      is_experience_course: false,
    };
    COURSE_PERIODS.push(period);
    return JSON.parse(JSON.stringify(period));
  },

  // ── 教練端 ─────────────────────────────────────────────────────────
  coachByPhone: (phone) => {
    const c = COACHES.find((x) => x.phone === String(phone || '').trim());
    if (!c) return null;
    return { ...c, venue_ids: c.venues, token: `mock-coach-${c.id}` };
  },

  coachSlots: (coachId, from, to) => _slotsByCoach(coachId, from, to),

  coachTodaySessions: (coachId) => {
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    return COACH_SLOTS
      .filter(s => s.coach_id === coachId && s.status === 'booked')
      .filter(s => {
        const t = new Date(s.start_at).getTime();
        return t >= today.getTime() && t < tomorrow.getTime();
      })
      .map(s => ({
        id: s.session_id, scheduled_at: s.start_at, duration_minutes: s.duration_minutes,
        status: 'confirmed', course_period_id: s.course_period_id, course_type: s.course_type,
        venue_id: s.venue_id, venue_name: s.venue_name, student_names: s.student_names,
        checked_in: false,
      }));
  },

  coachWeekSessions: (coachId, from, to) => {
    return _slotsByCoach(coachId, from, to)
      .filter(s => s.status === 'booked')
      .map(s => ({
        id: s.session_id, scheduled_at: s.start_at, duration_minutes: s.duration_minutes,
        status: 'confirmed', course_period_id: s.course_period_id, course_type: s.course_type,
        venue_id: s.venue_id, student_names: s.student_names,
      }));
  },

  sessionDetail: (id) => {
    const s = COACH_SLOTS.find(x => x.session_id === id);
    if (!s) return null;
    return {
      id, scheduled_at: s.start_at, duration_minutes: s.duration_minutes, status: 'confirmed',
      course_type: s.course_type, venue_id: s.venue_id, venue_name: s.venue_name,
      student_names: s.student_names,
    };
  },

  createSlot: ({ coach_id, venue_id, start_at, duration_minutes = 60, notes }) => {
    if (_hasOverlap(coach_id, start_at, duration_minutes)) {
      throw new Error('時段衝突：與既有槽位重疊');
    }
    const id = `SL${String(_slotSeq++).padStart(4, '0')}`;
    const slot = {
      id, coach_id, venue_id,
      venue_name: VENUES.find(v => v.id === venue_id)?.name || venue_id,
      start_at, duration_minutes, status: 'available', notes: notes || null,
      booked_session_id: null, session_id: null, course_period_id: null,
      course_type: null, student_names: [],
    };
    COACH_SLOTS.push(slot);
    return JSON.parse(JSON.stringify(slot));
  },

  batchCreateSlots: ({ coach_id, venue_id, weekdays, times, from, to, duration_minutes = 60 }) => {
    let created = 0, skipped = 0;
    const errors = [];
    const fromD = new Date(from); const toD = new Date(to);
    for (let d = new Date(fromD); d <= toD; d.setDate(d.getDate() + 1)) {
      if (!weekdays.includes(d.getDay())) continue;
      for (const t of times) {
        const [hh, mm] = t.split(':').map(Number);
        const start = new Date(d); start.setHours(hh, mm || 0, 0, 0);
        try {
          mockDb.createSlot({ coach_id, venue_id, start_at: start.toISOString(), duration_minutes });
          created++;
        } catch (err) { skipped++; errors.push({ start_at: start.toISOString(), venue_id, error: err.message }); }
      }
    }
    return { created, skipped, errors };
  },

  updateSlotStatus: (id, toStatus, requireFromStatus) => {
    const s = COACH_SLOTS.find(x => x.id === id);
    if (!s) throw new Error('槽位不存在');
    if (requireFromStatus && s.status !== requireFromStatus) {
      throw new Error(`只有 ${requireFromStatus} 槽位可變更為 ${toStatus}`);
    }
    s.status = toStatus;
    return JSON.parse(JSON.stringify(s));
  },

  deleteSlot: (id) => {
    const idx = COACH_SLOTS.findIndex(x => x.id === id);
    if (idx === -1) throw new Error('槽位不存在');
    if (COACH_SLOTS[idx].status !== 'available') throw new Error('只有 available 槽位可刪除');
    COACH_SLOTS.splice(idx, 1);
    return { ok: true, id };
  },

  previewConflict: ({ coach_id, start_at, duration_minutes = 60 }) => ({
    has_conflict: _hasOverlap(coach_id, start_at, duration_minutes),
    conflicts: [],
  }),

  updateCoachBio: (coachId, bio) => {
    const c = COACHES.find(x => x.id === coachId);
    if (c) c.bio = bio;
    return { id: coachId, bio_rich_text: bio, intro_review_status: 'submitted' };
  },

  coachMedia: (coachId) => (COACH_MEDIA[coachId] || []).slice().sort((a, b) => a.sort_order - b.sort_order),

  addCoachMedia: (coachId, { storage_url, alt_text = '', media_type = 'image' }) => {
    if (!COACH_MEDIA[coachId]) COACH_MEDIA[coachId] = [];
    const sort_order = COACH_MEDIA[coachId].length;
    const item = { id: `M${String(_mediaSeq++).padStart(3, '0')}-NEW`, media_type, storage_url, alt_text, sort_order };
    COACH_MEDIA[coachId].push(item);
    return JSON.parse(JSON.stringify(item));
  },

  reorderCoachMedia: (coachId, ids) => {
    const list = COACH_MEDIA[coachId] || [];
    ids.forEach((id, i) => { const m = list.find(x => x.id === id); if (m) m.sort_order = i; });
    return { ok: true, count: ids.length };
  },

  deleteCoachMedia: (coachId, mediaId) => {
    const list = COACH_MEDIA[coachId] || [];
    const idx = list.findIndex(x => x.id === mediaId);
    if (idx === -1) throw new Error('媒體不存在');
    list.splice(idx, 1);
    return { ok: true };
  },

  // ── 聊天室（Phase 4 mock）──────────────────────────────────────────
  chatRooms: (viewer = { type: 'parent' }) => CHAT_ROOMS.map((r) => ({
    ...r,
    last_message: (CHAT_MESSAGES[r.id] || []).slice(-1)[0] || null,
    // 對方傳的 (sender_type !== viewer.type) 才算未讀，避免 mock 模式下教練視角顯示錯誤
    unread_count: (CHAT_MESSAGES[r.id] || []).filter((m) => !m.read_by_me && m.sender_type !== viewer.type).length,
  })),
  chatRoom: (id) => {
    const r = CHAT_ROOMS.find((x) => x.id === id);
    return r ? JSON.parse(JSON.stringify(r)) : null;
  },
  chatMessages: (roomId) => (CHAT_MESSAGES[roomId] || []).slice(-80).map((m) => ({ ...m })),
  chatSendText: (roomId, content, viewer = { type: 'parent', id: 'P0001' }) => {
    if (!CHAT_MESSAGES[roomId]) CHAT_MESSAGES[roomId] = [];
    const m = {
      id: `MSG${++_msgSeq}`,
      chat_room_id: roomId,
      sender_type: viewer.type || 'parent',
      sender_id: viewer.id || (viewer.type === 'coach' ? 'C001' : 'P0001'),
      message_type: 'text', content,
      media_url: null, media_filename: null, media_size_bytes: null,
      created_at: new Date().toISOString(), read_by_me: true,
    };
    CHAT_MESSAGES[roomId].push(m);
    return JSON.parse(JSON.stringify(m));
  },
  chatUploadFile: (roomId, file, caption, viewer = { type: 'parent', id: 'P0001' }) => {
    if (!CHAT_MESSAGES[roomId]) CHAT_MESSAGES[roomId] = [];
    const isImg = file.type?.startsWith('image/');
    const url = URL.createObjectURL(file);
    const m = {
      id: `MSG${++_msgSeq}`,
      chat_room_id: roomId,
      sender_type: viewer.type || 'parent',
      sender_id: viewer.id || (viewer.type === 'coach' ? 'C001' : 'P0001'),
      message_type: isImg ? 'image' : 'file',
      content: caption || null,
      media_url: url, media_filename: file.name, media_size_bytes: file.size,
      created_at: new Date().toISOString(), read_by_me: true,
    };
    CHAT_MESSAGES[roomId].push(m);
    return JSON.parse(JSON.stringify(m));
  },
  chatMarkRead: (roomId) => {
    (CHAT_MESSAGES[roomId] || []).forEach((m) => { m.read_by_me = true; });
    return { ok: true };
  },
};

// ── Phase 4 mock 資料：兩間聊天室（家長 P0001 ↔ 教練 C001/C002）────
const CHAT_ROOMS = [
  { id: 'CR001', course_period_id: 'CP0001',
    coach: { id: 'C001', name: '王志強' }, venue: { id: 'B', name: '夢想體育學院 板橋館' },
    course_type: 1, period_status: 'active', student_names: ['張小明'] },
  { id: 'CR002', course_period_id: 'CP0002',
    coach: { id: 'C002', name: '林佳穎' }, venue: { id: 'B', name: '夢想體育學院 板橋館' },
    course_type: 2, period_status: 'pending_payment', student_names: ['張小美', '李小龍'] },
];
let _msgSeq = 100;
const CHAT_MESSAGES = {
  CR001: [
    { id: 'MSG001', chat_room_id: 'CR001', sender_type: 'coach', sender_id: 'C001',
      message_type: 'text', content: '張媽媽您好，今天上課表現很好，已經能順利打到底線了！',
      created_at: new Date(Date.now() - 86400000).toISOString(), read_by_me: true },
    { id: 'MSG002', chat_room_id: 'CR001', sender_type: 'parent', sender_id: 'P0001',
      message_type: 'text', content: '太棒了！謝謝教練！下週同樣時間嗎？',
      created_at: new Date(Date.now() - 86000000).toISOString(), read_by_me: true },
    { id: 'MSG003', chat_room_id: 'CR001', sender_type: 'coach', sender_id: 'C001',
      message_type: 'text', content: '對，下週二下午 14:00。',
      created_at: new Date(Date.now() - 3600000).toISOString(), read_by_me: false },
  ],
  CR002: [],
};
