'use strict';
/**
 * 迴歸鎖：一個班＝一個 course_period，簽到一次算整班。
 *
 * ── 為什麼需要這支 ────────────────────────────────────────────────────────
 * 2026-07-11~07-13 有 23 組兄弟姊妹被開成各自獨立的 course_period（同一批、
 * 同一期、同一位教練、同一個場館，卻是 N 個班）。後果是家長簽到只會蓋到自己
 * 那個 period 的名冊，另一個小孩永遠顯示未簽到。
 *
 * 那三天之後的 178 組全部正確共用 —— 也就是說 bug 早就修好了，但
 * **沒有任何東西在守它**：壞掉的那三天沒有紅燈，修好的那天也沒有紅燈。
 * 中間隔了 40 天，是家長回報才發現的。這支測試補上那盞燈。
 *
 * 使用者 2026-08-21 定調：「以後都是整班共班簽到，不用再額外挪」——
 * 歷史資料不回填，但這條規則必須從此不能被靜默改掉。
 *
 * ── 方法論（沿用 coach_checkin_removed_test.js）────────────────────────────
 *  1. 白名單 + 結構解析，不用黑名單 + 字串搜尋。黑名單只擋得住現在想得到的寫法。
 *  2. 掃描前先剝註解。否則上面這段說明文字本身就會被判成違規。
 *  3. 每一項都附「掃描失效偵測」：解析不到東西要 FAIL，不能安靜地變成恆真。
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

const BACKSLASH = 92;
const BACKTICK = String.fromCharCode(96);

/**
 * 剝掉行註解與區塊註解，但保留字串與樣板字面值裡的內容 —— SQL 全都在樣板字面值裡，
 * 剝壞了下面每一項斷言都會變成假陰性。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (quote) {
      if (c.charCodeAt(0) === BACKSLASH) { out += c + (d || ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }
    if (c === '"' || c === "'" || c === BACKTICK) { quote = c; out += c; i += 1; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2; out += ' '; continue;
    }
    out += c; i += 1;
  }
  return out;
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

check('stripComments 自我驗證', () => {
  assert.strictEqual(squash(stripComments('a // x\nb')), 'a b');
  assert.strictEqual(squash(stripComments('a /* x */ b')), 'a b');
  // 字串／樣板裡長得像註解的內容不能被吃掉，否則 SQL 會被剝壞
  assert.ok(stripComments('const s = "http://x";').includes('http://x'));
  assert.ok(stripComments('const q = ' + BACKTICK + 'a -- b' + BACKTICK + ';').includes('-- b'));
});

// ── 1. 簽到：出席名單來自整班名冊，不是家長送出的清單 ──────────────────────

const CHECKINS = stripComments(read('server/routes/checkins.js'));

check('自助簽到的出席名單＝整班 active 名冊（不含家長限縮）', () => {
  const at = CHECKINS.indexOf('const activeParticipants');
  assert.ok(at > 0, '掃描失效：找不到 activeParticipants 的宣告');
  const block = CHECKINS.slice(at, at + 1200);
  const sql = new RegExp(BACKTICK + '([^' + BACKTICK + ']+)' + BACKTICK).exec(block);
  assert.ok(sql, '掃描失效：activeParticipants 區塊裡解析不到 SQL');
  const q = sql[1];
  assert.ok(/course_period_enrollments/.test(q), '共班名冊必須查 course_period_enrollments');
  assert.ok(/cpe\.course_period_id\s*=\s*\$1/.test(q), '名冊必須以 course_period_id 為範圍');
  assert.ok(/cpe\.status\s*=\s*'active'/.test(q), "名冊必須只取 status='active'");
  // 這是本測試的核心：整班名冊一旦被加上家長限縮，就退回「只簽自己家的」
  assert.ok(!/parent_id\s*=/.test(q), '整班名冊不得以 parent_id 限縮，否則兄弟姊妹會漏簽');
});

/**
 * 每個 checkin_records 寫入點分成三類：
 *   loop  迴圈跑 activeParticipants.rows（自助簽到）
 *   set   INSERT ... SELECT 直接掃整班名冊（櫃檯補登的共班分支）
 *   solo  逐一寫入，不是整班
 * 前兩類都是「一次簽整班」；solo 只允許存在於 flagAllowsPhone 的 else 舊路徑，
 * 因為 SHARED_CHECKIN_USAGE_V2 已是全量開啟（上一項測試在守），solo 實際跑不到。
 * 用分類而不是「全部都要長成某個樣子」，是因為 set 型比迴圈型更好，
 * 硬要求迴圈會把正確的寫法擋下來。
 */
