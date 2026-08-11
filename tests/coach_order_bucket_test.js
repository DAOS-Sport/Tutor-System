'use strict';
/**
 * 報名記錄的「一筆」定義、分桶、與班級名冊。
 *
 * ── 背景 ──
 * admin_enrollments 的粒度是「學員 × 期」，不是訂單。一筆 1對2、一期、兩個小孩
 * 在資料庫裡是兩列，直接數列會報成「2 筆」。2026-08-11 Owner 從報名成功信抓到
 * 這件事（發票 DL02996195：兩列同 batch、同 checkout、同期）。
 *
 * 正確的單位是 `(enrollment_batch_id, period_number)`。這支測試鎖住三件事：
 *   1. 分組鍵不能退化成只用 batch —— 250 個 batch 裡有 45 個橫跨多期，
 *      只用 batch 會把第 1 期和第 2 期併成一筆
 *   2. 分桶要保守 —— 同一筆內堂數不一致時（實測 5 筆），全員上完才算已完成
 *   3. 班級名冊要走三選一 join，且每位學生掛回自己的家長
 *
 * 這裡驗的是 SQL 本身的形狀與純函式的行為，不連資料庫。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const sessionsSrc = read('server/routes/sessions.js');

// 掃描前剝註解：這個檔案的註解裡就寫著 enrollment_batch_id、period_number 等字，
// 不剝的話「有沒有用到某個欄位」的斷言會被說明文字餵飽而全綠。
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code';
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === '-' && d === '-') { mode = 'sql'; i += 2; continue; }   // SQL 註解
      out += c; i += 1; continue;
    }
    if (mode === 'line' || mode === 'sql') {
      if (c === '\n') { mode = 'code'; out += c; }
      i += 1; continue;
    }
    if (c === '*' && d === '/') { mode = 'code'; i += 2; continue; }
    i += 1;
  }
  return out;
}

const code = stripComments(sessionsSrc);

check('剝註解本身有效（否則下面每一條都是假綠燈）', () => {
  const sample = stripComments('a\n// 這行是註解 GROUP BY\n/* 區塊 GROUP BY */\nb -- SQL GROUP BY\nc');
  assert.ok(!/註解/.test(sample), '行註解沒剝掉');
  assert.ok(!/區塊/.test(sample), '區塊註解沒剝掉');
  assert.ok(!/SQL GROUP BY/.test(sample), 'SQL 註解沒剝掉');
  assert.ok(/a/.test(sample) && /b/.test(sample) && /c/.test(sample), '把程式碼也剝掉了');
  assert.ok(code.length > sessionsSrc.length * 0.4,
    '剝完只剩 ' + code.length + '/' + sessionsSrc.length + ' 字元，剝壞了');
});

check('訂單分組鍵是 (batch, period)，不是單獨的 batch', () => {
  assert.ok(/COALESCE\(ae\.enrollment_batch_id::text,\s*ae\.id\)\s+AS\s+batch_key/.test(code),
    'batch_key 沒有用 COALESCE 退回 id —— batch 為 NULL 的列會整列消失');
  const agg = code.match(/agg AS \(([\s\S]*?)\n  \),/);
  assert.ok(agg, '掃描失效：找不到 agg CTE');
  assert.ok(/GROUP BY 1,\s*2/.test(agg[1]),
    'agg 沒有 GROUP BY 1, 2 —— 只用 batch 分組會把跨期的訂單併成一筆，'
    + '那 45 個跨期 batch 會讓「第一期進行中＋第二期待對帳」變成一筆');
  assert.ok(/SELECT s\.batch_key,\s*s\.period_number/.test(agg[1]),
    'agg 的分組欄位不是 batch_key + period_number');
});

