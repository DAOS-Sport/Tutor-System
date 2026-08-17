'use strict';
/**
 * 公開 API 的資料暴露面。
 *
 * ── 這次修的是什麼 ──
 * GET /api/coaches 原本完全公開，一次吐出全部在職教練的姓名、任職場館、
 * 資深標記、價格倍率與介紹審核狀態（正式站實測 165 筆）。任何人貼上網址
 * 就能把全公司教練名冊連同計價資訊抓走，還能定時抓來看人員異動。
 *
 * 更早那次修補（publicCoach 白名單）只擋掉電話與 Email，沒有處理
 * 「可以整包枚舉」這件事 —— 欄位變乾淨了，名冊還是整份端出去。
 * 這支測試把兩件事分開鎖：欄位白名單、以及需不需要登入。
 *
 * ── 為什麼是 401 而不是 404 或 200 ──
 * 未授權一律 401，不因為回了一頁好看的 HTML 就改成 200。
 * 監控與前端重試邏輯都靠狀態碼判斷，那個不能為了美觀而動。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// 順序很重要：先剝「行註解」再剝「區塊註解」。
// 反過來的話，一句 // 註解裡只要出現區塊註解的開頭符號（例如寫路徑時的萬用字元），
// 區塊規則就會從那裡一路吃到下一個結束符號，把中間的程式碼全部當成註解刪掉。
// 這支測試第一版就是這樣壞的：斷言全紅，而原始碼其實是好的。
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}
const COACHES = stripComments(read('server/routes/coaches.js'));
const GUAI = stripComments(read('server/middlewares/guaiGuai.js'));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}
async function acheck(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

(async () => {
  // ── 1. 清單需要登入 ────────────────────────────────────────────
  check('GET /coaches 掛了登入守門', () => {
    assert.ok(/router\.get\('\/', requireParentOrCoach,/.test(COACHES),
      '教練清單又變回公開了 —— 那等於把全公司教練名冊與計價資訊端出去');
  });

  check('守門只認 parent / coach，不從這裡開 admin 後門', () => {
    const fn = COACHES.slice(COACHES.indexOf('function requireParentOrCoach'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(/payload\.type !== 'parent' && payload\.type !== 'coach'/.test(body),
      '身分判斷不是白名單 —— 應明確只放行 parent 與 coach');
    assert.ok(!/admin/i.test(body),
      'admin 應走 /api/admin/* 那一整套（有場館範圍與稽核），不從這裡走捷徑');
    assert.ok(/jwt\.verify\(/.test(body), '沒有驗簽，只看 type 等於沒驗');
  });

  check('單筆 /coaches/:id 維持公開（推薦連結在未登入時要用）', () => {
    assert.ok(/router\.get\('\/:id', async/.test(COACHES),
      '單筆端點被一起關掉了 —— RegisterPage 的推薦連結流程會壞。'
      + '它要 UUID 才查得到，不能枚舉，暴露面與清單完全不同');
  });

  // ── 2. 欄位白名單（更早那次修補，不可回退）──────────────────
  check('每一支 /coaches 端點都要有守門（白名單式，不是逐條列舉）', () => {
    // 2026-08-17：GET /:id/media 原本完全沒有 middleware，正式站實測未登入回 200。
    // 8/11 鎖 /coaches 時漏掉它。改成掃「所有路由」，新增端點忘了掛守門也會被抓到。
    // head 抓「整行」而不是抓到第一個右括號 —— requireCoachOwner('id') 自己就有括號，
    // 用 [^)]* 會在它中間截斷，然後這條斷言會永遠是假紅。
    const routes = [...COACHES.matchAll(/^router\.(get|post|patch|put|delete)\('([^']+)'([^\n]*)/gm)]
      .map((m) => ({ verb: m[1], path: m[2], head: m[3] }));
    assert.ok(routes.length >= 10, '只解析到 ' + routes.length + ' 條路由 —— 掃描已失效');

    // 可以不需要登入的，只有這五條，每條都逐一查證過：
    //   /login /login/line   登入本身
    //   /by-phone            以手機查教練（登入前的查詢）—— byPhoneRateLimit 擋暴力枚舉
    //   /by-line-uid         以 LINE uid 查教練 —— byLineUidRateLimit ＋ id_token 只收 header
    //   /:id                 推薦連結在未登入時要用，且回傳已過 publicCoach 白名單
    // 其餘一律要 requireCoach。新增端點忘了掛守門，這條就會紅。
    const OPEN = new Set(['/login', '/login/line', '/:id', '/by-phone', '/by-line-uid']);
    const naked = routes.filter((r) => !OPEN.has(r.path)
      && !/requireCoach|requireParentOrCoach|requireAdmin/.test(r.head));
    assert.deepStrictEqual(naked.map((r) => r.verb.toUpperCase() + ' ' + r.path), [],
      '這些端點沒有任何守門 —— 未登入就打得到');

    // /:id/media 現在必須是「須登入且本人」：主管審核走 admin/learn.js，
    // 家長端從頭到尾沒有拿過 media，沒有第三種消費者。
    // 免登入的兩支查詢端點必須真的掛著 rate limit，否則等於開放枚舉。
    for (const [pathname, mw] of [['/by-phone', 'byPhoneRateLimit'], ['/by-line-uid', 'byLineUidRateLimit']]) {
      const r = routes.find((x) => x.verb === 'get' && x.path === pathname);
      assert.ok(r, '找不到 GET ' + pathname);
      assert.ok(r.head.includes(mw), 'GET ' + pathname + ' 沒有 ' + mw + ' —— 免登入又沒限流＝可枚舉全公司教練');
    }

    const media = routes.find((r) => r.verb === 'get' && r.path === '/:id/media');
    assert.ok(media, '找不到 GET /:id/media');
    assert.ok(/requireCoach/.test(media.head) && /requireCoachOwner\('id'\)/.test(media.head),
      'GET /:id/media 沒有 requireCoach + requireCoachOwner —— 任何人帶 coach id 就拿得到照片網址');
  });

  check('publicCoach 仍是白名單，且不含任何聯絡方式', () => {
    assert.ok(/const PUBLIC_COACH_FIELDS = \[/.test(COACHES), '白名單常數不見了');
    const list = COACHES.slice(COACHES.indexOf('const PUBLIC_COACH_FIELDS = ['));
    const arr = list.slice(0, list.indexOf(']'));
    for (const leaked of ['phone', 'email', 'line_uid', 'id_number', 'intro_review_note', 'ragic']) {
      assert.ok(!arr.includes(leaked), `白名單裡出現了 ${leaked}`);
    }
    assert.ok(/for \(const k of PUBLIC_COACH_FIELDS\)/.test(COACHES),
      'publicCoach 應逐一挑白名單欄位，不是刪黑名單 —— '
      + '刪黑名單的話，資料表加新欄位就會自動外洩');
  });

  // ── 3. 乖乖頁：好看但不能改變語意 ──────────────────────────────
  await acheck('未授權一律 401；瀏覽器拿 HTML，程式拿 JSON', async () => {
    // 用 node:http 起一個最小伺服器，不依賴 express ——
    // 測試從 repo 根目錄跑，express 裝在 server/node_modules 底下。
    const http = require('http');
    const guai = require('../server/middlewares/guaiGuai');
    const srv = http.createServer((req, res) => {
      // deny() 只用到 get / status / type / send / json 這幾個，補成 express 的形狀即可。
      res.get = () => undefined;
      const shim = {
        status(c) { res.statusCode = c; return shim; },
        type(t) { res.setHeader('content-type', t === 'html' ? 'text/html; charset=utf-8' : t); return shim; },
        send(b) { res.end(b); return shim; },
        json(o) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return shim; },
      };
      guai.deny({ get: (h) => req.headers[String(h).toLowerCase()] }, shim, '需要登入');
    });
    srv.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const port = srv.address().port;
    try {
      const hit = async (accept) => {
        const r = await fetch(`http://127.0.0.1:${port}/t`, accept ? { headers: { Accept: accept } } : undefined);
        return { status: r.status, ct: r.headers.get('content-type') || '', body: await r.text() };
      };
      const browser = await hit('text/html,application/xhtml+xml');
      assert.strictEqual(browser.status, 401, '瀏覽器版不是 401 —— 好看不能改變語意');
      assert.ok(browser.ct.includes('text/html'), '瀏覽器版不是 HTML');
      assert.ok(browser.body.includes('乖 乖'), '乖乖不見了');
      assert.ok(browser.body.includes('noindex'), '這頁不該被搜尋引擎收錄');

      for (const accept of ['*/*', 'application/json', null]) {
        const api = await hit(accept);
        assert.strictEqual(api.status, 401, `Accept=${accept} 不是 401`);
        assert.ok(api.ct.includes('application/json'),
          `Accept=${accept} 回了 ${api.ct} —— 只有明確要 text/html 才給 HTML，`
          + '把 */* 當成瀏覽器會讓所有 API 客戶端收到一頁 HTML');
        assert.ok(JSON.parse(api.body).code === 'UNAUTHORIZED', 'JSON 版缺 code');
      }
    } finally {
      srv.close();
    }
  });

  check('乖乖頁不洩漏任何內部資訊', () => {
    for (const leaked of ['stack', 'process.env', 'DATABASE_URL', 'jwt', 'secret']) {
      assert.ok(!new RegExp(leaked, 'i').test(GUAI.replace(/guaiGuai|GUAI_GUAI/g, '')),
        `乖乖頁的程式碼裡出現 ${leaked} —— 錯誤頁不該碰這些`);
    }
  });

  check('HTML 有做跳脫（訊息是可變的，將來可能帶進使用者輸入）', () => {
    assert.ok(/replace\(\/\[&<>"\]\/g/.test(GUAI),
      '沒有 escape。現在的訊息都是寫死的，但這種函式最容易在日後被接上動態內容');
  });

  check('掃描沒有失效：把守門拿掉就要被抓到', () => {
    assert.ok(/router\.get\('\/', requireParentOrCoach,/.test(COACHES), '基準比對不到');
    const mutated = COACHES.replace("router.get('/', requireParentOrCoach,", "router.get('/',");
    assert.ok(!/router\.get\('\/', requireParentOrCoach,/.test(mutated),
      '突變後仍找得到，表示比對的不是真的那一段');
  });

  console.log(failed ? '\n' + failed + ' 項失敗' : '\n全部通過');
  process.exit(failed ? 1 : 0);
})();
