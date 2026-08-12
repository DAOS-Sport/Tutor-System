'use strict';
/**
 * 退費頁載入效能與搜尋。
 *
 * ── 原本慢在哪 ──
 * GET /admin/enrollments 的清單是「先 SELECT id，再 for 迴圈逐筆 await
 * readEnrollment」，而 readEnrollment 一筆打 2 次 DB。正式庫 807 筆
 * ＝ 1,614 次**循序**往返；DB 在 Neon（遠端），每次往返的固定成本才是主角。
 * 而且退費頁連 status 都沒帶，866 筆整包撈回來再在前端 .filter 掉 59 筆。
 *
 * ── 這支測試守什麼 ──
 * 效能修法很容易在之後被「順手」改回去（例如為了加一個欄位又寫一次迴圈），
 * 所以鎖的是結構，不是速度數字：
 *   1. 清單不得再出現逐筆 await 的迴圈
 *   2. 單筆與批次必須共用同一個組裝函式（分岔的症狀是「明細有、清單沒有」）
 *   3. 批次要防 join 扇出、要保持傳入順序
 *   4. status 多值過濾要真的走到 SQL，而且 placeholder 不能少一個錢字號
 *
 * 形狀是否真的一致，另外用 DEV 實庫逐欄位比對過（8 筆、含 audit_logs 全等）。
 * 那需要資料庫，不放進 unit 層。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const API = stripComments(read('server/routes/admin/enrollments.js'));
const PAGE = stripComments(read('client/admin/src/pages/RefundPage.jsx'));

// 直接用字元碼組出錢字號。這支測試裡它同時是「要驗的東西」與「樣板語法」，
// 混在一起很容易在編輯時被吃掉一個 —— 這次上線的 500 就是這樣來的。
const S = String.fromCharCode(36);

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// ── 1. N+1 不得復活 ─────────────────────────────────────────────
check('清單不再逐筆 await readEnrollment（N+1 的來源）', () => {
  assert.ok(!/for \(const row of r\.rows\) out\.push\(await readEnrollment/.test(API),
    '逐筆 await 的迴圈回來了 —— 807 筆會變成 1,614 次循序往返');
  assert.ok(/readEnrollmentsByIds\(r\.rows\.map/.test(API),
    '清單沒有走批次讀取');
});

check('批次讀取固定 2 次查詢，且兩次併發', () => {
  const fn = API.slice(API.indexOf('async function readEnrollmentsByIds'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const queries = (body.match(/pool\.query\(/g) || []).length;
  assert.strictEqual(queries, 2,
    '批次版有 ' + queries + ' 次查詢，應該剛好 2 次（主表 + audit）。'
    + '多出來的通常是又在迴圈裡補查了什麼，那就是 N+1 換個地方長回來');
  assert.ok(/Promise\.all\(\[/.test(body), '兩次查詢應併發，不要一前一後');
  assert.ok(!/for \([^)]*\)\s*\{[^}]*await /.test(body), '批次版內部出現了 await 迴圈');
});

// ── 2. 形狀不得分岔 ─────────────────────────────────────────────
check('單筆與批次共用同一個組裝函式', () => {
  assert.ok(/function shapeEnrollment\(/.test(API), '找不到共用的 shapeEnrollment');
  const uses = (API.match(/shapeEnrollment\(/g) || []).length;
  assert.ok(uses >= 3,
    'shapeEnrollment 只被引用 ' + uses + ' 次（定義 1 + 單筆 1 + 批次 1 至少要 3）。'
    + '有一邊自己組物件的話，清單與明細的欄位遲早分岔');
  // 反向確認：不可以有第二處在手工拼那個物件。用只屬於報名形狀的欄位當簽名——
  // 「id: row.id」太寬，會誤中 sibling_refunds 之類不相關的物件。
  for (const sig of ['line_profile_state:', 'line_bound:', 'audit_logs:']) {
    const n = (API.split(sig).length - 1);
    assert.strictEqual(n, 1,
      '「' + sig + '」出現 ' + n + ' 次，應該只在 shapeEnrollment 出現 1 次');
  }
});

check('SELECT 也共用一份（兩份 SQL 必然漂移）', () => {
  assert.ok(/const ENROLLMENT_SELECT = `/.test(API), '找不到共用的 ENROLLMENT_SELECT');
  const selects = (API.split('SELECT ae.*, au.name AS created_by_name').length - 1);
  assert.strictEqual(selects, 1, 'SELECT ae.* 出現 ' + selects + ' 次，應該只有 1 次');
});

// ── 3. 批次的兩個陷阱 ───────────────────────────────────────────
check('批次防 join 扇出（重複 id 只取一筆）', () => {
  const fn = API.slice(API.indexOf('async function readEnrollmentsByIds'));
  assert.ok(/seen\.has\(row\.id\)/.test(fn),
    '沒有去重。以電話正規化 join parents 時，一筆報名可能對到多位家長而讓列數膨脹，'
    + '單筆版取 rows[0] 天生不會重複，批次版要自己防');
});

check('批次保持傳入順序（ANY() 不保證順序）', () => {
  const fn = API.slice(API.indexOf('async function readEnrollmentsByIds'));
  assert.ok(/return ids\.map\(\(id\) => byId\.get\(id\)\)/.test(fn),
    '沒有依傳入的 id 順序回傳 —— 呼叫端已經 ORDER BY submitted_at DESC 排過，'
    + '照 rows 走會讓清單順序隨機漂');
});

check('批次不解析 LINE 顯示名稱（否則變成對外部 API 的 N+1）', () => {
  const fn = API.slice(API.indexOf('async function readEnrollmentsByIds'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/resolveParentLineDisplayName/.test(body),
    '批次版在解析 LINE 名稱 —— 那是對 LINE API 的 N+1 外部呼叫，清單刻意不做');
});

// ── 4. status 多值 + placeholder 完整性 ─────────────────────────
check('status 支援逗號分隔多值，且在 SQL 過濾', () => {
  // 這條原本留了一個「只要出現 ANY( 就算過」的寬鬆分支，
  // 於是 placeholder 少一個錢字號（實際產出 "status = 1"）照樣通過，
  // 上了正式站才被 500 抓到。改成逐字比對完整字串，不留退路。
  assert.ok(API.includes('where.push(`status = ' + S + S + '{args.length}`)'),
    '單值路徑的 placeholder 不對 —— 少一個錢字號會變成拿 enum 比整數，整支查詢 500');
  assert.ok(API.includes('where.push(`status::text = ANY(' + S + S + '{args.length}::text[])`)'),
    '多值路徑的 placeholder 不對');
  assert.ok(/\.split\(','\)/.test(API), 'status 沒有做逗號分隔解析');
  // 單值路徑要留著：其他頁面用 status=pending_payment 單值查詢。
  assert.ok(/statuses\.length === 1/.test(API),
    '單值路徑不見了 —— DashboardPage 與 EnrollmentsPage 都在用單一 status');
});

check('全檔沒有掉錢字號的 SQL placeholder（這次 500 的根因，通用防線）', () => {
  // 樣板裡的 ${args.length} 前面一定要再有一個錢字號，否則插出來是數字而不是 $N。
  // 這種錯不會在模組載入時被發現，只會在查詢執行時 500，值得一條全檔掃描。
  const re = new RegExp('(.)\\' + S + '\\{(?:args\\.length|idx)\\}', 'g');
  const bad = [];
  let m;
  while ((m = re.exec(API)) !== null) {
    if (m[1] !== S) {
      bad.push(API.slice(Math.max(0, m.index - 45), m.index + 22).replace(/\n/g, ' ').trim());
    }
  }
  assert.deepStrictEqual(bad, [],
    '有 SQL placeholder 少了錢字號：\n       ' + bad.join('\n       '));
});

check('退費頁改由後端過濾狀態，不再整包撈回來自己 filter', () => {
  assert.ok(/enrollmentsApi\.list\(\{ status: REFUND_STATUSES\.join\(','\) \}\)/.test(PAGE),
    '退費頁沒有把狀態帶給後端');
  assert.ok(!/data\.filter\(\(e\) => \[/.test(PAGE),
    '前端仍在自己過濾狀態 —— 多傳的那些列除了拖慢載入沒有用途');
});

// ── 5. 搜尋 ─────────────────────────────────────────────────────
check('搜尋涵蓋編號／家長／電話／學員／教練／場館', () => {
  const fn = PAGE.slice(PAGE.indexOf('function matchesQuery'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const f of ['row.id', 'row.parent_name', 'row.parent_phone', 'row.coach', 'venueName(row.venue_id)', 'row.students']) {
    assert.ok(body.includes(f), '搜尋沒有涵蓋 ' + f);
  }
});

check('電話另外比對純數字（貼上來常帶空白或破折號）', () => {
  const fn = PAGE.slice(PAGE.indexOf('function matchesQuery'));
  assert.ok(/onlyDigits\(row\.parent_phone\)\.includes\(digits\)/.test(fn),
    '只做字面比對的話，0912-345-678 會查不到，而使用者只會看到「查無資料」');
});

check('空字串不過濾（清空搜尋要看得到全部）', () => {
  const fn = PAGE.slice(PAGE.indexOf('function matchesQuery'));
  assert.ok(/if \(!q\) return true;/.test(fn) && /if \(!needle\) return true;/.test(fn),
    '空字串或純空白時應回 true');
});

check('搜尋時同時顯示「符合幾筆」與「共幾筆」', () => {
  assert.ok(PAGE.includes('符合'), '沒有顯示符合筆數');
  assert.ok(PAGE.includes('{list.length} 筆'),
    '沒有顯示總筆數 —— 只給符合筆數的話，查不到時分不出是「沒有這個人」還是「清單根本沒載到」');
  assert.ok(/rows=\{shown\}/.test(PAGE), '表格沒有吃過濾後的結果');
});

check('掃描沒有失效：把批次改回迴圈就要被抓到', () => {
  assert.ok(/readEnrollmentsByIds\(r\.rows\.map/.test(API), '基準比對不到，掃描已失效');
  const mutated = API.replace('readEnrollmentsByIds(r.rows.map', 'XXX(r.rows.map');
  assert.ok(!/readEnrollmentsByIds\(r\.rows\.map/.test(mutated),
    '突變後仍找得到，表示比對的不是真的那一段');
});

console.log(failed ? '\n' + failed + ' 項失敗' : '\n全部通過');
process.exit(failed ? 1 : 0);