check('分桶保守：min(used) 對 max(total)', () => {
  const agg = code.match(/agg AS \(([\s\S]*?)\n  \),/)[1];
  assert.ok(/min\(COALESCE\(s\.used_sessions,\s*0\)\)\s+AS\s+used_sessions/.test(agg),
    'used 不是取 min —— 取 max 會讓「其中一位上完」就整筆算已完成');
  assert.ok(/max\(s\.total_sessions\)\s+AS\s+total_sessions/.test(agg), 'total 不是取 max');
  assert.ok(!/max\(COALESCE\(s\.total_sessions/.test(agg),
    'total 用了 max(COALESCE(...,999))：一列 6、一列 NULL 時會算成 999 堂，'
    + '該筆永遠不會變成已完成');
});

check('三個桶互斥且涵蓋全部（待對帳優先，否則看堂數）', () => {
  const m = code.match(/CASE WHEN a\.status = 'pending_payment'([\s\S]*?)AS bucket/);
  assert.ok(m, '掃描失效：找不到 bucket 的 CASE');
  const c = m[1];
  assert.ok(/THEN 'pending_payment'/.test(c), '缺 pending_payment 桶');
  assert.ok(/a\.used_sessions >= COALESCE\(a\.total_sessions,\s*999\)[\s\S]*?THEN 'completed'/.test(c),
    '已完成的條件不是 used >= total（含 total 全 NULL 時的 999 退路）');
  assert.ok(/ELSE 'in_progress'/.test(c),
    '沒有 ELSE —— 落不進任何桶的訂單會拿到 NULL bucket，在畫面上無聲消失');
});

check('狀態不一致時偏向「還沒好」', () => {
  const agg = code.match(/agg AS \(([\s\S]*?)\n  \),/)[1];
  assert.ok(/max\(s\.status\)\s+AS\s+status/.test(agg),
    'status 不是取 max —— pending_payment 字典序大於 confirmed，取 max 才會偏向'
    + '「還沒好」；取 min 會把還沒對帳的那半當成已確認');
});

check('counts 與 items 走同一組 CTE（兩份 SQL 會分岔）', () => {
  assert.ok(/const COACH_ORDER_CTE = `/.test(code), '沒有把 CTE 抽成共用常數');
  const uses = (code.match(/\$\{COACH_ORDER_CTE\}/g) || []).length;
  assert.strictEqual(uses, 2,
    'COACH_ORDER_CTE 被引用 ' + uses + ' 次，預期 2（items 一次、counts 一次）。'
    + '任何一邊自己寫一份，數字和列表就會對不起來');
});

check('counts 三個桶都預先給 0', () => {
  assert.ok(/counts = \{\s*in_progress:\s*0,\s*completed:\s*0,\s*pending_payment:\s*0\s*\}/.test(code),
    '沒有把三個桶都初始化成 0 —— 少掉的 key 在前端是 undefined，'
    + '「全部」的加總就對不起來');
});

// ── 班級名冊 ──────────────────────────────────────────────────────────────
check('班級名冊走三選一 join，不能只用 admin_enrollment_id', () => {
  const p = code.match(/periods AS \(([\s\S]*?)\n         \),/);
  assert.ok(p, '掃描失效：找不到 periods CTE');
  const j = p[1];
  assert.ok(/cp\.admin_enrollment_id = s\.id/.test(j), '缺直連條件');
  assert.ok(/cp\.enrollment_batch_id = s\.enrollment_batch_id AND cp\.period_number = s\.period_number/.test(j),
    '缺 batch 條件 —— 一筆訂單多列時，只有其中一列直連得到班');
  assert.ok(/cp\.group_order_id\s+= s\.group_order_id\s+AND cp\.period_number = s\.period_number/.test(j),
    '缺團報條件 —— 那正是「別的家庭同班」唯一對得到的路徑，漏掉就整類看不到');
  assert.ok(/ae\.enrollment_batch_id,/.test(code),
    'scoped 沒有帶出原始 enrollment_batch_id —— 只有 text 的 batch_key 會對不上 uuid 欄位');
});

check('每位學生掛在自己的家長底下（不是訂單上的付款人）', () => {
  const r = code.match(/roster AS \(([\s\S]*?)\n         \),/);
  assert.ok(r, '掃描失效：找不到 roster CTE');
  assert.ok(/JOIN students st\s+ON st\.id\s+= cpe\.student_id/.test(r[1]),
    '名冊沒有從 course_period_enrollments 取學生');
  assert.ok(/JOIN parents\s+par ON par\.id = st\.parent_id/.test(r[1]),
    '沒有走 students.parent_id → parents —— 用訂單上的 parent_name 的話，'
    + '別的家庭的小孩會被掛到付款人底下');
  assert.ok(/cpe\.status = 'active'/.test(r[1]), '沒有過濾 active，退課的學生會留在名冊上');
  assert.ok(/leader_parent_id/.test(r[1]), '沒有標團主');
});

check('全班人數用各家庭相加，不會重複計數', () => {
  const c = code.match(/classes AS \(([\s\S]*?)\n         \)/);
  assert.ok(c, '掃描失效：找不到 classes CTE');
  assert.ok(/SUM\(cardinality\(students\)\)::int AS class_size/.test(c[1]),
    'class_size 不是各家庭人數相加');
  const f = code.match(/fam AS \(([\s\S]*?)\n         \),/);
  assert.ok(/array_agg\(DISTINCT student_name\)/.test(f[1]),
    'fam 沒有 DISTINCT —— 同一位學生在多個 period 出現時會被重複計入');
});

// ── 前端 ──────────────────────────────────────────────────────────────────
const rowSrc = stripComments(read('client/liff/src/components/coach/EnrollmentRow.jsx'));

check('前端 bucketOf 吃整個 item，且以後端的 bucket 為準', () => {
  assert.ok(/export function bucketOf\(item\)/.test(rowSrc),
    'bucketOf 不存在或簽章不是吃 item —— 只吃 status 的話分不出進行中與已完成');
  assert.ok(!/stageOf/.test(rowSrc), '舊的 stageOf 還在，兩套判定會分岔');
  assert.ok(/item\?\.bucket \|\| legacyBucket\(item\)/.test(rowSrc),
    'bucketOf 沒有優先採用後端的 item.bucket');
});

check('部署視窗相容：舊 API 沒有 bucket 時仍分得出三個桶', () => {
  // 這個部署模型下前後端必然不同步：靜態檔寫進 server/public 立刻生效，
  // 後端要等 process 重啟。少了這層，那段視窗內教練會看到「進行中 0、已完成 0」
  // 加一排英文 confirmed。
  assert.ok(/function legacyBucket\(item\)/.test(rowSrc), '沒有舊 API 的退路');
  assert.ok(/export function countsFrom\(data\)/.test(rowSrc), 'counts 沒有相容轉換');
  assert.ok(/in_progress: c\.confirmed \|\| 0, completed: 0/.test(rowSrc),
    '舊 counts 沒有把 confirmed 全歸進行中 —— 寧可少報已完成，'
    + '也不要把還在上的課標成結束');
});

check('legacyBucket 的邊界（掃描擋不住的那一類）', () => {
  // 取出純函式直接跑。第一版寫成 Number.isFinite(Number(total)) —— Number(null)
  // 是 0 而且是有限數，total 為 NULL 的列會被當成 0 堂而誤判「已完成」。
  // 正式庫有 183 列 total 為 NULL，純掃描字串抓不到這種錯。
  const m = rowSrc.match(/function legacyBucket\(item\) \{[\s\S]*?\n\}/);
  assert.ok(m, '掃描失效：取不到 legacyBucket');
  // eslint-disable-next-line no-eval
  const legacyBucket = eval('(' + m[0].replace('function legacyBucket', 'function') + ')');
  const cases = [
    ['未上完',         { status: 'confirmed', used_sessions: 5, total_sessions: 6 }, 'in_progress'],
    ['剛好上完',       { status: 'confirmed', used_sessions: 6, total_sessions: 6 }, 'completed'],
    ['超過',           { status: 'confirmed', used_sessions: 7, total_sessions: 6 }, 'completed'],
    ['total 為 null',  { status: 'confirmed', used_sessions: 0, total_sessions: null }, 'in_progress'],
    ['total 缺欄位',   { status: 'confirmed', used_sessions: 2 }, 'in_progress'],
    ['total 為空字串', { status: 'confirmed', used_sessions: 0, total_sessions: '' }, 'in_progress'],
    ['used 為 null',   { status: 'confirmed', used_sessions: null, total_sessions: 6 }, 'in_progress'],
    ['待對帳原樣',     { status: 'pending_payment' }, 'pending_payment'],
  ];
  for (const [label, item, expect] of cases) {
    assert.strictEqual(legacyBucket(item), expect, label + ' 應為 ' + expect);
  }
});

check('前端三個桶的 key 與後端一致', () => {
  const m = rowSrc.match(/export const ENROLL_STAGES = \[([\s\S]*?)\];/);
  assert.ok(m, '掃描失效：找不到 ENROLL_STAGES');
  const keys = [...m[1].matchAll(/key:\s*'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepStrictEqual(keys, ['completed', 'in_progress', 'pending_payment'],
    '前端的桶是 [' + keys.join(', ') + ']，與後端 bucket 的三個值對不起來');
});

check('多位家長不硬挑第一位當代表', () => {
  assert.ok(/位家長/.test(rowSrc),
    '跨家庭一起結帳時硬取第一位家長，教練會看到一個跟其他學員不相干的名字');
  assert.ok(/parent_names/.test(rowSrc), '沒有讀後端回傳的 parent_names 陣列');
});

check('前端只在「班比訂單大」時才列同班名冊', () => {
  assert.ok(/if \(size <= ownStudents\.length\) return null;/.test(rowSrc),
    '沒有這個判斷的話，276 筆名冊與訂單完全相同的訂單會多出一整塊重複資訊');
  assert.ok(/名單待對帳後確認/.test(rowSrc),
    '對帳前沒有 course_period，要標示清楚，否則教練會以為訂單上那幾個名字就是全班');
  assert.ok(/團主/.test(rowSrc), '前端沒有顯示團主');
});

if (failed) { console.error('coach_order_bucket_test: ' + failed + ' failed'); process.exit(1); }
console.log('coach_order_bucket_test: all passed');
