import { useLocation } from 'react-router-dom';
import { hasCoursePricing, hasCoursePeriodBounds, resolvePricingMultiplier } from '../../../shared/coursePricing';

// Ephemeral React state only. These values never grant API access or persist identity.
export function useGuideDemo() {
  const { state } = useLocation();
  return state?.guideDemo?.kind === 'feature-tour' ? state.guideDemo : null;
}

export const demoStudent = {
  id: 'DEMO-STUDENT-1',
  name: 'DEMO 學員 1',
  id_number: 'DEMO-不是真實身分證',
  birth_date: '2015-01-01',
  gender: '不清楚',
  blood_type: '不清楚',
  status: 'active',
  is_active: true,
};

export function demoStudents(count = 1) {
  const size = Math.max(1, Math.min(4, Number(count) || 1));
  return Array.from({ length: size }, (_, index) => ({
    ...demoStudent,
    id: `DEMO-STUDENT-${index + 1}`,
    name: `DEMO 學員 ${index + 1}`,
  }));
}

export function demoCheckout(venue) {
  const demoPaymentVenue = {
    ...venue,
    account_holder: 'DEMO 收款戶名',
    bank_account_name: 'DEMO 收款戶名',
    bank_institution_name: 'DEMO 銀行',
    bank_name: 'DEMO 銀行',
    bank_branch_name: 'DEMO 分行',
    account_number: 'DEMO-不是真實帳號',
    bank_account_number: 'DEMO-不是真實帳號',
  };
  return {
    checkout_id: 'DEMO-CHECKOUT',
    total_amount: 0,
    payment_status: 'pending_payment',
    payment_method: 'bank_transfer',
    has_payment_proof: false,
    venue: demoPaymentVenue,
    bank_name: 'DEMO 銀行',
    bank_code: 'DEMO',
    bank_account: 'DEMO-不是真實帳號',
    account_name: 'DEMO 收款戶名',
    sub_orders: [],
    parent_note: 'DEMO 教學資料，不會送出',
    created_at: '2026-09-30T00:00:00+08:00',
  };
}

export function demoGroup(guide, joining = false) {
  const ready = guide?.view === 'review';
  const self = {
    id: 'DEMO-MEMBER',
    parent_name: 'DEMO 家長',
    student_names: ['DEMO 學員 1'],
    student_count: 1,
    is_self: true,
    is_leader: true,
    amount_due: 0,
    has_payment_proof: ready,
    has_payment_info: ready,
    transfer_last_5: ready ? 'DEMO' : '',
    payment_confirmed: false,
  };
  return {
    id: 'DEMO-GROUP',
    course_type: 2,
    period_count: 1,
    status: 'forming',
    is_leader: true,
    venue: demoCheckout(guide?.venue).venue,
    coach_name: guide?.coach?.name || '待分配',
    join_token: 'DEMO-TOKEN',
    total_students: ready ? 2 : 1,
    min_students: 2,
    max_students: 2,
    note: 'DEMO 教學資料',
    already_member: false,
    joinable: true,
    member_count: joining ? 0 : (ready ? 2 : 1),
    members: joining ? [] : ready
      ? [self, { ...self, id: 'DEMO-OTHER', parent_name: 'DEMO 家長 2', is_self: false, is_leader: false }]
      : [self],
  };
}

export function demoBookingData({ venue, coach, sessionsPerPeriod = 6 }) {
  const date = new Date(Date.now() + 8 * 3600 * 1000);
  date.setUTCDate(date.getUTCDate() + 1);
  const ymd = date.toISOString().slice(0, 10);
  const make = (id, hour) => ({
    id,
    start_at: `${ymd}T${String(hour).padStart(2, '0')}:00:00+08:00`,
    duration_minutes: 60,
  });
  return {
    period: {
      id: 'DEMO-PERIOD',
      course_type: 1,
      coach_name: coach?.name || '待分配',
      venue_id: venue?.id,
      venue_name: venue?.name,
    },
    sessions_left: Math.max(1, Number(sessionsPerPeriod) || 1),
    slots: [make('DEMO-SLOT-MORNING', 9), make('DEMO-SLOT-AFTERNOON', 14), make('DEMO-SLOT-EVENING', 19)],
  };
}

export function guideDemoContext(topicId, { venue, coach, price, courseType }) {
  if (!hasCoursePricing(price?.original_price, price?.sessions_per_period)
      || !hasCoursePeriodBounds(price?.period_count_min, price?.period_count_max)
      || resolvePricingMultiplier(coach?.multiplier, coach?.pricing_multiplier) == null) {
    throw new Error('課程定價資料不完整，無法開始此引導');
  }
  const sessionsPerPeriod = Number(price.sessions_per_period);
  const course = {
    id: 'DEMO-COURSE',
    lifecycle: 'active',
    status: 'active',
    order_kind: 'standard',
    course_period_id: 'DEMO-PERIOD',
    course_type: courseType,
    course_type_name: `DEMO ${courseType === 1 ? '一對一' : `一對${courseType}`}課程`,
    coach,
    coach_name: coach.name,
    venue,
    venue_id: venue.id,
    venue_name: venue.name,
    purchased_sessions: sessionsPerPeriod,
    used_sessions: 0,
    remaining_sessions: sessionsPerPeriod,
    total_sessions: sessionsPerPeriod,
    sessions_used: 0,
    sessions_left: sessionsPerPeriod,
    student_names: ['DEMO 學員 1'],
    checkin_mode: 'booking',
    start_date: '2026-09-01',
    end_date: '2026-12-31',
  };
  const trialCourse = {
    ...course,
    id: 'DEMO-TRIAL',
    order_kind: 'trial',
    lifecycle: 'completed',
    status: 'completed',
    course_type_name: `DEMO ${courseType === 1 ? '一對一' : `一對${courseType}`}試上`,
    purchased_sessions: 1,
    used_sessions: 1,
    remaining_sessions: 0,
    total_sessions: 1,
    sessions_used: 1,
    sessions_left: 0,
  };
  return {
    venue,
    coach,
    checkout: demoCheckout(venue),
    bootData: {
      venue,
      coach,
      basePrice: price.original_price,
      tierPrices: price.tier_prices || null,
      trialEnabled: price.trial_enabled === true,
      trialPrice: price.trial_price,
      sessionsPerPeriod,
      periodCountMin: price.period_count_min,
      periodCountMax: price.period_count_max,
      demo: true,
    },
    courseType,
    courses: [course, trialCourse],
    booking: demoBookingData({ venue, coach, sessionsPerPeriod }),
  };
}
