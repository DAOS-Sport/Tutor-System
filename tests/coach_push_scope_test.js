'use strict';
/**
 * 教練端推播的範圍鎖與視覺鎖。
 *
 * Owner 決定：教練只收「家長簽到」一種通知，預約／提醒／取消類一律不推。
 * 理由不是嫌麻煩 —— dreams400 是全場館共用的 channel、每月只有 3,000 則額度，
 * 而且通知一多就沒人看，真正需要當下反應的那則會被淹掉。
 *
 * 這種「只留一種」的決定最容易被下一個人不知情地推翻：加一個 recipientKind:'coach'
 * 只要一行，而且看起來很合理。所以用白名單鎖住整個範圍，不是鎖單一檔案。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rel = (full) => path.relative(ROOT, full).split(path.sep).join('/');

// 掃描前剝註解：否則上面那段說明文字本身會被當成違規（這個坑踩過一次）。
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
      if (c === "'") mode = 'sq';
      else if (c === '"') mode = 'dq';
      else if (c === '`') mode = 'tpl';
      out += c; i += 1; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i += 1; continue; }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2; } else { i += 1; } continue; }
    if (c === '\\') { out += c + (d || ''); i += 2; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code';
    out += c; i += 1;
  }
  return out;
}

function walkJs(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'public' || name === 'uploads') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walkJs(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

console.log('coach_push_scope_test');

const SERVER_FILES = walkJs(path.join(ROOT, 'server'))
  .filter((f) => !rel(f).startsWith('server/scripts/'))   // 維運工具不是產品路徑
  .map((f) => ({ file: rel(f), code: stripComments(fs.readFileSync(f, 'utf8')) }));

check('掃描本身有效（找得到 server 原始碼）', () => {
  assert.ok(SERVER_FILES.length > 30, '只掃到 ' + SERVER_FILES.length + ' 個檔案 —— 掃描失效');
  assert.ok(SERVER_FILES.some((f) => /recipientKind/.test(f.code)), '找不到任何 recipientKind —— 掃描失效');
});

check('推給教練的事件＝白名單', () => {
  // 教練端目前只有這兩種通知，各自都經過 owner 明示同意：
  //   checkinNotify.js     家長簽到       （2026-08-05）
  //   enrollmentNotify.js  報名成功／對帳通過（2026-08-18）
  // 新增任何一種之前都要先問過 —— 教練不是行銷名單，多一種就多一分被關通知的風險。
  const ALLOWED = [
    'server/services/checkinNotify.js',
    'server/services/enrollmentNotify.js',
  ];
  const found = SERVER_FILES
    .filter((f) => /recipientKind:\s*'coach'/.test(f.code))
    .map((f) => f.file)
    .sort();
  assert.deepStrictEqual(found, ALLOWED.sort(),
    '推給教練的檔案集合改變了。\n'
    + '       新增任何教練推播前請先確認 Owner 要，並更新此白名單。\n'
    + '       實際：' + (found.join(', ') || '（無）'));
});

check('每一種教練推播都要有自己的事件開關（不可共用）', () => {
  // 共用開關的話，owner 想只關掉其中一種就辦不到，只能連簽到一起關。
  const events = SERVER_FILES
    .filter((f) => /recipientKind:\s*'coach'/.test(f.code))
    .flatMap((f) => [...f.code.matchAll(/const EVENT(?:_COACH)? = '([^']+)'/g)].map((m) => m[1]));
  assert.ok(events.length >= 2, '只解析到 ' + events.length + ' 個事件代號 —— 掃描失效');
  assert.strictEqual(new Set(events).size, events.length,
    '兩種教練推播共用了同一個事件代號：' + events.join('、'));
});

check('上課提醒不得再推給教練', () => {
  // 只在「真的會組推播訊息」的檔案裡掃。全 repo 掃 role:'coach' 會誤判 ——
  // auth.js / bootstrap/admin.js 的 role:'coach' 講的是帳號角色，跟推播樣板無關。
  // 同一個字面值在不同脈絡是不同意思，靠字串比對分不出來，得先把脈絡限縮好。
  const PUSH_FILES = SERVER_FILES.filter((f) => /line\.templates|pushMessage/.test(f.code));
  assert.ok(PUSH_FILES.length >= 5,
    '只認出 ' + PUSH_FILES.length + ' 個推播相關檔案 —— 掃描失效，非真的通過');
  const offenders = PUSH_FILES
    .filter((f) => /role:\s*'coach'/.test(f.code))
    .map((f) => f.file);
  assert.deepStrictEqual(offenders, [],
    '有推播檔案把 role=\'coach\' 傳進樣板：' + offenders.join(', ')
    + '。上課提醒已改為只推家長。');
});

// ── 視覺鎖 ──
const line = require(path.join(ROOT, 'server/services/line'));

check('教練樣板色票＝白名單（不得出現警示橘黃或紅）', () => {
  const msgs = line.templates.checkinConfirmedToCoach({
    studentNames: ['範例學員'], courseType: '1 對 2',
    venueName: '範例場館', checkedInAt: '2026-08-06T14:00:00+08:00', source: 'parent',
  });
  const json = JSON.stringify(msgs);
  const used = Array.from(new Set((json.match(/#[0-9a-fA-F]{6}/g) || []).map((c) => c.toLowerCase())));
  assert.ok(used.length >= 4, '只解析到 ' + used.length + ' 個色票 —— 掃描失效，非真的通過');

  // 2026-08-11 Owner 給的新色盤。刻意與 BRAND 不同值：家長端樣板吃 BRAND，
  // 改 BRAND 等於連家長端一起換版，那是另一個決定。
  const ALLOWED = [
    '#183260', // 標題底（深藍）
    '#4ade80', // 勾勾與「簽到完成」
    '#8cb83e', // 雙色線前段
    '#179ba2', // 雙色線後段
    '#ffffff', // 標題文字
    '#8c8c8c', '#333333', '#000000', '#aaaaaa', // 標籤／值／強調／頁尾
  ];
  const extra = used.filter((c) => !ALLOWED.includes(c));
  assert.deepStrictEqual(extra, [],
    '出現非白名單色：' + extra.join(', ') + '。'
    + '橘黃與紅是「出事了」的顏色，簽到成功不是出事。');
  for (const banned of ['#e8a020', '#dc2626', '#ef4444', '#e02020']) {
    assert.ok(!used.includes(banned), '出現警示色 ' + banned);
  }
});

check('教練樣板不用 emoji 當標題（跨平台字形不一致）', () => {
  const msgs = line.templates.checkinConfirmedToCoach({
    parentName: '範例家長', courseType: '1 對 2', checkedInAt: '2026-08-06T14:00:00+08:00', source: 'parent',
  });
  const header = JSON.stringify(msgs[0].contents.header);
  // 常見於舊版樣板的裝飾性 emoji
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(header),
    '標題含 emoji —— iOS / Android 的 LINE 內建字形不同，大小與基線都會偏');
});

check('必要欄位都在（學員、組別、場館、來源）', () => {
  const json = JSON.stringify(line.templates.checkinConfirmedToCoach({
    studentNames: ['範例學員'], courseType: '1 對 2',
    venueName: '範例場館', checkedInAt: '2026-08-06T14:00:00+08:00', source: 'staff',
  }));
  ['1 對 2', '範例學員', '範例場館', '櫃台補登'].forEach((v) => {
    assert.ok(json.includes(v), '樣板少了「' + v + '」');
  });
  assert.ok(json.includes('簽到完成'), '標題不符');
});

// ── 2026-08-11 版面：主標＝學員名單，完全不顯示家長 ────────────────────────
check('主標是學員名單，且位置在 header', () => {
  const msg = line.templates.checkinConfirmedToCoach({
    studentNames: ['甲', '乙', '丙'], courseType: '1 對 3',
    venueName: '範例場館', checkedInAt: '2026-08-06T14:00:00+08:00', source: 'parent',
  })[0];
  const header = JSON.stringify(msg.contents.header);
  assert.ok(header.includes('甲、乙、丙'),
    '學員名單不在 header —— 教練當下要一眼看到「誰到了」');
  assert.ok(header.includes('簽到完成'), 'header 少了「簽到完成」');
});

check('輸出不得含任何家長姓名（Owner 決定不顯示家長）', () => {
  // 就算呼叫端誤傳 parentName 也不能洩漏出去。這是把決定鎖住的反迴歸測試 ——
  // 「順手把家長加回去」只要一行，而且看起來很合理。
  const json = JSON.stringify(line.templates.checkinConfirmedToCoach({
    parentName: '不該出現的家長', studentNames: ['甲'], courseType: '1 對 1',
    venueName: '範例場館', checkedInAt: '2026-08-06T14:00:00+08:00', source: 'parent',
  }));
  assert.ok(!json.includes('不該出現的家長'), '傳入的 parentName 被印進樣板了');
  assert.ok(!/家長/.test(json.replace(/家長自助簽到/g, '')),
    '樣板出現「家長」欄位（來源文案「家長自助簽到」除外）');
});

check('icon 是絕對 https 網址，且不是佔位字串', () => {
  const msg = line.templates.checkinConfirmedToCoach({
    studentNames: ['甲'], checkedInAt: '2026-08-06T14:00:00+08:00', source: 'parent',
  })[0];
  const icons = JSON.stringify(msg).match(/"url":"([^"]+)"/g) || [];
  assert.strictEqual(icons.length, 1, '預期剛好一個圖檔網址，實際 ' + icons.length + ' 個');
  const url = icons[0].slice(7, -1);
  assert.ok(/^https:\/\//.test(url), 'icon 不是絕對 https 網址：' + url);
  assert.ok(!/your-domain|example\.com|localhost/.test(url), 'icon 仍是佔位網址：' + url);
  assert.ok(/\/brand\//.test(url),
    'icon 不在 /brand/ 底下 —— 放 liff/ 會被 build-frontends.sh 的 rm -rf 洗掉');
  // dev 網域是短暫的，而圖是 LINE 用戶端讀訊息當下才抓 —— 寫進去幾天後就變破圖
  assert.ok(!/pike\.replit\.dev|\.repl\.co/.test(url),
    'icon 指向 dev 網域，那個 host 是短暫的：' + url);
});

check('圖檔與靜態路由都真的存在（缺任一個就是破圖）', () => {
  const png = path.join(ROOT, 'server/public/brand/check.png');
  assert.ok(fs.existsSync(png), '找不到 ' + rel(png));
  const buf = fs.readFileSync(png);
  assert.ok(buf.slice(1, 4).toString() === 'PNG', '不是有效的 PNG');
  assert.ok(buf.length < 1024 * 1024, 'PNG 超過 LINE 的 1MB 上限');
  const idx = stripComments(fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8'));
  assert.ok(/app\.use\('\/brand',\s*express\.static/.test(idx),
    'server/index.js 沒有掛 /brand 靜態路由 —— 圖檔存在但外面拿不到');
});

check('altText 有上限，長名單不會爆掉通知列', () => {
  const many = Array.from({ length: 12 }, (_, i) => '學員姓名' + i);
  const msg = line.templates.checkinConfirmedToCoach({
    studentNames: many, checkedInAt: '2026-08-06T14:00:00+08:00', source: 'parent',
  })[0];
  assert.ok(msg.altText.length <= 400, 'altText 長度 ' + msg.altText.length + '，超過 LINE 的 400 字上限');
  assert.ok(/等 12 位已簽到/.test(msg.altText),
    '多人時 altText 沒有收斂成「第一位 等 N 位」：' + msg.altText);
  const one = line.templates.checkinConfirmedToCoach({
    studentNames: ['甲'], checkedInAt: '2026-08-06T14:00:00+08:00', source: 'parent',
  })[0];
  assert.strictEqual(one.altText, '甲 已簽到', '單人時 altText 不該加人數');
});

// ── 一堂課一則 ──────────────────────────────────────────────────────────
// 共班簽到與櫃檯手動扣課都是「一次原子寫入整班」。逐列推播的話一堂 1對3 的課
// 教練手機會連響三次，內容幾乎一樣；dreams400 全場館共用、每月只有 3,000 則。
const notify = require(path.join(ROOT, 'server/services/checkinNotify'));
const row = (over) => Object.assign({
  coach_uid: 'U0000000000000000000000000000000',
  checked_in_source: 'parent',
  student_name: '學員',
  parent_name: '家長',
  course_type: 3,
  venue_name: '範例場館',
  checked_in_at: '2026-08-06T06:00:00Z',
  checkin_id: 'ck1',
}, over);

check('整班 N 列彙整成一則，學員全部列出', () => {
  const s = notify.buildCoachSummary([
    row({ student_name: '甲', checked_in_at: '2026-08-06T06:00:02Z' }),
    row({ student_name: '乙', checked_in_at: '2026-08-06T06:00:00Z' }),
    row({ student_name: '丙', checked_in_at: '2026-08-06T06:00:01Z' }),
  ]);
  assert.ok(s, '應產生摘要');
  assert.deepStrictEqual(s.studentNames, ['甲', '乙', '丙'], '學員沒有全部列出');
  // 批次是原子寫入，取最早的才是「這堂課的簽到時間」；取第一列會受查詢排序影響。
  assert.strictEqual(s.checkedInAt, '2026-08-06T06:00:00.000Z', '時間應取最早，且不受輸入順序影響');
});

check('跨家庭共班不硬挑一位家長當代表', () => {
  const s = notify.buildCoachSummary([
    row({ student_name: '甲', parent_name: '王媽' }),
    row({ student_name: '乙', parent_name: '李爸' }),
  ]);
  assert.strictEqual(s.parentLabel, '2 位家長',
    '硬挑第一位家長會讓教練看到一個跟其他學員不相干的名字');
});

check('同一家庭多位學員仍顯示家長姓名', () => {
  const s = notify.buildCoachSummary([
    row({ student_name: '大寶', parent_name: '陳爸' }),
    row({ student_name: '二寶', parent_name: '陳爸' }),
  ]);
  assert.strictEqual(s.parentLabel, '陳爸');
});

check('歷史 coach 來源列不納入（教練不該收到自己當年簽的那筆）', () => {
  const s = notify.buildCoachSummary([
    row({ student_name: '甲', checked_in_source: 'coach' }),
    row({ student_name: '乙', checked_in_source: 'parent' }),
  ]);
  assert.deepStrictEqual(s.studentNames, ['乙'], 'coach 來源列應被排除');
  const none = notify.buildCoachSummary([row({ checked_in_source: 'coach' })]);
  assert.strictEqual(none, null, '整堂都是歷史 coach 列時不該通知');
});

check('沒有教練 uid → 不通知（而不是丟出例外）', () => {
  assert.strictEqual(notify.buildCoachSummary([row({ coach_uid: null })]), null);
  assert.strictEqual(notify.buildCoachSummary([]), null);
  assert.strictEqual(notify.buildCoachSummary(null), null);
});

check('教練推播的 refId 以 session 為單位（去重索引才擋得住重複）', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'server/services/checkinNotify.js'), 'utf8'));
  assert.ok(/refId:\s*'cs:'\s*\+\s*sessionId/.test(src),
    '教練推播的 refId 不是 session 範圍 —— 用 checkin_id 的話一堂共班課會發 N 則');
  // 彙整必須在逐列迴圈之外，否則收斂沒有意義。
  const coachIdx = src.indexOf('buildCoachSummary(rows)');
  const loopIdx = src.indexOf('for (const r of rows)');
  assert.ok(coachIdx > 0 && loopIdx > 0 && coachIdx < loopIdx,
    '教練彙整必須在逐列迴圈之前（之外）');
});

// 2026-08-17 owner 決定（選項 B）：櫃台手動扣課一律不發推播給教練。
// 理由是補扣會押過去的時間，推播取的是 MIN(checked_in_at)＝被回填的時間，
// 教練在 8/17 收到「簽到時間 8/12 14:00」只會更混亂；那堂課本來就會出現在
// 教練端的今日簽到與授課記錄。
//
// 這條測試取代了舊的「只能呼叫一次、不得在 roster 迴圈內」—— 那條是在防
// N×N 次推播，現在整個能力都拿掉了，防的東西升級成「不准長回來」。
check('手動扣課不得發任何簽到推播（2026-08-17 選項 B）', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'server/routes/admin/manualDeductions.js'), 'utf8');
  const src = stripComments(raw);

  // 掃描失效偵測：註解剝除若把整段程式吃掉（此專案踩過：`//` 註解裡有 `/*`），
  // 下面的「找不到就通過」會變成無聲的假綠。先確認真的還在看一支活的路由檔。
  assert.ok(/INSERT INTO manual_lesson_deductions/.test(src),
    '剝除註解後找不到 ledger INSERT —— 掃描已失效，本測試的結論不可信');
  assert.ok(/router\.post\(/.test(src), '剝除註解後找不到 POST 路由 —— 掃描已失效');

  // 白名單式檢查：不是去黑名單某一種寫法，而是確認「這支檔案根本拿不到推播能力」。
  // (1) 不得 require checkinNotify —— 連模組都沒引入，就沒有換個名字繞過去的空間。
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(requires.length > 3, '解析到的 require 只有 ' + requires.length + ' 個 —— 掃描可能失效');
  const notifyReq = requires.filter((r) => /checkinNotify/i.test(r));
  assert.deepStrictEqual(notifyReq, [],
    '不該再 require ' + notifyReq.join('、') + '：手動扣課不發推播');

  // (2) 任何 notifyCheckin* 呼叫都不允許（含改名 import、動態取用）。
  const calls = src.match(/notifyCheckin\w*\s*\(/g) || [];
  assert.deepStrictEqual(calls, [],
    '仍有推播呼叫：' + calls.join('、') + '。若要恢復，須先取得 owner 同意並更新檔頭紀錄');

  // (3) 後台即時廣播必須留著 —— 那是簽到驗證頁刷新用的，不是通知。
  //     一起拿掉的話畫面會停在舊資料，而且沒有人會發現。
  assert.ok(/broadcastAdminEvent\(\s*'checkin:created'/.test(src),
    '後台即時廣播被一起拿掉了：扣課政策只移除推播，不移除 WebSocket 廣播');

  // 突變驗證：把推播塞回去，上面的斷言必須真的擋下來（否則這條是空轉的）。
  const mutated = src.replace(/router\.post\(/, "const { notifyCheckinSafely } = require('../../services/checkinNotify');\nnotifyCheckinSafely(courseSessionId, null);\nrouter.post(");
  const mutatedReqs = [...mutated.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mutatedReqs.some((r) => /checkinNotify/i.test(r)) && /notifyCheckin\w*\s*\(/.test(mutated),
    '突變後仍偵測不到推播 —— 本測試的偵測邏輯無效');
});

check('樣板：整班學員併成一行，人數只出現在 altText', () => {
  const msg = line.templates.checkinConfirmedToCoach({
    studentNames: ['甲', '乙', '丙'],
    courseType: '1 對 3', venueName: '範例場館',
    checkedInAt: '2026-08-06T14:00:00+08:00', source: 'parent',
  })[0];
  assert.ok(JSON.stringify(msg.contents).includes('甲、乙、丙'), '學員沒有併成一行');
  // 新版不再標「（3 位）」—— 名字全列在主標，教練自己數得出來。
  // 人數只保留在 altText（通知列看不到完整名單，需要一個量的提示）。
  assert.ok(!/\d+ 位/.test(JSON.stringify(msg.contents)), '卡片內容仍在標人數');
  assert.ok(/等 3 位/.test(msg.altText), 'altText 沒有帶人數');
});

if (failures) {
  console.error('\ncoach_push_scope_test: ' + failures + ' failed');
  process.exit(1);
}
console.log('coach_push_scope_test: all passed');
process.exit(0);
