'use strict';
/**
 * 迴歸鎖：教練端不得存在任何簽到／扣堂路徑。
 *
 * 背景：2026-08-10 Owner 指示「完整拔掉代簽」。原 POST /api/sessions/:id/checkins
 * 是教練端唯一的寫入入口，只擋 requireCoach（任何有效教練 JWT 即可），成功會寫
 * checkin_records、設 session_deducted、呼叫 syncStoredUsage 真扣堂；共班分支更是
 * 一次呼叫寫入整班。移除前這支 route 沒有任何自動化測試 —— 拔掉不會有紅燈，
 * 被加回來也不會有紅燈。這支測試就是補上那盞燈。
 *
 * 方法論：
 *  1. 白名單 + 全掃描，不用黑名單 + 字串搜尋。黑名單只擋得住現在想得到的寫法。
 *  2. 掃描前先剝註解。否則像上一行那樣的說明文字會被當成違規本身，
 *     形成「文件寫越清楚、測試越容易誤報」的反效果。
 *  3. 每一項都附「掃描失效偵測」（至少要掃到 N 個檔案／至少要解析到 1 個 route），
 *     避免 regex 或剝註解壞掉時測試退化成恆真而靜默放行。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const rel = (full) => path.relative(ROOT, full).split(path.sep).join('/');
const readRaw = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');

// 剝掉 // 與 /* */ 註解，保留字串／樣板字面值（SQL 全都在樣板字面值裡）。
// 不是完整的 JS parser：regex 字面值內含引號時可能誤判，所以每個使用點都配了
// 「掃描失效偵測」斷言來反向確認剝完之後該有的程式碼還在。
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
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; } else { i += 1; }
      continue;
    }
    if (c === '\\') { out += c + (d || ''); i += 2; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code';
    out += c; i += 1;
  }
  return out;
}

const code = (r) => stripComments(readRaw(r));

function walkJs(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walkJs(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log('  ok   ' + label);
  } catch (e) {
    failures += 1;
    console.error('  FAIL ' + label);
    console.error('       ' + e.message);
  }
}

console.log('coach_checkin_removed_test');

// ── 0. 剝註解本身沒壞（其餘四項都建立在它之上）─────────────────────────────
check('stripComments 自我驗證', () => {
  const s = stripComments("const a = 1; // syncStoredUsage\n/* session_deducted = TRUE */\nconst sql = `INSERT INTO checkin_records`;\n");
  assert.ok(!/syncStoredUsage/.test(s), '行註解沒被剝掉');
  assert.ok(!/session_deducted/.test(s), '區塊註解沒被剝掉');
  assert.ok(/INSERT INTO checkin_records/.test(s), '樣板字面值內的 SQL 被誤剝 —— 會造成漏檢');
  assert.ok(/const a = 1;/.test(s), '程式碼被誤剝');
});

