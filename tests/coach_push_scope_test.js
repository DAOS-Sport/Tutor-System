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

check('推給教練的事件＝白名單（只有家長簽到）', () => {
  const ALLOWED = ['server/services/checkinNotify.js'];
  const found = SERVER_FILES
    .filter((f) => /recipientKind:\s*'coach'/.test(f.code))
    .map((f) => f.file)
    .sort();
  assert.deepStrictEqual(found, ALLOWED.sort(),
    '推給教練的檔案集合改變了。教練端只保留「家長簽到」一種通知 ——\n'
    + '       新增任何教練推播前請先確認 Owner 要，並更新此白名單。\n'
    + '       實際：' + (found.join(', ') || '（無）'));
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

check('教練樣板色票＝品牌白名單（不得出現警示橘黃或紅）', () => {
  const msgs = line.templates.checkinConfirmedToCoach({
    parentName: '範例家長', studentName: '範例學員', courseType: '1 對 2',
    venueName: '範例場館', checkedInAt: '2026-08-06T14:00:00+08:00', source: 'parent',
  });
  const json = JSON.stringify(msgs);
  const used = Array.from(new Set((json.match(/#[0-9a-fA-F]{6}/g) || []).map((c) => c.toLowerCase())));
  assert.ok(used.length >= 4, '只解析到 ' + used.length + ' 個色票 —— 掃描失效，非真的通過');

  const ALLOWED = [
    '#15316a', // 深海藍（logo 底色）
    '#31aeab', // 青碧綠（logo 折線）
    '#97bf36', // 草地綠（logo 折線）
    '#ffffff', // 白
    '#a9c8ff', // 深藍上的次級文字
    '#3a3a3a', '#8a94a6', '#9aa3b0', '#eceff3', // 中性灰階
  ];
  const extra = used.filter((c) => !ALLOWED.includes(c));
  assert.deepStrictEqual(extra, [],
    '出現非品牌色：' + extra.join(', ') + '。'
    + '橘黃與紅是「出事了」的顏色，簽到成功不是出事。');
  assert.ok(!used.includes('#e8a020'), '出現警示橘黃 #e8a020');
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

check('必要欄位都在（家長、組別、時間、來源）', () => {
  const json = JSON.stringify(line.templates.checkinConfirmedToCoach({
    parentName: '範例家長', studentName: '範例學員', courseType: '1 對 2',
    venueName: '範例場館', checkedInAt: '2026-08-06T14:00:00+08:00', source: 'staff',
  }));
  ['範例家長', '1 對 2', '範例學員', '範例場館', '櫃台補登'].forEach((v) => {
    assert.ok(json.includes(v), '樣板少了「' + v + '」');
  });
  assert.ok(json.includes('簽到完成'), '標題不符');
});

if (failures) {
  console.error('\ncoach_push_scope_test: ' + failures + ' failed');
  process.exit(1);
}
console.log('coach_push_scope_test: all passed');
process.exit(0);
