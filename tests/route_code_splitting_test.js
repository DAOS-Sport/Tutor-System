/**
 * #15 第 3 步：路由層級切分（React.lazy）的護欄。
 *
 *   1. 第一屏與登入流程必須維持同步載入：它們若被改成 lazy，冷開 LIFF 會在
 *      liff.init 之後再多等一個 chunk，正好打在最在意的那段時間上
 *   2. lazy 一律走 lazyPage（不能直接 React.lazy）：否則部署後舊 chunk 不見時
 *      沒有重試／重整，使用者卡在錯誤頁
 *   3. 有 Suspense 後備（App 外層 + 兩個 AppLayout 內容區），不能是一片空白
 *   4. chunkRetry 的行為：只對 chunk 錯誤重試、重整一次就停、記錄不了就不重整
 *
 * chunkRetry.js 刻意不含 JSX、不 import 任何東西，這裡把 export 剝掉直接在 Node 跑，
 * 不需要安裝前端依賴。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' -> ' + e.message); }
}

const ADMIN_APP = read('client/admin/src/App.jsx');
const LIFF_APP = read('client/liff/src/App.jsx');

function eagerPages(src) {
  return [...src.matchAll(/^import (\w+) from '\.\/pages\/\w+';$/gm)].map((m) => m[1]);
}
function lazyPages(src) {
  return [...src.matchAll(/^const (\w+) = lazyPage\(\(\) => import\('\.\/pages\/\w+'\)\);$/gm)].map((m) => m[1]);
}

function loadChunkRetry() {
  const src = read('client/shared/chunkRetry.js').replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn { isChunkLoadError, importWithRetry, reloadOnce, RELOAD_KEY, RELOAD_GUARD_MS };')();
}

function fakeEnv({ now = 1_000_000, storageThrows = false, initial = {} } = {}) {
  const store = { ...initial };
  const env = {
    reloads: 0,
    sleeps: 0,
    storage: {
      getItem: (k) => { if (storageThrows) throw new Error('SecurityError'); return store[k] ?? null; },
      setItem: (k, v) => { if (storageThrows) throw new Error('SecurityError'); store[k] = v; },
    },
    reload: () => { env.reloads++; },
    now: () => now,
    sleep: async () => { env.sleeps++; },
    store,
  };
  return env;
}

const chunkErr = () => new TypeError('Failed to fetch dynamically imported module: https://x/admin/assets/ReconcilePage-OLD.js');
const pending = (p, ms = 30) => Promise.race([p.then(() => 'resolved', () => 'rejected'), new Promise((r) => setTimeout(() => r('pending'), ms))]);

(async () => {
  await check('後台：登入頁與儀表板（登入後第一屏）同步載入', () => {
    const eager = eagerPages(ADMIN_APP);
    for (const p of ['LoginPage', 'DashboardPage']) assert.ok(eager.includes(p), p + ' 應同步 import');
    assert.ok(lazyPages(ADMIN_APP).length >= 30, '後台 lazy 頁數過少：' + lazyPages(ADMIN_APP).length);
  });

  await check('家長端：登入／綁定／註冊／教練登入與兩個第一屏同步載入', () => {
    const eager = eagerPages(LIFF_APP);
    for (const p of ['LoginPage', 'LineBindPage', 'RegisterPage', 'CoachPortalLoginPage', 'HomePage', 'CoachTodayPage']) {
      assert.ok(eager.includes(p), p + ' 應同步 import');
    }
    assert.ok(lazyPages(LIFF_APP).length >= 25, '家長端 lazy 頁數過少：' + lazyPages(LIFF_APP).length);
  });

  await check('lazy 一律走 lazyPage，不直接用 React.lazy', () => {
    for (const [name, src] of [['admin', ADMIN_APP], ['liff', LIFF_APP]]) {
      assert.ok(!/\bReact\.lazy\(|\blazy\(\(\)/.test(src), name + ' App.jsx 直接用了 React.lazy');
      assert.ok(/from '\.\.\/\.\.\/shared\/lazyPage\.jsx'/.test(src), name + ' 沒有 import lazyPage');
      // 每個 lazy 頁面都真的被路由用到（防止只宣告不用、或打錯字）
      for (const p of lazyPages(src)) assert.ok(src.includes('<' + p + ' />') || src.includes('<' + p + '/>'), name + ' 未使用 ' + p);
    }
  });

  await check('Suspense 後備：App 外層與兩個 AppLayout 的內容區', () => {
    for (const rel of ['client/admin/src/App.jsx', 'client/liff/src/App.jsx',
      'client/admin/src/components/AppLayout.jsx', 'client/liff/src/components/AppLayout.jsx']) {
      const src = read(rel);
      assert.ok(/<Suspense fallback=\{<PageLoading \/>\}>/.test(src), rel + ' 缺 Suspense 後備');
    }
    const layout = read('client/admin/src/components/AppLayout.jsx');
    assert.ok(/<Suspense fallback=\{<PageLoading \/>\}>\s*<Outlet \/>\s*<\/Suspense>/.test(layout), 'Outlet 應被 Suspense 包住');
    assert.ok(/載入中/.test(read('client/shared/lazyPage.jsx')), '載入畫面要有看得到的文字');
  });

  await check('ManualEnrollPage 只在 App.jsx 被改成 lazy，本體不動（凍結）', () => {
    assert.ok(lazyPages(ADMIN_APP).includes('ManualEnrollPage'));
    assert.ok(!/lazyPage|Suspense/.test(read('client/admin/src/pages/ManualEnrollPage.jsx')));
  });

  const cr = loadChunkRetry();

  await check('isChunkLoadError 認得各瀏覽器的訊息，不誤認一般錯誤', () => {
    assert.ok(cr.isChunkLoadError(chunkErr()));
    assert.ok(cr.isChunkLoadError(new TypeError('Importing a module script failed.')));
    assert.ok(cr.isChunkLoadError(new TypeError('error loading dynamically imported module')));
    assert.ok(cr.isChunkLoadError(new Error('Unable to preload CSS for /admin/assets/x.css')));
    assert.ok(!cr.isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')")));
    assert.ok(!cr.isChunkLoadError(null));
  });

  await check('第一次就成功：不重試、不重整', async () => {
    const env = fakeEnv();
    const mod = await cr.importWithRetry(async () => ({ default: 'Page' }), env);
    assert.strictEqual(mod.default, 'Page');
    assert.strictEqual(env.sleeps, 0);
    assert.strictEqual(env.reloads, 0);
  });

  await check('瞬斷：重試一次成功，不重整', async () => {
    const env = fakeEnv();
    let n = 0;
    const mod = await cr.importWithRetry(async () => { if (n++ === 0) throw chunkErr(); return { default: 'Page' }; }, env);
    assert.strictEqual(mod.default, 'Page');
    assert.strictEqual(n, 2);
    assert.strictEqual(env.reloads, 0);
  });

  await check('舊 chunk 不見：重試仍失敗 → 重整一次，promise 保持 pending（Suspense 不閃錯誤頁）', async () => {
    const env = fakeEnv();
    const p = cr.importWithRetry(async () => { throw chunkErr(); }, env);
    assert.strictEqual(await pending(p), 'pending');
    assert.strictEqual(env.reloads, 1);
    assert.ok(env.store[cr.RELOAD_KEY], '要記下重整時間');
  });

  await check('一分鐘內剛重整過：不再重整，把錯誤交給錯誤邊界', async () => {
    const env = fakeEnv({ now: 1_000_000, initial: { [cr.RELOAD_KEY]: String(1_000_000 - 10_000) } });
    await assert.rejects(cr.importWithRetry(async () => { throw chunkErr(); }, env), /dynamically imported/);
    assert.strictEqual(env.reloads, 0);
  });

  await check('超過一分鐘：可以再重整一次', async () => {
    const env = fakeEnv({ now: 1_000_000, initial: { [cr.RELOAD_KEY]: String(1_000_000 - cr.RELOAD_GUARD_MS - 1) } });
    const p = cr.importWithRetry(async () => { throw chunkErr(); }, env);
    assert.strictEqual(await pending(p), 'pending');
    assert.strictEqual(env.reloads, 1);
  });

  await check('sessionStorage 不能用：不重整（避免無限迴圈），丟出錯誤', async () => {
    const env = fakeEnv({ storageThrows: true });
    await assert.rejects(cr.importWithRetry(async () => { throw chunkErr(); }, env));
    assert.strictEqual(env.reloads, 0);
  });

  await check('非 chunk 錯誤（頁面模組本身壞掉）：不重試、不重整，直接丟出', async () => {
    const env = fakeEnv();
    let n = 0;
    await assert.rejects(cr.importWithRetry(async () => { n++; throw new ReferenceError('x is not defined'); }, env), /x is not defined/);
    assert.strictEqual(n, 1);
    assert.strictEqual(env.reloads, 0);
  });

  console.log(failures ? `route_code_splitting_test: ${failures} FAILED` : 'route_code_splitting_test: PASS');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