// ── 1. 教練 router 的 HTTP 方法白名單：只能有 GET ──────────────────────────
check('server/routes/sessions.js 全部端點皆為 GET', () => {
  const src = code('server/routes/sessions.js');
  const methods = new Set();
  const re = /\brouter\.(get|post|put|patch|delete|options|head|all)\s*\(/g;
  let m;
  while ((m = re.exec(src))) methods.add(m[1]);
  assert.ok(methods.has('get'), '解析不到任何 GET route —— 掃描失效，非真的通過');
  const extra = Array.from(methods).filter((x) => x !== 'get').sort();
  assert.deepStrictEqual(extra, [],
    '教練端出現非 GET 端點：' + extra.join(', ') + '。教練端一律唯讀，不得有寫入路徑。');
});

// ── 2. 寫入 checkin_records 的檔案集合＝固定白名單 ─────────────────────────
check('寫入 checkin_records 的 route 檔＝白名單（家長自助 / 櫃檯補登 / 櫃檯手動扣堂）', () => {
  const ALLOWED = [
    'server/routes/admin/manualDeductions.js',
    'server/routes/admin/sessions.js',
    'server/routes/checkins.js',
  ].sort();
  const found = [];
  for (const full of walkJs(path.join(ROOT, 'server', 'routes'))) {
    if (/INSERT\s+INTO\s+checkin_records/i.test(stripComments(fs.readFileSync(full, 'utf8')))) {
      found.push(rel(full));
    }
  }
  found.sort();
  assert.ok(found.length > 0, '掃不到任何寫入點 —— 掃描失效，非真的通過');
  assert.deepStrictEqual(found, ALLOWED,
    '寫入 checkin_records 的檔案集合改變了。新增寫入點必須先確認它不在教練 token 可達範圍內，\n' +
    '       確認後才更新此白名單。實際：' + found.join(', '));
});

// ── 3. 任何掛 requireCoach 的 route 檔都不得扣堂 ───────────────────────────
check('掛 requireCoach 的 route 檔不得觸及扣堂', () => {
  const BANNED = [
    ['INSERT INTO checkin_records', /INSERT\s+INTO\s+checkin_records/i],
    ['session_deducted = TRUE', /session_deducted\s*=\s*TRUE/i],
    ['syncStoredUsage', /syncStoredUsage/],
  ];
  let scanned = 0;
  let sawRouteDef = false;
  const bad = [];
  for (const full of walkJs(path.join(ROOT, 'server', 'routes'))) {
    const src = stripComments(fs.readFileSync(full, 'utf8'));
    if (!/requireCoach/.test(src)) continue;
    scanned += 1;
    if (/\brouter\.(get|post)\s*\(/.test(src)) sawRouteDef = true;
    for (let k = 0; k < BANNED.length; k += 1) {
      if (BANNED[k][1].test(src)) bad.push(rel(full) + ' → ' + BANNED[k][0]);
    }
  }
  assert.ok(scanned >= 4, '只掃到 ' + scanned + ' 個 requireCoach 檔案 —— 掃描失效，非真的通過');
  assert.ok(sawRouteDef, '剝註解後掃不到任何 route 定義 —— 掃描失效，非真的通過');
  assert.deepStrictEqual(bad, [],
    '教練可達的端點出現扣堂能力：\n       ' + bad.join('\n       '));
});

// ── 4. 前端 api 層不得有 checkin 方法（含 mock fallback）───────────────────
check('sessionsApi 不含 checkin（mock fallback 也不行）', () => {
  const src = code('client/liff/src/api/sessions.js');
  const keys = [];
  const re = /^ {2}([a-zA-Z][a-zA-Z0-9_]*):\s/gm;
  let m;
  while ((m = re.exec(src))) keys.push(m[1]);
  assert.ok(keys.length >= 5, '只解析到 ' + keys.length + ' 個方法 —— 掃描失效，非真的通過');
  assert.ok(keys.indexOf('checkin') === -1, 'sessionsApi.checkin 已復活');
  assert.ok(!/\/checkins/.test(src),
    '仍有指向 /checkins 的呼叫。mock fallback 留著比不留更糟：離線／demo 模式會假裝簽到成功。');
});

// ── 5. 教練頁：無代簽入口，但必須保留歷史來源標籤 ─────────────────────────
check('CoachSessionPage 無代簽入口，且保留歷史來源標籤', () => {
  const raw = readRaw('client/liff/src/pages/CoachSessionPage.jsx');
  const src = stripComments(raw);
  assert.ok(!/sessionsApi\.checkin\b/.test(src), '代簽 API 呼叫已復活');
  assert.ok(!/checkinStudent/.test(src), '代簽 handler 已復活');
  assert.ok(/checkinSourceLabel/.test(src) && /'coach'/.test(src),
    '歷史簽到來源標籤被誤刪：資料庫既有的 coach 來源列會被錯標成「家長簽到」');
});

if (failures) {
  console.error('\ncoach_checkin_removed_test: ' + failures + ' failed');
  process.exit(1);
}
console.log('coach_checkin_removed_test: all passed');
