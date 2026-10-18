'use strict';
/**
 * Ragic 備份同步：隔離區的「自癒」必須涵蓋家長側的修正
 * ===========================================================================
 *
 * ── 這支在防什麼 ──
 * backup 排程（ragicAdmin._backupParentsStudentsImpl）會把「上次異動之後就一直
 * 因資料問題失敗」的列隔離起來，不再每輪重打 Ragic。判準寫在
 * syncFailureLog.stuckExclusionSql()：
 *
 *     隔離 ⟺ 存在一筆 permanent 失敗，且 f.occurred_at >= 該筆的「最後異動時間」
 *
 * 隔離本身是對的，但它的正確性完全押在「最後異動時間」取得對不對。學員送去
 * Ragic 的 payload **內嵌家長欄位**（ragic.js FIELD.Z02.PARENT_EMAIL，以及家長
 * 姓名／電話／性別／身分／館別），所以學員會因為「**家長**缺 Email」而失敗 ——
 * 正式庫實測：90 筆被隔離的學員裡有 69 筆（橫跨 55 位家長）就是這個原因，
 * Ragic 回的是「INVALID 202: 欄位 (報)Email 為必填」。
 *
 * 而櫃檯補資料時補的是 parents.email，動到的是 parents.updated_at；
 * students.updated_at 一動也不動（parents/students 兩張表都沒有任何 trigger，
 * 已對正式庫的 information_schema.triggers 查證，updated_at 只由應用層明寫的
 * SQL 設定）。
 *
 * 於是「只看 students.updated_at」會產生最壞的一種結果：
 *   資料明明修好了，那 69 筆學員卻**永遠**留在隔離區，再也不會被推上 Ragic。
 * 這正是 syncFailureLog.js 註解裡說要避免的「另一種災難：資料修好了卻永遠不再
 * 同步」——而且它是靜默的，沒有任何 log 會喊。
 *
 * 修法：學員的判準改取 GREATEST(學員 updated_at, 家長 updated_at)。
 *
 * ── 為什麼要連呼叫端的別名一起釘 ──
 * stuckExclusionSql 回傳的是 SQL 片段，家長別名是由呼叫端那句 query 決定的：
 * 統計那句 JOIN 出來的家長叫 pp，撈待同步那句叫 p。傳錯別名不會有任何靜態錯誤，
 * 要等排程真的在正式環境跑起來、Postgres 丟
 * 「missing FROM-clause entry for table ...」才會現形，而那時 backup 是整輪掛掉。
 * 所以這裡除了檢查有沒有帶家長 updated_at，也檢查帶的別名在那句 query 裡真的
 * JOIN 得到。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stuckExclusionSql } = require('../server/services/syncFailureLog');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

// ── 1. 預設行為不得改變：家長那側仍然只看自己的 updated_at ──
// 家長的 payload 不內嵌別人的欄位，取自己的 updated_at 就是對的。
check('家長：未指定 freshnessExpr 時仍綁自己的 updated_at', () => {
  const sql = stuckExclusionSql('p', 'Z01_Z02_BACKUP', 'parent');
  assert.ok(sql.includes('f.occurred_at >= p.updated_at'),
    '家長判準必須維持 f.occurred_at >= p.updated_at');
  assert.ok(sql.includes("f.entity_kind = 'parent'"), 'entity_kind 必須帶進 SQL');
  assert.ok(sql.trim().startsWith('NOT EXISTS'), '要能直接接在 WHERE 後面');
});

// ── 2. 帶 freshnessExpr 時必須整段換掉，而不是附加 ──
check('學員：freshnessExpr 會取代預設的 alias.updated_at', () => {
  const sql = stuckExclusionSql('s', 'Z01_Z02_BACKUP', 'student',
    'GREATEST(s.updated_at, p.updated_at)');
  assert.ok(sql.includes('f.occurred_at >= GREATEST(s.updated_at, p.updated_at)'),
    '必須用 GREATEST 取兩者較新者');
  // 若只是附加而沒取代，會留下「>= s.updated_at」這種比較寬鬆的條件，
  // 隔離就會提前解除、回到每輪重打 Ragic 的老問題。
  assert.ok(!/f\.occurred_at >= s\.updated_at\b/.test(sql),
    '不得殘留原本只看 s.updated_at 的條件');
  // local_id 是 uuid，寫成 ::text 會在執行期炸 operator does not exist: uuid = text
  assert.ok(/f\.local_id = s\.id(?!::)/.test(sql), 'local_id 是 uuid，不可轉 text 比對');
});

// ── 3. 真正的迴歸守門：ragicAdmin 兩處學員查詢都必須帶家長的 updated_at ──
// 這兩處只要有一處退回舊寫法，那 69 筆學員就會再次變成永久卡住。
const adminSrc = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'services', 'ragicAdmin.js'), 'utf8');

// 抓出所有 entity_kind='student' 的 stuckExclusionSql 呼叫（含第 4 個參數）
const studentCalls = [...adminSrc.matchAll(
  /stuckExclusionSql\(\s*'([^']+)'\s*,\s*'Z01_Z02_BACKUP'\s*,\s*'student'\s*(?:,\s*'([^']*)')?\s*\)/g
)];

check('ragicAdmin 裡剛好有兩處學員隔離判準（統計 + 撈待同步）', () => {
  assert.strictEqual(studentCalls.length, 2,
    `預期 2 處，實際 ${studentCalls.length} 處；新增呼叫點也必須套用同樣的家長感知判準`);
});

check('兩處學員判準都帶了家長的 updated_at', () => {
  for (const [full, , freshnessExpr] of studentCalls) {
    assert.ok(freshnessExpr,
      `學員隔離判準缺少 freshnessExpr，家長補完 Email 後這些學員將永遠卡住：${full}`);
    assert.ok(/GREATEST\s*\(/i.test(freshnessExpr),
      `freshnessExpr 必須用 GREATEST 取較新者，實際：${freshnessExpr}`);
    assert.ok(/\bs\.updated_at\b/.test(freshnessExpr),
      `freshnessExpr 必須包含學員自己的 updated_at，實際：${freshnessExpr}`);
  }
});

// ── 4. 家長別名必須在該句 query 裡真的 JOIN 得到 ──
// 傳錯別名是靜態檢查抓不到、只有正式環境才會炸的那種錯。
check('freshnessExpr 引用的家長別名在同一句 query 裡有 JOIN', () => {
  for (const [full, , freshnessExpr] of studentCalls) {
    // 取出 GREATEST 裡「不是 s.」的那個別名，就是家長別名
    const aliases = [...freshnessExpr.matchAll(/\b([a-z_]+)\.updated_at\b/g)]
      .map((m) => m[1])
      .filter((a) => a !== 's');
    assert.strictEqual(aliases.length, 1,
      `freshnessExpr 應剛好引用一個家長別名，實際：${freshnessExpr}`);
    const parentAlias = aliases[0];

    // 在原始碼裡找到這句呼叫所在的 query，往前抓它的 JOIN 宣告
    const at = adminSrc.indexOf(full);
    assert.ok(at > 0, '找不到呼叫點在原始碼中的位置');
    const queryStart = adminSrc.lastIndexOf('SELECT', at);
    const enclosing = adminSrc.slice(queryStart, at);
    const joinRe = new RegExp(`JOIN\\s+parents\\s+${parentAlias}\\b`);
    assert.ok(joinRe.test(enclosing),
      `別名 ${parentAlias} 在該句 query 裡沒有 JOIN parents，正式環境會噴 ` +
      `"missing FROM-clause entry for table ${parentAlias}" 讓整輪 backup 掛掉`);
  }
});

// ── 5. 家長那處不得被誤改成帶 freshnessExpr ──
// 家長查詢只有 FROM parents p，沒有別的表可取；誤帶會直接是無效 SQL。
check('家長隔離判準維持單一參數形式', () => {
  const parentCalls = [...adminSrc.matchAll(
    /stuckExclusionSql\(\s*'([^']+)'\s*,\s*'Z01_Z02_BACKUP'\s*,\s*'parent'\s*(?:,\s*'([^']*)')?\s*\)/g
  )];
  assert.strictEqual(parentCalls.length, 2, `預期 2 處家長呼叫，實際 ${parentCalls.length} 處`);
  for (const [full, , freshnessExpr] of parentCalls) {
    assert.ok(!freshnessExpr,
      `家長查詢只 FROM parents，帶 freshnessExpr 會產生無效 SQL：${full}`);
  }
});

// ── 6. 語意檢查：把判準當成純函式跑一遍「櫃檯補完 Email」的情境 ──
// 用 stuckExclusionSql 產生的比較運算式，獨立在 JS 重算一次隔離判斷，
// 確認「家長被修正」這件事真的會讓學員脫離隔離。
check('情境：家長補完 Email 後，該學員必須脫離隔離', () => {
  const sql = stuckExclusionSql('s', 'Z01_Z02_BACKUP', 'student',
    'GREATEST(s.updated_at, p.updated_at)');
  // 從 SQL 取出實際使用的門檻運算式，避免測試自己另外寫一份而與程式碼脫節
  const m = sql.match(/f\.occurred_at >= (.+)\n/);
  assert.ok(m, '取不出門檻運算式');
  const threshold = m[1].trim();
  assert.strictEqual(threshold, 'GREATEST(s.updated_at, p.updated_at)');

  const evalThreshold = (s, p) => Math.max(s.updated_at, p.updated_at);
  const isQuarantined = (failureAt, s, p) => failureAt >= evalThreshold(s, p);

  const T = (n) => n; // 用單調遞增的數字代表時間
  const student = { updated_at: T(10) };
  const parentBefore = { updated_at: T(5) };
  const failureAt = T(20); // 失敗發生在兩者最後異動之後

  assert.strictEqual(isQuarantined(failureAt, student, parentBefore), true,
    '尚未修正前應該維持隔離，否則等於沒有隔離、每輪繼續重打 Ragic');

  // 櫃檯補上 Email：只有 parents.updated_at 前進，students.updated_at 不變
  const parentAfter = { updated_at: T(30) };
  assert.strictEqual(isQuarantined(failureAt, student, parentAfter), false,
    '家長補完 Email 後必須脫離隔離，否則這批學員永遠不會再被推上 Ragic');

  // 對照：舊判準（只看學員）在同一情境下會卡死 —— 這正是本測試要防的迴歸
  const oldRule = (fAt, s) => fAt >= s.updated_at;
  assert.strictEqual(oldRule(failureAt, student), true,
    '舊判準在家長修正後仍然隔離（這就是被修掉的錯誤行為）');
});

if (failures) {
  console.error(`\nragic_backup_quarantine_selfheal_test: FAIL (${failures} 項)`);
} else {
  console.log('\nragic_backup_quarantine_selfheal_test: PASS');
}
process.exitCode = failures ? 1 : 0;
