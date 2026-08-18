/**
 * 報名成功 → 教練推播（2026-08-18）
 *
 * 這支推播最容易出的三種錯，各鎖一條：
 *   1. 讀 period_count 算期數 —— 正式庫 69 個多期訂單那個欄位「全部」是錯的
 *      （連 7 期的都寫 1）。期數只能 count(DISTINCT period_number) 數出來
 *   2. 把金額／發票帶進推播 —— 教練端訂單 API 刻意不回這些，推播不能開後門
 *   3. 一列推一則 —— 一次報 3 期會變成 3 則；同期兩個小孩會變成 2 則
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}
// 先剝行註解、再剝區塊註解。順序顛倒的話，含有 "/*" 的 // 註解會吞掉後面的程式。
// 額外剝 SQL 的 -- 註解：這支檔案的查詢寫在模板字串裡，JS 的剝除碰不到它，
// 而我在 SQL 註解裡就寫著「不可讀 period_number」之類的字 —— 不剝的話
// 下面「不准出現 period_count」那條會被自己的註解觸發，變成假紅。
function stripComments(src) {
  return src
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
}

const NOTIFY = path.join(ROOT, 'server/services/enrollmentNotify.js');
const LINE = path.join(ROOT, 'server/services/line.js');
const line = require(path.join(ROOT, 'server/services/line.js'));
const T = line.templates.enrollmentSuccessToCoach;

check('期數用數的，不讀 period_count', () => {
  const src = stripComments(fs.readFileSync(NOTIFY, 'utf8'));
  assert.ok(/FROM admin_enrollments/.test(src), '掃描已失效：找不到 SQL');
  assert.ok(/JOIN coaches c ON c\.id = e\.coach_id/.test(src),
    '剝除註解後 SQL 被吃掉了 —— 本測試的結論不可信');

  assert.ok(/count\(DISTINCT e\.period_number\)\s+AS periods/.test(src),
    '期數不是 count(DISTINCT period_number) 算出來的');
  // 白名單式：整支 SQL 都不准出現 period_count。
  assert.ok(!/period_count/.test(src),
    '出現了 period_count —— 正式庫 69 個多期訂單那個欄位全部是錯的（7 期的寫 1）');
});

check('SQL 不得帶任何金額／發票欄位', () => {
  const src = stripComments(fs.readFileSync(NOTIFY, 'utf8'));
  const sql = src.slice(src.indexOf('SELECT'), src.indexOf('GROUP BY'));
  assert.ok(sql.includes('coach_id'), '掃描已失效：SQL 區段抓錯');
  const banned = ['final_price', 'unit_price', 'invoice', 'carrier', 'payment', 'discount', 'amount', 'remit'];
  const hit = banned.filter((k) => new RegExp(k, 'i').test(sql));
  assert.deepStrictEqual(hit, [],
    'SQL 選了不該給教練看的欄位：' + hit.join('、'));
});

check('一則＝一個 batch，去重鍵含教練與 batch', () => {
  const src = stripComments(fs.readFileSync(NOTIFY, 'utf8'));
  assert.ok(/WHERE e\.enrollment_batch_id = \$1/.test(src),
    '不是以 enrollment_batch_id 為單位');
  assert.ok(/refId: 'er:' \+ row\.coach_id \+ ':' \+ batchId/.test(src),
    '去重鍵不對 —— 對帳重跑會重複打擾教練');
  assert.ok(/status = 'confirmed'/.test(src), '沒有限定 confirmed —— 待對帳的也會推');
});

check('跨教練或沒綁 LINE 的 batch 一律不推', () => {
  const src = stripComments(fs.readFileSync(NOTIFY, 'utf8'));
  assert.ok(/if \(r\.rows\.length !== 1\) return null/.test(src),
    '跨教練的 batch 沒有擋 —— 會推給錯的人');
  assert.ok(/if \(!row\.coach_uid\) return null/.test(src),
    '教練沒綁 LINE 時沒有擋');
});

check('尚未接上對帳路徑（owner 2026-08-18 指示暫緩）', () => {
  // 樣板與服務都寫好也驗過了，但「還沒接線」。
  // owner 的判斷：對帳是走真發票、真寄信、真金流的路徑，目前運作正常，
  // 為了一個還送不出去的推播（LINE 額度 8/14 已滿）去動它不划算。
  //
  // 這條測試現在的作用是反過來的 —— 擋住任何人（含我）在沒講清楚之前
  // 把它接回去。要接的時候，把這條改成下面註解裡的正向斷言。
  for (const rel of ['server/routes/admin/enrollments.js', 'server/routes/admin/checkouts.js']) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.ok(/enqueueReconcileMail/.test(src), rel + ' 掃描已失效：找不到對帳寄信');
    assert.ok(!/enrollmentNotify|notifyEnrollment/.test(src),
      rel + ' 被接上了報名推播 —— owner 指示暫緩，接線前請先確認。\n'
      + '       接上時要一併驗：呼叫點在 COMMIT 之後、用 Safely 版本（fire-and-forget）、\n'
      + '       且往前找先遇到 COMMIT 而不是 BEGIN（推播不可落在交易內）。');
  }
});

check('服務本身可獨立運作（接線前就先驗好）', () => {
  const src = stripComments(fs.readFileSync(NOTIFY, 'utf8'));
  // 接線是一行的事，難的是這支服務對不對。它不依賴任何路由，可以先驗完擺著。
  assert.ok(/module\.exports = \{[^}]*notifyEnrollmentSafely/.test(src),
    '沒有匯出 fire-and-forget 版本 —— 接線時容易誤用 await 版把對帳拖下水');
  assert.ok(/Promise\.resolve\(\)[\s\S]{0,200}\.catch\(/.test(src),
    'Safely 版本沒有吃掉例外');
});

check('一期六堂是常數，未指定也算得出來', () => {
  assert.strictEqual(line.templates.SESSIONS_PER_PERIOD, 6, '每期堂數常數不是 6');
  const src = stripComments(fs.readFileSync(LINE, 'utf8'));
  assert.ok(/sessionsPerPeriod = SESSIONS_PER_PERIOD/.test(src),
    '樣板沒有把每期堂數預設成常數');

  const m = T({ studentNames: ['王小明'], periods: 3, courseType: '1 對 1' })[0];
  const body = JSON.stringify(m.contents.body);
  assert.ok(/3 期（每期 6 堂，共 18 堂）/.test(body), '期數列算錯：' + body.slice(0, 200));
});

check('「共 N 堂」晶片只在多期出現', () => {
  const one = JSON.stringify(T({ studentNames: ['甲'], periods: 1 })[0].contents.header);
  const many = JSON.stringify(T({ studentNames: ['甲'], periods: 3 })[0].contents.header);
  assert.ok(!/共 \d+ 堂/.test(one), '單期也印了「共 N 堂」—— 與「每期 6 堂」重複');
  assert.ok(/共 18 堂/.test(many), '多期沒有印總堂數');
});

check('團報徽章只在團報出現', () => {
  const solo = JSON.stringify(T({ studentNames: ['甲'], periods: 1, isGroup: false })[0]);
  const grp = JSON.stringify(T({ studentNames: ['甲'], periods: 1, isGroup: true })[0]);
  assert.ok(!/團報/.test(solo), '非團報也掛了團報徽章');
  assert.ok(/團報/.test(grp), '團報沒有徽章');
});

check('團報：一家一則，不可以合併成一則（會漏通知）', () => {
  const src = stripComments(fs.readFileSync(NOTIFY, 'utf8'));
  // 2026-08-18 驗工：16 個多-batch 團報，batch 數 = checkout 數，一個都不例外
  //   → 各家庭分開對帳，單次路由呼叫湊不齊
  //   → 若改用 group_order_id 當去重鍵只推一則，後對帳的家庭會被擋掉、完全收不到
  //     （16 個團有 4 個會中招，最久相隔 30.8 天）
  assert.ok(/WHERE e\.enrollment_batch_id = \$1/.test(src), '掃描已失效');
  assert.ok(!/refId: '?er:[^']*group/i.test(src) && !/refId[^\n]*group_order/i.test(src),
    '去重鍵含 group_order_id —— 後對帳的家庭會收不到通知');
  assert.ok(/refId: 'er:' \+ row\.coach_id \+ ':' \+ batchId/.test(src),
    '去重鍵不是 (教練, batch)');
});

check('團報：同班進度只算自己帶的學生', () => {
  const src = stripComments(fs.readFileSync(NOTIFY, 'utf8'));
  const q = src.slice(src.indexOf('group_order_id = $1'));
  assert.ok(q.length > 0, '找不到同班人數查詢');
  assert.ok(/e\.coach_id = \$2/.test(q.slice(0, 300)),
    '同班人數沒有限定同一位教練 —— 同團兩位教練時會把別人的學生端出去（實測 2 例）');
  assert.ok(/e\.status = 'confirmed'/.test(q.slice(0, 300)),
    '同班人數把待對帳的也算進去了');
});

check('同班列：只在團報出現，超出容量時不印分母', () => {
  const solo = JSON.stringify(T({ studentNames: ['甲'], periods: 1, isGroup: false, groupDone: 3, groupCap: 4 })[0]);
  assert.ok(!/同班/.test(solo), '非團報也印了同班進度');

  const grp = JSON.stringify(T({ studentNames: ['甲'], periods: 1, isGroup: true, groupDone: 2, groupCap: 4 })[0]);
  assert.ok(/已報 2 \/ 4 位/.test(grp), '團報沒有印同班進度：' + grp.slice(0, 300));

  // 超出容量（退課後又補人之類）時分母是錯的，寧可不印。
  const over = JSON.stringify(T({ studentNames: ['甲'], periods: 1, isGroup: true, groupDone: 5, groupCap: null })[0]);
  assert.ok(/已報 5 位/.test(over) && !/\/ /.test(over.match(/已報[^"]*/)[0]),
    '容量不明時仍印了分母');

  // groupDone 為 0／undefined 時整列不出現 —— 印「已報 0 位」是廢話。
  const zero = JSON.stringify(T({ studentNames: ['甲'], periods: 1, isGroup: true })[0]);
  assert.ok(!/同班/.test(zero), 'groupDone 未知時仍印了同班列');
});

