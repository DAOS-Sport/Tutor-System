/**
 * F-A06 第 4 期：後端閘門必須讀設定，不能寫死角色。
 *
 * 這個功能的失敗模式很安靜：只要有一支路由還用寫死的角色清單，管理員在
 * F-A06 取消勾選就只會讓選單消失，API 照樣打得進去 —— 而畫面會讓人
 * 以為權限已經關掉了。那比完全沒有權限管理更危險。
 *
 * 所以這裡用遞減式白名單：剩下的 requireAdminRole 必須逐一在名單上，
 * 而且名單上的每一項都必須真的還在（修好卻沒從名單移除一樣會紅）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 每一項都要寫得出「為什麼這裡不能用資源權限」。寫不出來的就不該在名單上。
const ALLOWED = [
  {
    file: 'server/routes/admin/learn.js',
    why: '刪標籤分類：標籤庫這一頁主管看得到，但刪分類會連帶影響既有標籤，限管理員。'
       + '頁面層級的權限表達不了「看得到但不能做」，硬塞會讓主管突然拿到刪除權。',
  },
  {
    file: 'server/routes/admin/ragicZ03.js',
    why: '刪 Z03 紀錄：同上，頁面開給 admin/manager/staff，但刪除限管理員。',
  },
  {
    file: 'server/routes/admin/rolePermissions.js',
    why: '寫入權限設定：只用 requireResource 會開出提權路徑 —— 管理員把這一頁'
       + '勾給主管，主管就能把任何權限發給自己。讀取跟著設定走，能改的只有管理員。',
  },
  {
    file: 'server/routes/admin/ragicStaging.js',
    why: '待審核資料治理不是側邊選單的頁面，沒有對應的資源代號可綁。',
  },
  {
    file: 'server/routes/auth.js',
    why: '家長帳號人工救援：敏感身分操作，不屬於任何後台頁面，且需要最高權限。',
  },
];

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

function filesWithHardcodedGate() {
  const out = [];
  for (const dir of ['server/routes', 'server/routes/admin']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.js')) continue;
      const rel = dir + '/' + f;
      // 先把區塊註解整段拿掉再掃。只排除 // 開頭的行不夠 ——
      // JSDoc 裡提到 requireAdminRole(...) 會被算成一次真正的呼叫，
      // 於是「解釋為什麼這裡不用寫死閘門」的註解本身就讓測試變紅。
      // 拿錯的清單去改，比不改更糟。
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      // 只算真正的呼叫，不算 import 與註解
      const calls = src.split('\n').filter((l) =>
        /requireAdminRole\(/.test(l) && !/^\s*\/\//.test(l));
      if (calls.length) out.push(rel);
    }
  }
  return [...new Set(out)].sort();
}

const actual = filesWithHardcodedGate();
const allowedFiles = ALLOWED.map((a) => a.file).sort();

check('沒有名單外的檔案還在用寫死的角色閘門', () => {
  const extra = actual.filter((f) => !allowedFiles.includes(f));
  assert.deepStrictEqual(extra, [],
    '這些檔案的權限沒有接上 F-A06 設定，取消勾選也擋不住 API：' + extra.join('、'));
});

check('名單沒有過期項目（修好就要移除，否則名單會失去意義）', () => {
  const stale = allowedFiles.filter((f) => !actual.includes(f));
  assert.deepStrictEqual(stale, [],
    '這些已經不再使用寫死閘門，請從 ALLOWED 移除：' + stale.join('、'));
});

check('名單每一項都寫得出理由', () => {
  for (const a of ALLOWED) {
    assert.ok(a.why && a.why.length > 20, `${a.file} 沒有寫清楚理由`);
  }
});

check('requireResource 有被實際使用（避免整批改成 requireAnyBackoffice 而失效）', () => {
  let n = 0;
  const dir = path.join(ROOT, 'server/routes/admin');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    n += (fs.readFileSync(path.join(dir, f), 'utf8').match(/requireResource\(/g) || []).length;
  }
  assert.ok(n >= 60, `只找到 ${n} 處 requireResource，原本有 84 個閘門，數量對不上`);
});

check('requireResource 收到未知代號會在啟動時就炸', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/middlewares/requireResource.js'), 'utf8');
  assert.ok(/if \(!isResourceKey\(resourceKey\)\)/.test(src),
    '打錯的 key 會讓該頁對所有人壞掉，而錯誤訊息只說「沒有權限」，沒人查得到原因');
});

check('查詢權限失敗時一律拒絕，不放行', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/middlewares/requireResource.js'), 'utf8');
  const m = src.match(/catch \(err\)[\s\S]*?\n  \};/);
  assert.ok(m && /return deny\(res\)/.test(m[0]),
    '資料庫抖一下就把整個後台敞開，而那正是最不該放行的時刻');
});

console.log(failures ? `\n${failures} FAILED` : '\nrole_gate_coverage: ALL PASS');
process.exitCode = failures ? 1 : 0;

