/**
 * 前端路由守衛的「後備角色清單」必須涵蓋所有能登入後台的身分。
 *
 * RequireAuth 的判定是兩段式：
 *   allowed === null（權限還沒載到 / 讀不到）→ 退回 roles 陣列
 *   allowed 已載到                            → 依 F-A06 的實際設定
 * 第一段那份 roles 陣列，是 F-A06 之前寫死的「第三份權限清單」。
 *
 * 開放救生員登入時漏掉它的後果很具體：
 *   1. 每次重新整理都先閃一次「沒有權限存取此頁面」，權限 API 回來才恢復
 *   2. PermissionContext 讀不到權限時 setAllowed(null) 且不再重試 ——
 *      API 失敗一次，救生員就被永久鎖在整個後台外面
 * 兩種症狀都不會有錯誤訊息，看起來就只是「系統壞了」。
 *
 * 而且 /sessions /checkin /checkin-modes 三頁都吃同一個常數，
 * 那正好是救生員的主要工作畫面 —— 漏掉不是邊角問題，是整個開放失敗。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const be = require(path.join(ROOT, 'server/constants/roles.js'));

const APP = read('client/admin/src/App.jsx');
const FE_ROLES = read('client/admin/src/constants/roles.js');
const REQ_AUTH = read('client/admin/src/components/RequireAuth.jsx');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

check('本測試的前提仍成立：RequireAuth 在權限未載入時會退回 roles 陣列', () => {
  assert.ok(/allowed === null/.test(REQ_AUTH),
    'RequireAuth 的後備邏輯變了 —— 下面幾條的理由要重新確認，不要直接刪掉這支測試');
  assert.ok(/roles\.includes\(role\)/.test(REQ_AUTH),
    '找不到 roles.includes(role)；後備判定的形狀變了');
});

check('前端 roles.js 匯出 BACKOFFICE_ROLES', () => {
  assert.ok(/export const BACKOFFICE_ROLES\b/.test(FE_ROLES),
    '沒有這個匯出，App.jsx 就只能自己再寫一份清單 —— 那正是漂移的來源');
});

check('App.jsx 的 ALL 是推導出來的，不是手寫陣列', () => {
  const m = APP.match(/^const ALL = (.+);$/m);
  assert.ok(m, '找不到 const ALL = ...');
  assert.ok(!m[1].includes('['),
    'ALL 又被寫成字面陣列了：' + m[1] + ' —— 這就是當初漏掉 lifeguard 的原因');
  assert.ok(/BACKOFFICE_ROLES/.test(m[1]),
    'ALL 應該來自 BACKOFFICE_ROLES，實際是：' + m[1]);
  assert.ok(/import \{[^}]*BACKOFFICE_ROLES[^}]*\} from '\.\/constants\/roles\.js'/.test(APP),
    'App.jsx 沒有 import BACKOFFICE_ROLES（副檔名 .js 不能省，Node 直接載入時會找不到）');
});

check('救生員的三個工作頁用 ALL 當後備，不是排除他的字面陣列', () => {
  // 這三頁是從 server/constants/adminResources.js 的 label 判定的：
  // (F-R03) 簽到驗證 / (F-R01) 上課紀錄查詢 / 簽到模式管理。
  // 實際勾給救生員哪幾頁由管理員在 F-A06 決定，但這三頁若連後備都排除他，
  // 就算勾了也會先閃一次「沒有權限」。
  const bad = [];
  for (const p of ['/sessions', '/checkin', '/checkin-modes']) {
    const line = APP.split('\n').find((l) => l.includes('path="' + p + '"'));
    if (!line) { bad.push(p + ' → 找不到這條路由'); continue; }
    if (!/roles=\{ALL\}/.test(line)) bad.push(p + ' → ' + line.trim().slice(0, 90));
  }
  assert.deepStrictEqual(bad, [], '這幾頁的後備角色清單沒用 ALL：\n       ' + bad.join('\n       '));
});

check('前端推導出的 BACKOFFICE_ROLES 與後端相同', () => {
  // 前端是 ESM，這裡照 role_source_of_truth_test 的做法用解析而非 require。
  const block = FE_ROLES.slice(FE_ROLES.indexOf('export const ROLES'),
    FE_ROLES.indexOf('];', FE_ROLES.indexOf('export const ROLES')));
  const re = /key:\s*'([a-z_]+)'[^}]*?backoffice:\s*(true|false)/g;
  const fe = [];
  let m;
  while ((m = re.exec(block))) if (m[2] === 'true') fe.push(m[1]);
  assert.strictEqual(fe.length > 0, true, '解析不到前端角色 —— 解析壞掉會讓這條假通過');
  assert.deepStrictEqual(fe, [...be.BACKOFFICE_ROLES],
    '前後端對「誰能登入後台」的認定不一致：前端 ' + JSON.stringify(fe)
    + ' / 後端 ' + JSON.stringify([...be.BACKOFFICE_ROLES]));
});

console.log(failures ? '\n' + failures + ' FAILED' : '\nfrontend_backoffice_gate: ALL PASS');
process.exitCode = failures ? 1 : 0;
