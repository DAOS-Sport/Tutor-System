'use strict';
/**
 * 上課紀錄查詢（/admin/sessions）的「備註」欄。
 *
 * 櫃檯反映：手動扣課與家長扣課的原因在畫面上完全看不到，出事時查不出
 * 「這堂到底是誰扣的、為什麼扣」。備註要對**任何角色**都看得到。
 *
 * 這支測試守三件事，每一件都是實際踩過或差點踩到的：
 *
 * (1) 扣課狀態的對應是白名單。正式庫實際值是 APPLIED(171) / REVERSED(4)，
 *     一開始寫成「不等於 active 就當作已退回」，那會把 171 筆正常扣課
 *     全部標成已退回。同類錯誤在這個 codebase 已重複多次，所以正面鎖住。
 *
 * (2) 「由誰簽的」不能一路 COALESCE。checked_in_by_student_id 在櫃檯簽到時
 *     會等於該列自己的 student_id（正式庫 300/300），COALESCE 會把學員自己
 *     當成操作者，畫面變成「由 張軒睿 簽到」——看起來像學員自助簽的。
 *
 * (3) UNION 兩邊欄位要對齊。admin_today_sessions 那條沒有扣課／簽到明細，
 *     漏補 NULL 會讓整支查詢在執行期才炸，而不是被測試擋下。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SESSIONS_SRC = fs.readFileSync(path.join(ROOT, 'server/routes/admin/sessions.js'), 'utf8');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SESSIONS_SRC);

const NEW_FIELDS = [
  'deduction_reason', 'deducted_by', 'deducted_at',
  'deduction_status', 'deduction_reversal_reason', 'checkin_details',
];

(async () => {
  const fmt = await import('../client/admin/src/utils/format.js');

  // ── (1) 扣課狀態：白名單，不是「不等於某值」 ───────────────────
  check('APPLIED 是正常扣課，不可以被標成已退回', () => {
    const n = fmt.sessionNoteSummary({ deduction_reason: '8/12 上課', deduction_status: 'APPLIED' });
    assert.ok(n, '有扣課原因卻回 null');
    assert.strictEqual(n.tag, '手動扣課', `APPLIED 被標成「${n.tag}」——正式庫有 171 筆是這個狀態`);
    assert.notStrictEqual(n.tone, 'error', 'APPLIED 不該用錯誤色');
    assert.strictEqual(n.text, '8/12 上課', '應顯示扣課原因');
  });

  check('REVERSED 才是已退回，且顯示退回原因', () => {
    const n = fmt.sessionNoteSummary({
      deduction_reason: '8/9 上課', deduction_status: 'REVERSED',
      deduction_reversal_reason: '重複扣課',
    });
    assert.strictEqual(n.tag, '扣課已退回');
    assert.strictEqual(n.tone, 'error');
    assert.strictEqual(n.text, '重複扣課', '已退回時應優先顯示退回原因');
  });

  check('沒有退回原因的 REVERSED 退回顯示原扣課原因，不留空白', () => {
    const n = fmt.sessionNoteSummary({ deduction_reason: '經教練確認', deduction_status: 'REVERSED' });
    assert.strictEqual(n.text, '經教練確認', '空白會讓櫃檯以為系統沒記錄');
  });

  check('未知狀態要被看見，不可以被歸進任何一邊', () => {
    const n = fmt.sessionNoteSummary({ deduction_reason: 'x', deduction_status: 'PENDING_REVIEW' });
    assert.ok(n.tag.includes('PENDING_REVIEW'),
      `未知狀態「PENDING_REVIEW」沒有出現在標籤上（目前是「${n.tag}」）。`
      + '悄悄當成正常或當成退回，都會讓新狀態被無聲吞掉');
  });

  // ── (2) 家長扣課：來源與簽到人 ────────────────────────────────
  check('家長自助簽到顯示來源與簽到人', () => {
    const n = fmt.sessionNoteSummary({
      checkin_details: [
        { student: '甲', source: 'parent', by: '王媽媽' },
        { student: '乙', source: 'parent', by: '王媽媽' },
      ],
    });
    assert.strictEqual(n.tag, '家長自助', `來源標籤是「${n.tag}」`);
    assert.strictEqual(n.text, '王媽媽', '共班一次簽到會有多列、來源與人相同，摘要要去重');
  });

  check('櫃檯簽到沒有操作者時，不可以印出 undefined 或學員自己的名字', () => {
    // 正式庫 300/300 的 staff 簽到，checked_in_by_student_id 都等於該列自己的
    // student_id。後端已改成回 null，前端這裡要能吃下 null。
    const n = fmt.sessionNoteSummary({
      checkin_details: [{ student: '張軒睿', source: 'staff', by: null }],
    });
    assert.strictEqual(n.tag, '櫃檯');
    assert.strictEqual(n.text, '', `by 為 null 時 text 應為空字串，目前是「${n.text}」`);
    assert.ok(!String(n.text).includes('undefined'), '出現 undefined');
    assert.ok(!String(n.text).includes('張軒睿'),
      '把學員自己當成簽到人 —— 看起來像學員自助簽的，會誤導查帳');
  });

  check('手動扣課優先於簽到來源（人工介入要先被看到）', () => {
    const n = fmt.sessionNoteSummary({
      deduction_reason: '舊家教轉新家教須扣除原本堂數',
      deduction_status: 'APPLIED',
      checkin_details: [{ student: '甲', source: 'staff', by: null }],
    });
    assert.strictEqual(n.tag, '手動扣課');
    assert.ok(n.text.includes('舊家教'));
  });

  check('什麼都沒有時回 null（讓 UI 顯示「—」而不是空徽章）', () => {
    assert.strictEqual(fmt.sessionNoteSummary({ checkin_details: [] }), null);
    assert.strictEqual(fmt.sessionNoteSummary({}), null);
    assert.strictEqual(fmt.sessionNoteSummary(null), null);
  });

  check('checkinSourceLabel 三種來源都有中文，未知值原樣顯示', () => {
    assert.strictEqual(fmt.checkinSourceLabel('parent'), '家長自助');
    assert.strictEqual(fmt.checkinSourceLabel('coach'), '教練');
    assert.strictEqual(fmt.checkinSourceLabel('staff'), '櫃檯');
    assert.strictEqual(fmt.checkinSourceLabel('robot'), 'robot',
      '未知來源印英文比印空白好：至少看得出「有東西但沒對應到」');
  });

  // ── (3) 後端：欄位有回、UNION 對齊、不加角色門檻 ───────────────
  check('後端 SELECT 有這些欄位，且 rowToSession 有把它們映射出去', () => {
    // 兩邊都要驗：只有 SQL 有、rowToSession 沒帶，前端一樣拿不到。
    const mapper = CODE.slice(CODE.indexOf('function rowToSession'));
    for (const f of NEW_FIELDS) {
      assert.ok(CODE.includes('AS ' + f), `SELECT 少了 alias「AS ${f}」`);
      assert.ok(mapper.includes(f + ':'), `rowToSession 沒有把 ${f} 帶進回傳物件`);
    }
  });

  check('UNION 另一邊補齊了同樣的欄位（少一個就是執行期才炸）', () => {
    const branch = CODE.slice(CODE.indexOf('FROM admin_today_sessions ats') - 900,
      CODE.indexOf('FROM admin_today_sessions ats'));
    for (const f of NEW_FIELDS) {
      assert.ok(branch.includes(f), `admin_today_sessions 那條少補 ${f} 的 NULL`);
    }
  });

  check('「由誰簽的」用 CASE 依來源取，不是一路 COALESCE', () => {
    assert.ok(/WHEN cr\.checked_in_by_student_id IS NOT NULL\s*\n?\s*AND cr\.checked_in_by_student_id <> cr\.student_id/.test(CODE),
      '缺少「簽到人不等於學員本人才算操作者」這道守門');
    assert.ok(!/COALESCE\(pb\.name, cb\.name, sb\.name\)/.test(CODE),
      '仍有一路 COALESCE 的寫法 —— 櫃檯簽到會把學員自己當成操作者');
  });

  check('備註不加角色門檻：任何登入的後台角色都看得到', () => {
    const line = CODE.split('\n').find((l) => l.includes("router.get('/', requireAdminAuth"));
    assert.ok(line, "找不到 GET '/' 的定義 —— 掃描失效");
    assert.ok(!line.includes('requireAdminRole'),
      '上課紀錄查詢被加上角色門檻了，但需求是任何角色都要看得到備註');
  });

  check('掃描沒有失效：拿掉一個欄位就要被抓到', () => {
    assert.ok(CODE.includes('AS deduction_reason'), '基準比對不到，掃描已失效');
    const mutated = CODE.split('AS deduction_reason').join('AS XXX_removed');
    assert.ok(!mutated.includes('AS deduction_reason'),
      '突變後仍找得到，表示比對的不是真的那一段');
  });

  console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
  process.exit(failed ? 1 : 0);
})();
