/**
 * 每一支後台 API 都必須有權限閘門。
 *
 * 這支測試是一次完整掃描的產物。當時 F-A06 第 4 期「84 個閘門全部換掉」看起來
 * 做完了，實際重掃卻找出 27 支沒有任何角色閘門的路由 —— 因為當初是用
 * 「有 requireAdminRole 的檔案」圈範圍，而 customerParents / customerStudents
 * 這類檔案從來就沒有過，於是整批被漏掉。
 *
 * 漏掉的後果不是報錯，是安靜的：管理員在 F-A06 取消勾選「(Z01) 家長 & 學員關係」，
 * 選單消失、路由擋住，API 照樣打得進去。畫面讓人以為權限關掉了 ——
 * 那比完全沒有權限管理更危險。
 *
 * ── 掃描要認得四種寫法 ──
 * 只比對「router.get('/x', requireResource(...)」這一種會大量誤判：
 *   1. 提升成常數：const PAGE = requireResource('course-types')
 *   2. 多參數檔案層：router.use(requireAdminAuth, requireResource('reports'))
 *   3. 檔案層單獨一行：router.use(requireResource('ragic-z03'))
 *   4. 中介層寫在下一行
 * 第一版掃描器因為漏了 1 與 2，把 pricingZones 和 reports 誤報成沒有閘門。
 * 拿錯的清單去改，比不改更糟。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '../server/routes/admin');

// 允許沒有角色閘門的端點。每一項都要寫得出理由。
const ALLOWED = {
  'auth.js': {
    routes: ['POST /login', 'POST /change-password'],
    why: '登入與換密碼本身就是取得身分的過程，不可能先要求身分。',
  },
  'rolePermissions.js': {
    routes: ['GET /mine'],
    why: '每個後台角色都要讀得到自己的權限，側邊選單靠它渲染；擋住等於所有人都看不到選單。',
  },
};

const GATE = /require(?:Any)?Resource\(|requireAnyBackoffice\(|requireAdminRole\(/;
const HEAD = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'/gm;
const STOP = /async\s*\(|\(req\s*,|wrap\(/;

function bareRoutes(src) {
  // 提升成常數的閘門
  const hoisted = [...src.matchAll(
    /const\s+(\w+)\s*=\s*(?:require(?:Any)?Resource\(|requireAnyBackoffice\(|requireAdminRole\()/g,
  )].map((m) => m[1]);
  // 檔案層 router.use(...)：參數裡含閘門就算，允許多參數
  for (const m of src.matchAll(/router\.use\(([^;]*?)\);/g)) {
    const args = m[1];
    if (GATE.test(args) || hoisted.some((h) => args.includes(h))) return [];
  }
  const out = [];
  for (const m of src.matchAll(HEAD)) {
    const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const stop = tail.search(STOP);
    const seg = stop >= 0 ? tail.slice(0, stop) : tail;
    const ok = GATE.test(seg) || hoisted.some((h) => new RegExp(`\\b${h}\\b`).test(seg));
    if (!ok) out.push(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return out;
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

const found = {};
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.js')) continue;
  const bare = bareRoutes(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (bare.length) found[f] = bare;
}

check('掃描本身有效（至少掃到 20 個路由檔）', () => {
  const n = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).length;
  assert.ok(n >= 20, `只看到 ${n} 個檔案，掃描路徑可能不對 —— 那會讓下面每一條都假通過`);
});

check('沒有名單外的端點缺少權限閘門', () => {
  const extra = [];
  for (const [f, routes] of Object.entries(found)) {
    const allowed = ALLOWED[f] ? ALLOWED[f].routes : [];
    for (const r of routes) if (!allowed.includes(r)) extra.push(`${f} → ${r}`);
  }
  assert.deepStrictEqual(extra, [],
    '這些 API 沒有權限閘門，在 F-A06 取消勾選也擋不住：\n       ' + extra.join('\n       '));
});

check('名單沒有過期項目（補上閘門就要從名單移除）', () => {
  const stale = [];
  for (const [f, spec] of Object.entries(ALLOWED)) {
    for (const r of spec.routes) {
      if (!(found[f] || []).includes(r)) stale.push(`${f} → ${r}`);
    }
  }
  assert.deepStrictEqual(stale, [],
    '這些已經有閘門了，請從 ALLOWED 移除，否則名單會慢慢失去意義：' + stale.join('、'));
});

check('名單每一項都寫得出理由', () => {
  for (const [f, spec] of Object.entries(ALLOWED)) {
    assert.ok(spec.why && spec.why.length > 15, `${f} 沒有寫清楚為什麼可以不設閘門`);
  }
});

console.log(failures ? `\n${failures} FAILED` : '\nadmin_api_gate_coverage: ALL PASS');
process.exitCode = failures ? 1 : 0;