check('altText：多人截斷、不超過 400 字', () => {
  const one = T({ studentNames: ['王小明'], periods: 1, courseType: '1 對 1' })[0];
  assert.ok(/^王小明 · 報名 1 期/.test(one.altText), '單人 altText 不對：' + one.altText);

  const many = T({ studentNames: ['甲', '乙', '丙', '丁'], periods: 2, courseType: '1 對 4', isGroup: true })[0];
  assert.ok(/甲 等 4 位 · 報名 2 期/.test(many.altText), '多人沒有收斂成「等 N 位」：' + many.altText);
  assert.ok(/團報/.test(many.altText), '團報沒有進 altText');

  // 多人會先被收斂成「甲 等 N 位」，反而變短 —— 用它測截斷等於沒測。
  // 真正會超長的是「單一個很長的名字」，那條路徑不經過收斂。
  const longName = '很長的名字'.repeat(120);
  const huge = T({ studentNames: [longName], periods: 1, courseType: '1 對 1' })[0];
  assert.ok(longName.length > 400, '測試資料本身沒超過 400，這條是空轉的');
  assert.strictEqual(huge.altText.length, 400,
    'altText 沒有截到 400 —— LINE 會直接拒收整則訊息，長度 ' + huge.altText.length);
});

check('輸出不含任何金額數字', () => {
  const m = T({
    studentNames: ['郭芯嘉', '郭芊妘'], periods: 2, courseType: '1 對 2',
    venueName: '三重商工', parentLabel: '龔原瑯', isGroup: true,
  })[0];
  // 色碼會有 6 位十六進位，先剝掉再檢查。
  const txt = JSON.stringify(m.contents).replace(/#[0-9A-Fa-f]{3,8}/g, '');
  assert.ok(!/NT\$|元|金額|發票|匯款|載具|折扣/.test(txt), '輸出含金流字樣');
  // 允許的數字只有：期數、堂數、course type、以及版面用的尺寸。
  assert.ok(!/\b\d{3,}\b/.test(txt.replace(/\d+px/g, '')), '出現三位數以上的數字，疑似金額');
});

check('家長欄：多位收斂成「等 N 位」', () => {
  const { parentLabelOf } = require(path.join(ROOT, 'server/services/enrollmentNotify.js'));
  assert.strictEqual(parentLabelOf(['龔原瑯 (曼甄、謹郁)']), '龔原瑯 (曼甄、謹郁)',
    '單一家長應原樣顯示（括號是本來登記的名字，不可剝除）');
  assert.strictEqual(parentLabelOf(['林欣幼', '林菀婕']), '林欣幼 等 2 位');
  assert.strictEqual(parentLabelOf([]), null);
  assert.strictEqual(parentLabelOf(['', '  ']), null, '全空白應回 null，不可印出空欄');
});

check('事件預設關閉（fail-closed）', () => {
  const gate = stripComments(fs.readFileSync(path.join(ROOT, 'server/services/pushGate.js'), 'utf8'));
  assert.ok(/if \(!isOn\(s\[EVENT_KEY\(event\)\]\)\) return \{ allow: false/.test(gate),
    'pushGate 沒有對未設定的事件 fail-closed');
  // 不可以在任何地方把這個事件預設種成 1 —— 額度用完期間開了只會刷一排 429。
  const seeds = ['server/bootstrap/coreSchema.js'];
  for (const rel of seeds) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/push_event_enrollment_success_coach/.test(src),
      rel + ' 預先種了旗標 —— 應由人工在確認 LINE 額度後才開');
  }
});

if (failures) { console.error('\nenrollment_success_push_test: ' + failures + ' failed'); process.exit(1); }
console.log('enrollment_success_push_test: all passed');
