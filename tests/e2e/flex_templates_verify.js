// 18 種 Flex 模板「結構驗證」：以 stub data 呼叫每個 templates.* 函數，
// 驗其回傳為合法 Line Flex Message 物件（type:'flex' + altText + contents.type），
// 不需真正連 LINE channel。這是上線前 docs/flex_message_checklist.md 的程式化證據。
const line = require('../../server/services/line');
const { templates } = line;

const STUB = {
  coachName: '王教練', venueName: '中港店', courseType: '1對1', finalPrice: 6000,
  liffUrl: 'https://liff.line.me/x', initiatorName: '林家長',
  scheduledAt: '2026-05-10 10:00', agreeUrl: 'https://x/a', rejectUrl: 'https://x/r',
  role: 'parent', studentName: '小明', cancelType: 'normal',
  remainingSessions: 2, expiresAt: '2026-06-30',
  sessionDate: '2026-05-09', parentName: '林家長', keyword: '退費', chatUrl: 'https://x/c',
  fromParentName: '林家長', courseInfo: '王教練 / 中港店 / 1對1',
  sessionsRemaining: 3, approved: true, note: '通過',
  refereeName: '陳家長', couponDetails: '9折券，效期 30 天',
};

const ITEMS = [
  ['#1  enrollmentSuccess',     templates.enrollmentSuccess],
  ['#2  courseActivated',       templates.courseActivated],
  ['#3  slotBooked',            templates.slotBooked],
  ['#4  groupConfirmInvite',    templates.groupConfirmInvite],
  ['#5  groupConfirmInvite(成功)', templates.groupConfirmInvite],
  ['#6  groupConfirmInvite(拒絕)', templates.groupConfirmInvite],
  ['#7  sessionReminder',       templates.sessionReminder],
  ['#8  selfCancelToCoach',     templates.selfCancelToCoach],
  ['#9  expiryReminder',        templates.expiryReminder],
  ['#10 coursePlanPublished',   templates.coursePlanPublished],
  ['#11 sessionRecordPublished',templates.sessionRecordPublished],
  ['#12 evaluationInvite',      templates.evaluationInvite],
  ['#13 evaluationInvite(reminder)', templates.evaluationInvite],
  ['#14 transferRequest',       templates.transferRequest],
  ['#15 transferReviewed',      templates.transferReviewed],
  ['#16 keywordAlert',          templates.keywordAlert],
  ['#17 mgmRewardIssued',       templates.mgmRewardIssued],
  ['#18 mgmTrialTodayReminder', templates.mgmTrialTodayReminder],
];

let pass = 0, fail = 0;
for (const [label, fn] of ITEMS) {
  try {
    if (typeof fn !== 'function') throw new Error('template fn missing');
    const out = fn(STUB);
    const m = Array.isArray(out) ? out[0] : out;
    if (!m || m.type !== 'flex') throw new Error(`type != flex (${m && m.type})`);
    if (!m.altText || typeof m.altText !== 'string') throw new Error('missing altText');
    if (!m.contents || (m.contents.type !== 'bubble' && m.contents.type !== 'carousel'))
      throw new Error(`contents.type=${m.contents && m.contents.type}`);
    console.log(`  ✓ ${label.padEnd(40)} altText="${m.altText.slice(0,30)}"`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${label.padEnd(40)} ${e.message}`);
    fail++;
  }
}
console.log(`\n=== Flex 模板結構驗證：${pass}/${ITEMS.length} pass，${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
