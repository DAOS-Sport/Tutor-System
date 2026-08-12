'use strict';
/**
 * 全站只有一個推播管道（STAFF_CHANNEL / dreams400）。
 *
 * 2026-08-12 移除「各館各自一支 token、各館各自一個 channel」的機制：
 *   - 四個場館 OA 屬於另一個 provider，uid 對不上（2026-08-05 實測 0/60），
 *     設了 token 也一則都送不出去。
 *   - 25 個場館裡只有 4 個設過 token，其餘 21 個每次被查到就噴一行 ERROR
 *     （scripts/lineTokenCheck.js 掃一輪＝21 行），把真問題淹掉。
 *
 * 這支測試有兩個任務，第二個比第一個重要：
 *   (1) 確認移除乾淨 —— 沒有殘留的各館查表、沒有留下會噴錯的路徑。
 *   (2) **確認現在會動的那條推播沒有被移除順手弄斷**。目前唯一開著的事件是
 *       checkin_confirmed_coach（家長簽到 → 通知教練）。它走 dreams400，
 *       而移除後 getToken() 回的正是同一支 token，所以行為應該完全不變。
 *       這一段是回歸防線，不是形式。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routing = require('../server/services/lineRouting');
const line = require('../server/services/line');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}
async function acheck(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
// 順序很重要：先剝「行註解」再剝「區塊註解」。
// 反過來的話，一句 // 註解裡只要出現區塊註解的開頭符號（例如寫路徑時的萬用字元），
// 區塊規則就會從那裡一路吃到下一個結束符號，把中間的程式碼全部當成註解刪掉 ——
// 而「不得包含 X」那類斷言就會因為 X 被吃掉而假性通過。
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}
const LINE_JS = stripComments(SRC('server/services/line.js'));
const ROUTING_JS = stripComments(SRC('server/services/lineRouting.js'));

(async () => {
  // ── (1) 移除乾淨 ─────────────────────────────────────────────
  check('getToken 不再吃場館參數', () => {
    assert.ok(/function getToken\(\)\s*\{/.test(LINE_JS),
      'getToken 仍然帶參數 —— 只要它還吃 venueId，21 個沒 token 的場館就還是會噴錯');
    assert.ok(!/getToken\((?!\))/.test(LINE_JS),
      'still 有帶參數的 getToken 呼叫');
  });

  check('line.js 不再用 VENUE_ENV_ALIAS 做 token 查表', () => {
    assert.ok(!/VENUE_ENV_ALIAS/.test(LINE_JS),
      'line.js 仍在引用場館別名表 —— 各館查表沒清乾淨');
  });

  await acheck('resolveChannel 一律回 STAFF_CHANNEL（教練、有場館的家長、沒場館的家長）', async () => {
    const cases = [
      ['coach', { kind: 'coach' }],
      ['parent+venue', { kind: 'parent', venueId: 'B' }],
      ['parent+no venue', { kind: 'parent' }],
      ['parent+沒有 OA 的場館', { kind: 'parent', venueId: 'E' }],
    ];
    for (const [label, input] of cases) {
      const r = await routing.resolveChannel(input);
      assert.strictEqual(r.channel, routing.STAFF_CHANNEL,
        `${label} 解析到 ${r.channel}，應該是 ${routing.STAFF_CHANNEL}`);
      assert.ok(r.reason, `${label} 少了 reason —— line_push_log 會查不出這則為什麼走這條`);
    }
  });

  check('各館開關（push_venue_channel_*）的程式碼已移除', () => {
    for (const gone of ['push_venue_channel', 'loadVenueFlags', 'VENUE_FLAG', 'selfCheck']) {
      assert.ok(!ROUTING_JS.includes(gone), `lineRouting 仍殘留 ${gone}`);
    }
    for (const gone of ['loadVenueFlags', 'VENUE_FLAG', 'selfCheck']) {
      assert.ok(routing[gone] === undefined, `lineRouting 仍匯出 ${gone} —— 會有人繼續用它`);
    }
  });

  check('缺 STAFF_CHANNEL 的 token 仍然是 error 並且 throw（真故障不可以變安靜）', () => {
    assert.ok(/console\.error\(/.test(LINE_JS),
      '找不到 console.error —— 缺 token 是所有推播都死，必須大聲');
    assert.ok(/throw new Error\('No LINE token for channel: ' \+ STAFF_CHANNEL\)/.test(LINE_JS),
      '缺 token 時必須 throw；回 undefined 會讓呼叫端拿著空 token 去打 LINE API');
    // 診斷內容要留著，否則收到告警的人不知道現在設了什麼、該去哪補。
    for (const needle of ['LINE_MESSAGING_TOKENS', 'LINE_MESSAGING_TOKEN_']) {
      assert.ok(LINE_JS.includes(needle), `缺 token 的診斷少了 ${needle}`);
    }
  });

  check('診斷腳本不再逐一掃場館（那正是 21 行 ERROR 的來源）', () => {
    const chk = stripComments(SRC('server/scripts/lineTokenCheck.js'));
    assert.ok(!/FROM venues|FROM admin_venues/i.test(chk),
      'lineTokenCheck 仍在撈場館清單逐一要 token');
    assert.ok(chk.includes('_getTokenForDiagnostics()'),
      'lineTokenCheck 應該只檢查唯一的那個管道');
    const smoke = stripComments(SRC('server/scripts/pushTemplateSmoke.js'));
    assert.ok(!/\bVENUE\b/.test(smoke), 'pushTemplateSmoke 仍有 --venue 的殘留');
  });

  // ── (2) 現在會動的推播不能斷 ─────────────────────────────────
  check('唯一開著的事件 checkin_confirmed_coach 的接線完好', () => {
    const notify = stripComments(SRC('server/services/checkinNotify.js'));
    assert.ok(notify.includes("'checkin_confirmed_coach'"),
      '事件名稱變了 —— admin_settings 的 push_event_checkin_confirmed_coach 會對不上，推播直接靜音');
    assert.ok(/routing\.resolveChannel\(/.test(notify),
      'checkinNotify 不再走 lineRouting —— 這條是目前唯一在運作的推播路徑');
    assert.ok(/line\.pushMessage\(/.test(notify), 'checkinNotify 不再呼叫 pushMessage');
    assert.ok(typeof line.templates.checkinConfirmedToCoach === 'function',
      '教練簽到通知的樣板不見了');
  });

  check('教練簽到樣板仍然產得出合法的 Flex（移除沒有波及樣板）', () => {
    const msg = line.templates.checkinConfirmedToCoach({
      studentNames: ['測試-學員1', '測試-學員2'],
      courseType: '1 對 2',
      venueName: '新北高中',
      checkedInAt: '2026-08-12T06:00:00+08:00',
      source: 'parent',
    });
    const arr = Array.isArray(msg) ? msg : [msg];
    assert.ok(arr.length >= 1, '樣板沒有回傳訊息');
    assert.strictEqual(arr[0].type, 'flex', '第一則不是 flex');
    assert.ok(arr[0].altText && arr[0].altText.length <= 400,
      'altText 缺失或超過 LINE 的 400 字上限');
    const json = JSON.stringify(arr[0]);
    assert.ok(json.includes('測試-學員1') && json.includes('測試-學員2'),
      '學員名單沒有出現在訊息裡');
    assert.ok(!json.includes('your-domain'), '圖片網址仍是佔位字串，會破圖');
  });

  check('pushMessage 的 token 來源與 checkinNotify 傳進來的 channel 無關（傳什麼都送得出去）', () => {
    // 移除前：pushMessage 用第三個參數去查 token，傳錯就整條死。
    // 移除後：token 固定來自 STAFF_CHANNEL，第三個參數只寫 log。
    // 這條鎖住「不會有人把它接回去查表」。
    assert.ok(/function pushMessage\(lineUserId, messages, venueIdForLog, opts = \{\}\)/.test(LINE_JS),
      'pushMessage 的第三個參數應更名為 venueIdForLog，讓下一個人一眼看出它不決定送到哪');
    assert.ok(/token = getToken\(\);/.test(LINE_JS),
      'pushMessage 仍在用參數查 token');
  });

  check('掃描沒有失效：把 getToken 改回吃參數就要被抓到', () => {
    const mutated = LINE_JS.replace('function getToken() {', 'function getToken(venueId) {');
    assert.ok(!/function getToken\(\)\s*\{/.test(mutated),
      '突變後仍判定為無參數，表示上面那條斷言比對的不是真的那一行');
  });

  console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
  process.exit(failed ? 1 : 0);
})();
