/**
 * piiMask 必須以 code point 切字 —— emoji 開頭/結尾的名字不可以產生孤立代理
 *
 * 由來（2026-09-07）：正式站 outbox 兩筆 CREATE_Z01_PARENT 卡 processing 45 天、attempts 56/45。
 * 實跑一筆抓到 stack：_markFailure → createParentIdentityBackofficeTask → `$2::jsonb`
 *   22P02 invalid input syntax for type json: Unicode low surrogate must follow a high surrogate
 *   where: {"name":"\ud83cX...
 * maskName 用 s[0] 取「第一個字」，把 emoji 代理對切成半個。JSON.stringify 不會擋，Postgres 會。
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { maskName, maskPhone, maskStudentName } = require(path.join(__dirname, '..', 'server/utils/piiMask.js'));

// 孤立代理：高代理後面沒接低代理，或低代理前面沒有高代理
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

check('一般中文姓名行為完全不變（王小明 → 王X明、王明 → 王X、單字原樣）', () => {
  assert.strictEqual(maskName('王小明'), '王X明');
  assert.strictEqual(maskName('歐陽小明'), '歐XX明');
  assert.strictEqual(maskName('王明'), '王X');
  assert.strictEqual(maskName('王'), '王');
  assert.strictEqual(maskName(''), '');
  assert.strictEqual(maskName(null), '');
});

check('emoji 開頭：保留整顆 emoji，不產生孤立代理（正式站那筆的情境）', () => {
  const m = maskName('🎏小明');
  assert.ok(m.startsWith('🎏'), '第一個字應該是完整的 🎏，實際：' + JSON.stringify(m));
  assert.ok(!LONE.test(m), '仍有孤立代理：' + JSON.stringify(m));
  assert.strictEqual(m, '🎏X明');
});

check('emoji 結尾與中間也安全', () => {
  for (const n of ['小明🎏', '🎏🎏', '王🎏明', '👨‍👩‍👧小明']) {
    const m = maskName(n);
    assert.ok(!LONE.test(m), n + ' → 孤立代理：' + JSON.stringify(m));
  }
});

check('遮罩後的值可以被 JSON round-trip（Postgres ::jsonb 的最低門檻）', () => {
  for (const n of ['🎏小明', '小明🎏', '🎏', '🎏🎏🎏', '王小明']) {
    const s = JSON.stringify({ name: maskName(n) });
    assert.ok(!LONE.test(s), 'JSON 文字含孤立代理：' + s);
    const back = JSON.parse(s);
    assert.strictEqual(typeof back.name, 'string');
  }
});

check('maskStudentName 同樣不切半（若有匯出）', () => {
  if (typeof maskStudentName !== 'function') return;
  for (const n of ['🎏小明', '小明🎏']) assert.ok(!LONE.test(maskStudentName(n)), n + ' 孤立代理');
});

check('maskPhone 不受影響', () => {
  assert.strictEqual(maskPhone('0912345678'), '0912****78');
});

check('實作真的改成以 code point 切（不是靠碰巧）', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'server/utils/piiMask.js'), 'utf8');
  const i = src.indexOf('function maskName'); const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(/Array\.from|cps\(/.test(body), 'maskName 沒有用 code point 切字');
  assert.ok(!/\bs\[0\]|s\[s\.length - 1\]/.test(body), 'maskName 還在用 s[0] / s[s.length-1]（會切半 emoji）');
});

console.log(failures ? '\n' + failures + ' FAILED' : '\npii_mask_unicode: ALL PASS');
process.exitCode = failures ? 1 : 0;
