import { useLocation } from 'react-router-dom';
import { coachTopicPlan } from './coachTopicTours.mjs';

// Synthetic display state only: never identity, API authority, localStorage or a mock DB.
export function useCoachGuideDemo() {
  const { state } = useLocation();
  const guide = state?.guideDemo;
  return guide?.kind === 'coach-feature-tour' && guide.topicId === state?.topicTour
    && coachTopicPlan(guide.topicId) ? guide : null;
}

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#e2e8f0"/><text x="48" y="52" text-anchor="middle" font-size="16">DEMO</text></svg>')}`;
export function coachGuideContext() {
  const ymd = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const coach = { id: 'DEMO-COACH', name: 'DEMO 教練', phone: 'DEMO', venue_ids: ['DEMO-VENUE'], multiplier: 1, pricing_multiplier: 1, bio: 'DEMO 個人介紹，僅供本次教學顯示。', bio_rich_text: 'DEMO 個人介紹，僅供本次教學顯示。', bio_detail: 'DEMO 詳細介紹，僅供本次教學顯示，不會送出。', intro_review_status: 'pending_review', avatar_url: image };
  const session = { id: 'DEMO-SESSION', course_period_id: 'DEMO-PERIOD', scheduled_at: `${ymd}T14:00:00+08:00`, duration_minutes: 60, venue_id: 'DEMO-VENUE', venue_name: 'DEMO 場館', course_type: 2, status: 'confirmed', student_names: ['DEMO 學員 1', 'DEMO 學員 2'], checked_in: true, checked_in_at: `${ymd}T14:00:00+08:00`, students_detail: [1, 2].map(n => ({ id: `DEMO-STUDENT-${n}`, name: `DEMO 學員 ${n}`, parent_name: `DEMO 家長 ${n}`, checked_in: true, checked_in_source: 'parent', checked_in_at: `${ymd}T14:00:00+08:00` })), total_sessions: 6, used_sessions: 2, period_count: 1 };
  const enrollment = { id: 'DEMO-ENROLLMENT', status: 'confirmed', bucket: 'ongoing', students: session.student_names, student_names: session.student_names, course_type: 2, venue_name: 'DEMO 場館', period_number: 1, period_count: 1, total_sessions: 6, used_sessions: 2, course_expires_at: `${ymd}T23:59:00+08:00`, days_left: 0 };
  return {
    coach, session, sessions: [session],
    promotions: [{ id: 'DEMO-PROMO', name: 'DEMO 優惠示例', type: 'fixed', discount_type: 'fixed', discount_value: 0, end_date: ymd, coupon_code: 'DEMO' }],
    expiring: { count: 1, items: [enrollment] },
    enrollments: { total: 1, items: [enrollment] },
    periods: [{ id: 'DEMO-PERIOD', student_names: session.student_names, total_sessions: 6, used_sessions: 2 }],
    plan: { goals: 'DEMO 本期學習目標', expected_outcomes: 'DEMO 預期成果', learning_plan: 'DEMO 訓練規劃', initial_assessment: 'DEMO 初評', notes: 'DEMO 備註', status: 'draft' },
    record: { summary: 'DEMO 上課摘要', highlights: 'DEMO 表現亮點', improvements: 'DEMO 待加強', homework: 'DEMO 回家練習', notes: 'DEMO 備註', media: [{ name: 'DEMO 附件示例', url: image }], tags: ['DEMO 標籤'], status: 'submitted', student_records: { mode: 'class', records: {} } },
    tags: { system: [{ id: 'DEMO-TAG', category_id: 'DEMO-CATEGORY', category_name: '上課摘要', label: 'DEMO 標籤', text_template: 'DEMO 文案' }], personal: [{ id: 'DEMO-PERSONAL', category_name: '上課摘要', label: 'DEMO 常用', text_template: 'DEMO 常用文案' }] },
    media: [1, 2].map(n => ({ id: `DEMO-MEDIA-${n}`, storage_url: image, alt_text: `DEMO 圖片 ${n}` })),
    venueMap: { 'DEMO-VENUE': 'DEMO 場館' },
  };
}
