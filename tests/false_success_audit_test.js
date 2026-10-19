'use strict';
/**
 * #12 假成功／路由不明稽核的迴歸鎖（零外部相依：不連 DB、不出網路）。
 * 盤點與每一筆判定見 docs/false_success_audit_2026-10.md。
 *
 * 這支鎖的是「不可以再長回來」的東西：
 *   1. 未知 /api/* 一律 JSON 404；SPA fallback 不再把 /assets/*、帶副檔名、/admin/api 回成 index.html 200。
 *   2. 路由表：同 method+path 不可註冊兩次，也不可被前面的參數路由遮蔽。
 *   3. server/routes 裡沒有「catch 之後回 2xx 成功」的區塊；吞錯的 `.catch(() => {})`
 *      只允許出現在 ROLLBACK 與已自行記 log 的家庭通知（sendNotices）。
 *   4. 這次修掉的個案（教練登出、團購取消回沖、優惠試算、標籤 404、媒體排序、
 *      系統設定、H01 同步輪詢、前端樂觀更新與讀取失敗）不可退回。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 載入路由模組只會建立 pg Pool 物件，不會真的連線；給一個連不到的位址確保絕不碰到任何庫。
process.env.DATABASE_URL = process.env.DATABASE_URL_UNIT_DUMMY || 'postgresql://unit-no-connect@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

function listen(app) {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function get(srv, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// 把 catch 區塊（try/catch 與 .catch(cb)）切出來。只為了靜態檢查，不追求完整 JS 解析。
function blockFrom(src, i) {
  let d = 0;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return src.slice(i);
}
function catchBlocks(src) {
  const out = [];
  const re = /catch\s*(\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({ line: src.slice(0, m.index).split('\n').length, body: blockFrom(src, m.index + m[0].length - 1) });
  }
  return out;
}
function walkJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

(async () => {
  const express = require(path.join(SERVER, 'node_modules/express'));
  const { apiNotFound, spaFallback, isNonPagePath } = require(path.join(SERVER, 'middlewares/spaFallback'));

  // ── 1. 未知 /api 與 SPA fallback ─────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-'));
  const indexFile = path.join(tmp, 'index.html');
  fs.writeFileSync(indexFile, '<!doctype html><title>spa</title>');
  const app = express();
  app.get('/api/known', (req, res) => res.json({ ok: true }));
  app.use('/api', apiNotFound);
  app.get('/admin/*', spaFallback('/admin', indexFile));
  app.get('/liff/*', spaFallback('/liff', indexFile));
  const srv = await listen(app);
  try {
    await check('未知 GET /api/* → JSON 404 + API_NOT_FOUND（不是 HTML）', async () => {
      const r = await get(srv, '/api/definitely-not-a-route?x=1');
      assert.strictEqual(r.status, 404);
      assert.ok(r.type.includes('application/json'), r.type);
      const b = JSON.parse(r.body);
      assert.strictEqual(b.code, 'API_NOT_FOUND');
      assert.strictEqual(b.path, '/api/definitely-not-a-route');
    });
    await check('未知 POST /api/* 也是 JSON 404', async () => {
      const r = await get(srv, '/api/nope', { method: 'POST' });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(JSON.parse(r.body).code, 'API_NOT_FOUND');
    });
    await check('已知 /api 路由不受兜底影響', async () => {
      const r = await get(srv, '/api/known');
      assert.strictEqual(r.status, 200);
    });
    await check('缺檔的 /admin/assets/*.js → 404，不回 index.html 200', async () => {
      const r = await get(srv, '/admin/assets/index-oldhash.js');
      assert.strictEqual(r.status, 404);
      assert.ok(!r.body.includes('<title>spa</title>'));
    });
    await check('/liff/api/* 誤打 → JSON 404', async () => {
      const r = await get(srv, '/liff/api/courses');
      assert.strictEqual(r.status, 404);
      assert.strictEqual(JSON.parse(r.body).code, 'API_NOT_FOUND');
    });
    await check('真正的 SPA 頁面路徑仍回 index.html 200', async () => {
      for (const p of ['/admin/login', '/admin/enrollments/123', '/liff/group/abc', '/liff/coach/profile']) {
        const r = await get(srv, p);
        assert.strictEqual(r.status, 200, p);
        assert.ok(r.body.includes('<title>spa</title>'), p);
      }
    });
    await check('isNonPagePath 判斷', () => {
      assert.ok(isNonPagePath('/assets/x.css'));
      assert.ok(isNonPagePath('/favicon.ico'));
      assert.ok(isNonPagePath('/api'));
      assert.ok(!isNonPagePath('/'));
      assert.ok(!isNonPagePath('/group/join/AbC_123'));
    });
  } finally {
    srv.close();
  }

  const INDEX = read('server/index.js');
  await check('index.js：/api 兜底掛在所有 /api router 之後、靜態檔與 SPA fallback 之前', () => {
    const fallbackAt = INDEX.indexOf("app.use('/api', apiNotFound)");
    assert.ok(fallbackAt > 0, '缺少 /api JSON 404 兜底');
    const lastApiMount = INDEX.lastIndexOf("app.use('/api/");
    assert.ok(lastApiMount < fallbackAt, '有 /api router 掛在兜底之後，會被 404 吃掉');
    // #39 起大部分 /api router 由 server/routeRegistry.js 的清冊依序掛載，清冊迴圈同樣要在兜底之前。
    const registryAt = INDEX.indexOf("require('./routeRegistry').API_ROUTES");
    assert.ok(registryAt > 0 && registryAt < fallbackAt, '路由清冊沒有掛在 /api 兜底之前');
    // #15 起前端靜態檔改由 createFrontendRouter 掛載（快取／壓縮），兜底仍須在它之前。
    const staticAt = INDEX.indexOf("app.use('/admin', FRONTEND_ROUTERS.admin)");
    assert.ok(staticAt > 0, '找不到前端靜態檔掛載');
    assert.ok(fallbackAt < staticAt);
    assert.ok(/app\.get\('\/admin\/\*', spaFallback\(/.test(INDEX));
    assert.ok(/app\.get\('\/liff\/\*', spaFallback\(/.test(INDEX));
  });
  await check('/health：DB 探測失敗回 503 degraded，不回 status ok', () => {
    assert.ok(/res\.status\(dbOk \? 200 : 503\)/.test(INDEX));
    assert.ok(/status: dbOk \? 'ok' : 'degraded'/.test(INDEX));
  });

  // ── 2. 路由表：重複註冊與遮蔽 ─────────────────────────────────
  const mounts = [...INDEX.matchAll(/app\.use\('(\/api\/[^']+)',\s*require\('\.\/routes\/([^']+)'\)\)/g)]
    .map((m) => [m[1], m[2]])
    // #39：清冊裡的路由也要列入（index.js 只剩一行迴圈）
    .concat(require(path.join(SERVER, 'routeRegistry')).API_ROUTES
      .map(([p, load]) => [p, load.toString().match(/require\('\.\/routes\/([^']+)'\)/)[1]]));
  await check('index.js 的 /api mount 都抓得到（防止正則失效造成假綠）', () => {
    assert.ok(mounts.length >= 20, 'mount 數 ' + mounts.length);
  });
  const table = [];
  const origLog = console.log; const origWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const prefixOf = (layer) => layer.regexp.source
      .replace('^\\', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/').replace(/\$$/, '').replace(/^\^/, '');
    const walk = (stack, prefix) => {
      for (const l of stack) {
        if (l.route) for (const m of Object.keys(l.route.methods)) table.push([m.toUpperCase(), prefix + l.route.path]);
        else if (l.name === 'router' && l.handle.stack) walk(l.handle.stack, prefix + (l.regexp.fast_slash ? '' : prefixOf(l)));
      }
    };
    for (const [p, f] of mounts) walk(require(path.join(SERVER, 'routes', f)).stack, p);
  } finally {
    console.log = origLog; console.warn = origWarn;
  }
  await check('路由表有內容（> 250 條）', () => assert.ok(table.length > 250, String(table.length)));
  await check('沒有同 method+path 重複註冊', () => {
    const seen = new Map();
    const dups = [];
    for (const [m, p] of table) {
      const k = m + ' ' + p;
      if (seen.has(k)) dups.push(k); else seen.set(k, true);
    }
    assert.deepStrictEqual(dups, []);
  });
  await check('沒有路由被前面的參數路由遮蔽（例如 /:id 擋掉後面的 /stats）', () => {
    const toRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*|\*/g, '.*').replace(/:[A-Za-z_]+/g, '[^/]+') + '/?$');
    const hits = [];
    for (let i = 0; i < table.length; i++) {
      for (let j = 0; j < i; j++) {
        const [m, p] = table[i]; const [m2, p2] = table[j];
        if ((m2 === m || m2 === '_ALL') && p2 !== p && toRe(p2).test(p)) hits.push(`${m} ${p} ← ${m2} ${p2}`);
      }
    }
    assert.deepStrictEqual(hits, []);
  });

  // ── 3. server/routes：catch 之後不可回成功 ──────────────────────
  const routeFiles = walkJs(path.join(SERVER, 'routes'));
  await check('catch 區塊裡沒有不帶錯誤狀態碼就回 res.json/send 的成功回應', () => {
    const bad = [];
    for (const f of routeFiles) {
      const src = fs.readFileSync(f, 'utf8');
      for (const { line, body } of catchBlocks(src)) {
        if (!/res\.(json|send)\(/.test(body)) continue;
        if (/res\.status\(|sendError|next\(|fail\(|ragicError\(|respond\(|frontendRedirect\(/.test(body)) continue;
        bad.push(path.relative(ROOT, f) + ':' + line);
      }
    }
    assert.deepStrictEqual(bad, [], '這些 catch 會把失敗回成 200');
  });
  await check('吞錯 .catch(() => {}) 只允許在 ROLLBACK 與 familyNotify.sendNotices', () => {
    const bad = [];
    for (const f of routeFiles) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((ln, i) => {
        if (/\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|null|undefined)\s*\)/.test(ln)
          && !/ROLLBACK|sendNotices/.test(ln)) bad.push(path.relative(ROOT, f) + ':' + (i + 1));
      });
    }
    assert.deepStrictEqual(bad, []);
  });

  // ── 4. 個案 ─────────────────────────────────────────────────
  await check('教練登出：撤銷失敗回 500 LOGOUT_REVOKE_FAILED（實際呼叫路由）', async () => {
    const sessId = require.resolve(path.join(SERVER, 'services/coachPortalSession'));
    require.cache[sessId] = { id: sessId, filename: sessId, loaded: true,
      exports: { readToken: () => 'tok', revoke: async () => { throw new Error('db down'); },
        verify: async () => null, issue: async () => 't', cleanupExpired: async () => {}, TTL_DAYS: 30 } };
    const cpId = require.resolve(path.join(SERVER, 'routes/coachPortal'));
    delete require.cache[cpId];
    const router = require(cpId);
    const layer = router.stack.find((l) => l.route?.path === '/logout' && l.route.methods.post);
    let status = 200; let body;
    const res = { status(c) { status = c; return this; }, json(d) { body = d; return this; } };
    const errLog = console.error; console.error = () => {};
    try { await layer.route.stack.at(-1).handle({ headers: {}, query: {} }, res); }
    finally { console.error = errLog; delete require.cache[sessId]; delete require.cache[cpId]; }
    assert.strictEqual(status, 500);
    assert.strictEqual(body.code, 'LOGOUT_REVOKE_FAILED');
  });

  const GROUP = read('server/routes/groupOrders.js');
  await check('團購取消：revertUsage 與取消同交易，不再 best-effort 吞錯', () => {
    const cancel = GROUP.slice(GROUP.indexOf("router.post('/:id/cancel'"));
    assert.ok(/await promotions\.revertUsage\(\{ groupOrderId: req\.params\.id \}, client\);/.test(cancel));
    assert.ok(!/revertUsage\([^)]*\)\s*\.catch/.test(cancel));
    assert.ok(cancel.indexOf('revertUsage') < cancel.indexOf("client.query('COMMIT')"));
  });
  await check('團購發起／加入：只有 COUPON_* 規則錯誤可降級原價，其他錯誤往外丟', () => {
    const { isPromotionRuleError } = require(path.join(SERVER, 'routes/groupOrders')).__test__;
    assert.strictEqual(isPromotionRuleError({ code: 'COUPON_EXHAUSTED' }), true);
    assert.strictEqual(isPromotionRuleError({ code: 'ECONNRESET' }), false);
    assert.strictEqual(isPromotionRuleError(new Error('x')), false);
    assert.strictEqual((GROUP.match(/if \(!isPromotionRuleError\(e\)\) throw e;/g) || []).length, 2);
  });

  await check('優惠試算：教練係數查詢失敗不可吞成 null（會被誤報成「係數尚未設定」）', () => {
    const src = read('server/routes/promotions.js');
    const fn = src.slice(src.indexOf('async function resolveCoachMultiplier'), src.indexOf("router.get('/'"));
    assert.ok(!/catch/.test(fn), 'resolveCoachMultiplier 又出現 catch');
  });
  await check('標籤 PATCH 找不到 → 404，不回 200 + null', () => {
    const src = read('server/routes/admin/learn.js');
    assert.ok(!/res\.json\(r\.rows\[0\] \|\| null\)/.test(src));
    assert.ok(/TAG_NOT_FOUND/.test(src));
  });
  await check('教練媒體排序：實際更新數對不上 → 409 MEDIA_REORDER_STALE', () => {
    const src = read('server/routes/coaches.js');
    const block = src.slice(src.indexOf("'/:id/media/reorder'"));
    assert.ok(/updated \+= u\.rowCount/.test(block) && /MEDIA_REORDER_STALE/.test(block));
  });
  await check('系統設定：未知 key 400、先驗後寫、同一交易', () => {
    const src = read('server/routes/admin/settings.js');
    assert.ok(!/if \(!ALLOWED_KEYS\.includes\(k\)\) continue;/.test(src));
    assert.ok(/SETTING_KEY_UNKNOWN/.test(src) && /BEGIN/.test(src));
  });
  await check('H01 同步 202 帶 accepted_at；前端輪詢只認這一輪的紀錄', () => {
    assert.ok(/accepted_at: acceptedAt/.test(read('server/routes/admin/staff.js')));
    const page = read('client/admin/src/pages/StaffPage.jsx');
    assert.ok(/started\?\.accepted_at/.test(page) && /isThisRun\(status\)/.test(page));
  });
  await check('重設密碼但 LINE 沒送到 → 警告色，不與完整成功同色', () => {
    const page = read('client/admin/src/pages/StaffPage.jsx');
    assert.ok(/toast\.warning\(`已重設 \$\{r\.staff_name/.test(page));
  });
  await check('教練媒體排序：存失敗退回原順序', () => {
    const page = read('client/liff/src/pages/CoachProfilePage.jsx');
    const fn = page.slice(page.indexOf('async function handleMove'), page.indexOf('async function handleDelete'));
    assert.ok(/catch \(err\) \{[\s\S]*setMedia\(before\)/.test(fn));
  });
  await check('客戶資料清單：讀取失敗要提示，不可只清成空清單（看起來像查無資料）', () => {
    for (const rel of ['client/admin/src/pages/CustomerStudentsPage.jsx', 'client/admin/src/pages/CustomerParentsPage.jsx']) {
      const src = read(rel);
      assert.ok(/空清單不代表查無資料/.test(src), rel);
      assert.ok(!/\.catch\(\(\) => \{ if \(!cancel\) set(Students|Parents)\(\[\]\); \}\)/.test(src), rel);
    }
  });

  await check('對帳成功提示照實講通知信結果，不再一律宣稱「已推播家長」', () => {
    const server = read('server/routes/admin/checkouts.js');
    assert.ok(/const mail = await deliverOutbox\(mailOutboxIds\);/.test(server));
    assert.ok(/notify: \{[\s\S]*not_queued: mailNoEmail[\s\S]*enqueue_failed: mailEnqueueFailed[\s\S]*failed: mail\?\.failed/.test(server));
    const page = read('client/admin/src/pages/ReconcilePage.jsx');
    assert.ok(!/並推播家長|並分別推播/.test(page), '又出現不看結果的「已推播」字樣');
    assert.strictEqual((page.match(/showReconcileNotify\(toast, result, `/g) || []).length, 2);
    // 純函式行為：把 export 那段抽出來在 VM 裡跑（JSX 檔不能直接 require）。
    const start = page.indexOf('export function reconcileNotifyMessage');
    const end = page.indexOf('function showReconcileNotify');
    const fnSrc = page.slice(start, end).replace('export function', 'function');
    const msg = new Function(fnSrc + '; return reconcileNotifyMessage;')();
    assert.strictEqual(msg('對帳通過', { not_queued: 1, sent: 0, failed: 0, dry_run: 0 }).level, 'warning');
    assert.strictEqual(msg('對帳通過', { not_queued: 0, sent: 0, failed: 1, dry_run: 0 }).level, 'warning');
    assert.strictEqual(msg('對帳通過', { not_queued: 0, sent: 0, failed: 0, dry_run: 2 }).level, 'warning');
    // 排信出錯要獨立講，不可講成「沒有 Email」；寄送失敗不可承諾自動重寄（補寄只撿 pending）。
    const enqFail = msg('對帳通過', { not_queued: 0, enqueue_failed: 1, sent: 0, failed: 0, dry_run: 0 });
    assert.strictEqual(enqFail.level, 'warning');
    assert.ok(!/沒有可寄的 Email/.test(enqFail.text), enqFail.text);
    assert.ok(!/重寄/.test(msg('對帳通過', { not_queued: 0, sent: 0, failed: 1, dry_run: 0 }).text));
    const ok = msg('對帳通過', { not_queued: 0, sent: 1, failed: 0, dry_run: 0 });
    assert.strictEqual(ok.level, 'success');
    assert.ok(/已寄出 Email/.test(ok.text));
    assert.ok(!/通知/.test(msg('對帳通過', undefined).text), '沒有 notify（舊後端）時不可宣稱已通知');
  });

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