check('checkin_records 的每個寫入點都是整班（solo 只能是 flag 舊路徑）', () => {
  const hits = [];
  const re = /INSERT INTO checkin_records/g;
  let m;
  while ((m = re.exec(CHECKINS))) hits.push(m.index);
  assert.strictEqual(hits.length, 3,
    '掃描失效或新增了寫入點：預期 3 個 INSERT INTO checkin_records，實際 ' + hits.length + ' 個');

  const kinds = hits.map((at) => {
    const before = CHECKINS.slice(Math.max(0, at - 900), at);
    const sql = new RegExp('([^' + BACKTICK + ']+)' + BACKTICK).exec(CHECKINS.slice(at, at + 900));
    const body = sql ? sql[1] : '';
    const loops = before.match(/for\s*\(\s*const\s+\w+\s+of\s+(\w+)\.rows\s*\)/g) || [];
    const lastLoop = loops.length ? /of\s+(\w+)\.rows/.exec(loops[loops.length - 1])[1] : null;
    if (lastLoop === 'activeParticipants') return { at, kind: 'loop', body, before };
    if (/FROM course_period_enrollments/.test(body)
        && /cpe\.status\s*=\s*'active'/.test(body)
        && !/parent_id\s*=/.test(body)) return { at, kind: 'set', body, before };
    return { at, kind: 'solo', body, before };
  });

  const wide = kinds.filter((k) => k.kind !== 'solo');
  assert.ok(wide.length >= 2,
    '至少要有 2 個整班寫入點（自助簽到的迴圈 + 櫃檯補登的 INSERT...SELECT），目前只有 ' + wide.length + ' 個');
  kinds.filter((k) => k.kind === 'solo').forEach((k) => {
    assert.ok(/flagAllowsPhone/.test(k.before),
      '有一個逐人寫入的 checkin_records，且不在 flagAllowsPhone 的舊路徑裡 —— 這會讓兄弟姊妹漏簽');
  });
});

check('SHARED_CHECKIN_USAGE_V2 在 schema 種成「全量開啟」', () => {
  const schema = read('server/bootstrap/coreSchema.js');
  const at = schema.indexOf("'SHARED_CHECKIN_USAGE_V2'");
  assert.ok(at > 0, '掃描失效：coreSchema 找不到 SHARED_CHECKIN_USAGE_V2 的種子');
  const seed = schema.slice(at, at + 200);
  assert.ok(/TRUE/i.test(seed), 'flag 種子必須是 enabled=TRUE');
  // allowed_phones 非空＝變成白名單灰度，整班共班簽到就只對名單內的人生效。
  // 而 getFeatureFlag 查無此列時回 enabled:false，所以種子不見也會靜默退回舊行為。
  assert.ok(/'\{\}'::text\[\]/.test(seed), 'allowed_phones 必須是空陣列（全量），不得改成白名單');
});

// ── 2. 前端：全班一起簽，不給逐一勾選 ──────────────────────────────────────

const MODAL = stripComments(read('client/liff/src/components/SelfCheckinModal.jsx'));

check('SelfCheckinModal 送出的是完整名單', () => {
  assert.ok(/studentIds:\s*students\.map\(/.test(MODAL),
    '送出的 studentIds 必須是 students 全員，不得是被篩選過的子集');
  assert.ok(!/\bselected\b/.test(MODAL), '不得再有 selected 選取狀態');
});

check('學員清單是唯讀的（沒有任何可互動元素）', () => {
  // 注意：檔案裡有兩處 students.map —— 送出 payload 那處在前面。要抓的是 JSX 這處。
  const at = MODAL.indexOf('{students.map(');
  assert.ok(at > 0, '掃描失效：找不到學員清單的 render');
  // 只取這個 map 自己的 JSX（到 ))} 為止）。窗開太大會掃到彈窗底部的
  // 取消／簽到兩顆按鈕，把正常的 onClick 誤判成「清單可點」。
  const end = MODAL.indexOf('))}', at);
  assert.ok(end > at, '掃描失效：找不到學員清單 map 的結尾');
  const region = MODAL.slice(at, end);
  assert.ok(region.length > 40, '掃描失效：學員清單區段短得不合理（' + region.length + ' 字元）');
  ['<input', 'onChange', 'onClick', 'checkbox'].forEach((bad) => {
    assert.ok(!region.includes(bad), '學員清單不得有 ' + bad + '（應為唯讀顯示）');
  });
});

// ── 3. 開通：一個班一個 period，期數要跟著報名單走 ─────────────────────────

const ENROLL = stripComments(read('server/routes/admin/enrollments.js'));

check('course_periods 的每個 INSERT 都要帶 period_number', () => {
  const cols = [];
  const re = /INSERT INTO course_periods\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(ENROLL))) cols.push(m[1]);
  assert.strictEqual(cols.length, 3,
    '掃描失效或新增了寫入點：預期 3 個 INSERT INTO course_periods（團報／兄弟共用／單人），實際 ' + cols.length + ' 個');
  cols.forEach((c, i) => {
    assert.ok(/\bperiod_number\b/.test(c),
      '第 ' + (i + 1) + ' 個 INSERT 沒帶 period_number；欄位是 NOT NULL DEFAULT 1，'
      + '漏帶會把第 2 期以後全部標成第 1 期，並撞上 UNIQUE(enrollment_batch_id, period_number)');
  });
});

check('兄弟同批同期必須共用同一個 course_period', () => {
  assert.ok(/enrollment_batch_id\s*=\s*\$1\s*AND\s+period_number\s*=\s*\$2/.test(ENROLL),
    '找不到以 (enrollment_batch_id, period_number) 取既有 period 的查詢 —— 少了它，兄弟會各開一個班');
  const at = ENROLL.indexOf('let siblingRows');
  assert.ok(at > 0, '掃描失效：找不到共班判定 siblingRows');
  const block = ENROLL.slice(at, at + 2000);
  assert.ok(/max_students/.test(block), '共班判定必須看課型的 max_students（1對1 不共班）');
  assert.ok(/advisory_xact_lock/.test(ENROLL),
    '兄弟訂單會並發對帳，必須有 advisory lock 序列化，否則同一期會被建成兩個 period');
});

if (failed) { console.error('\n' + failed + ' 項未通過'); process.exit(1); }
console.log('\n全部通過');
