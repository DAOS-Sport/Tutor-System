/**
 * 2026-09-01 Eric 的一批需求，以及做這批時撞到的一個活的 bug。
 *
 * ── 那個 bug ──
 * SessionsPage 呼叫 taipeiInputToDate，但 import 清單裡從來沒有它，
 * 而且呼叫點在 try 之外 —— 救生員按「確認補簽到」就是 ReferenceError，
 * 沒有錯誤訊息、畫面沒反應。使用者當天回報「救生無法按確認補簽到」，
 * 與這裡查到的成因一致。這種缺漏建置不會報錯、測試不會自然變紅，
 * 所以要有人明確盯著。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const SESSIONS_PAGE = 'client/admin/src/pages/SessionsPage.jsx';
const WEEK_GRID = 'client/admin/src/components/WeekGridView.jsx';
const ENROLL_ROW = 'client/liff/src/components/coach/EnrollmentRow.jsx';
const COACH_TODAY = 'client/liff/src/pages/CoachTodayPage.jsx';
const SESSIONS_API = 'server/routes/sessions.js';
const ADMIN_SESSIONS = 'server/routes/admin/sessions.js';

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

// ── 那個活的 bug ────────────────────────────────────────────────────────
t('補簽到用到的 helper 一定要 import（救生員按不動的成因）', () => {
  const src = strip(read(SESSIONS_PAGE));
  const imported = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/utils\/format'/);
  assert.ok(imported, '找不到 utils/format 的 import');
  const names = imported[1].split(',').map((x) => x.trim()).filter(Boolean);
  for (const used of ['taipeiInputToDate', 'todayISO']) {
    assert.ok(src.includes(used + '('), '這支測試失效了：' + used + ' 已經沒有被使用');
    assert.ok(names.includes(used),
      used + ' 有被呼叫卻沒有 import —— 執行到就是 ReferenceError。'
      + '補簽到那一行還在 try 之外，所以連錯誤訊息都不會有，畫面只是沒反應');
  }
});

// ── A. 上課紀錄查詢 ─────────────────────────────────────────────────────
t('A1 排序：最新的在最上面', () => {
  const src = strip(read(ADMIN_SESSIONS));
  const i = src.indexOf("router.get('/'");
  const seg = src.slice(i, src.indexOf("router.get('/today'", i));
  assert.ok(/ORDER BY t\.date DESC, t\.start_time DESC/.test(seg),
    '起訖日查詢要由新到舊；升冪會把救生員最想看的那幾堂推到最底');
});

t('A2／C2 起訖日旁邊有「當天」快捷', () => {
  const src = strip(read(SESSIONS_PAGE));
  assert.ok(/>當天</.test(src), '沒有「當天」按鈕');
  assert.ok(/function jumpToday\(\)/.test(src), '「當日」要真的跳到今天');
});

t('A3 場館改單選（不是多選）', () => {
  const src = strip(read(SESSIONS_PAGE));
  assert.ok(!/VenueMultiSelect/.test(src), '還在用多選元件');
  assert.ok(/draftVenue/.test(src) && /setDraftVenue\(v\.id\)/.test(src),
    '場館應該是單一值＋按鈕點選');
  assert.ok(/全部場館/.test(src), '要留「全部場館」當退路');
});

// ── B. 顯示欄位 ─────────────────────────────────────────────────────────
t('B2／B3／B4 欄位內容與順序', () => {
  const src = strip(read(SESSIONS_PAGE));
  const labels = [...src.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.includes('學員名單'), 'B2：組別右邊要是「學員名單」');
  assert.strictEqual(labels[labels.indexOf('組別') + 1], '學員名單', 'B2：學員名單要緊接在組別右邊');
  assert.ok(labels.includes('簽到時間'), 'B3：中間那欄要是簽到時間');
  assert.ok(!labels.includes('時間'), 'B3：原本的「時間（起–迄）」欄應該已經被取代');
  assert.strictEqual(labels[labels.length - 1], '場館', 'B4：場館要在最右邊');
});

// ── C. 起訖日 ───────────────────────────────────────────────────────────
t('C1 起訖日最長三個月', () => {
  const src = strip(read(SESSIONS_PAGE));
  assert.ok(/const MAX_RANGE_DAYS = 92/.test(src), '沒有三個月上限');
  assert.ok(/days > MAX_RANGE_DAYS/.test(src), '上限沒有被檢查');
});

t('C3 預設當天到當天', () => {
  const src = strip(read(SESSIONS_PAGE));
  const i = src.indexOf('function initialRange()');
  assert.ok(i > 0, '找不到 initialRange');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(/todayISO\(\)/.test(body), '預設要用今天');
  assert.ok(/from: d, to: d/.test(body), '預設要是「當天到當天」，不是本週');
  assert.ok(!/rangeForPreset\('this_week'\)/.test(src), '還留著本週當預設');
});

// ── D. 週課表 ───────────────────────────────────────────────────────────
t('D1 靜態篩選：條件改動不再自動查', () => {
  const src = strip(read(SESSIONS_PAGE));
  assert.ok(/function runQuery\(\)/.test(src), '沒有查詢動作');
  assert.ok(/>查詢</.test(src), '沒有查詢按鈕');
  // 不用 [^]]* —— 在 JS 正則裡那會被解析成「任一字元 + 零個以上的 ]」，不是「非 ]」。
  const at = src.indexOf('useEffect(() => { load();');
  assert.ok(at > 0, '找不到載入的 effect');
  // indexOf(');') 會停在 load(); 那個括號上，取不到依賴陣列 —— 直接取一段窗口。
  const dep = src.slice(at, at + 200);
  assert.ok(!/draft\./.test(dep),
    'effect 依賴裡有 draft —— 那就還是動態篩選，改條件就自己查了');
  assert.ok(/applied\.from/.test(dep), 'effect 應該只依賴已套用的條件');
});

t('D2 查詢後收起展開中的下拉', () => {
  const src = strip(read(SESSIONS_PAGE));
  const i = src.indexOf('function runQuery()');
  const body = src.slice(i, i + 700);
  assert.ok(/blur\(\)/.test(body), '查詢後沒有把展開中的面板收起來');
});

t('D3 週課表依場館上色，且有圖例', () => {
  const page = strip(read(SESSIONS_PAGE));
  const grid = strip(read(WEEK_GRID));
  assert.ok(/場館顏色/.test(page), '表格上方沒有場館顏色圖例');
  assert.ok(/VENUE_SWATCH/.test(page) && /VENUE_TONE/.test(grid), '兩邊要各有一組色票');
  assert.ok(/toneOf\(s\.venue_id\)/.test(grid), '格子要依場館取色，不是依組別');
  assert.ok(/venueOrder/.test(page) && /venueOrder/.test(grid),
    '圖例與格子必須共用同一個順序，否則圖例會說謊');
});

// ── E. 教練端 ───────────────────────────────────────────────────────────
t('E1 課程期限：對帳完成時間的一年後，釘在 23:59', () => {
  const src = strip(read(SESSIONS_API));
  const i = src.indexOf('function courseExpiryAt');
  assert.ok(i > 0, '後端沒有算課程期限');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(/getUTCFullYear\(\) \+ 1/.test(body),
    '期限要是「一年後」的同月同日；用 365 天會在閏年少一天，家長會覺得被少算');
  assert.ok(!/validityDays|validity_days/.test(body), '不該再吃 validity_days 設定');
  assert.ok(/23, 59/.test(body), '期限沒有釘在 23:59');
  assert.ok(/8 \* 3600 \* 1000/.test(body), '沒有釘台北時區 —— 伺服器時區設錯會整批偏一天');
  assert.ok(/course_expires_at/.test(src) && /days_left/.test(src), '回應要帶期限與剩餘天數');

  const row = strip(read(ENROLL_ROW));
  assert.ok(/'課程期限'/.test(row), '報名紀錄每一筆要顯示課程期限');
  const ti = row.indexOf("'對帳完成'");
  assert.ok(ti > 0 && row.indexOf("'課程期限'") > ti, '課程期限要排在對帳完成之後');
});

t('E2 首頁：3 個月內即將到期的組數、清單與警語', () => {
  const api = strip(read(SESSIONS_API));
  assert.ok(/EXPIRING_SOON_DAYS = 92/.test(api), '沒有三個月的判準');
  assert.ok(/expiring:/.test(api), '回應沒有 expiring 區塊');
  assert.ok(/bucket === 'in_progress'/.test(api),
    '即將到期只該算進行中的 —— 已完成與待對帳算進來只是噪音');

  const page = strip(read(COACH_TODAY));
  assert.ok(/3 個月內即將到期/.test(page), '首頁沒有顯示組數');
  assert.ok(/請提醒家長進行授課/.test(page), '缺少指定的警語');
  assert.ok(/expiring\.items\.map/.test(page), '沒有列出清單');
  // 「點進去要看得出是哪一筆報名」：光有姓名不夠，同一位學員可能有多期。
  for (const field of ['course_type', 'venue_name', 'period_number']) {
    assert.ok(new RegExp(field).test(page), '清單要標出 ' + field + '，否則認不出是哪一筆');
  }
  const i = page.indexOf('expiring && expiring.count > 0');
  assert.ok(i > 0, '0 組時應該整塊不顯示');
  // 比對標題本身，不能用純文字「今日課程」—— 檔案上方的錯誤提示也含這四個字。
  const j = page.indexOf('>今日課程<');
  assert.ok(i < j, '需求指定要在今日課程「上方」');
});

console.log('\n' + n + ' 個測試全數通過');

