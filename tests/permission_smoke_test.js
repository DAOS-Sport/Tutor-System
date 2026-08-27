#!/usr/bin/env node
'use strict';
/**
 * F-A06 角色權限：端到端 smoke test
 *
 * 既有的 65 支測試全是靜態掃描與純函式單元測試 —— 它們證明「程式碼長得對」，
 * 但沒有任何一支證明「整條路走得通」：真的開伺服器、真的登入、真的帶著 JWT
 * 打受保護的 API、真的吃到 403。這支補的就是那一段。
 *
 * ── 這支在防哪些事 ──────────────────────────────────────────────────
 *  1. 救生員登入後被靜默降級成「行政櫃檯」。auth.js 曾經是「不是 admin 也不是
 *     manager 就一律 staff」，開放救生員登入後，52 位救生員會直接拿到客戶資料、
 *     對帳、退款的全部權限，而畫面上完全看不出來。
 *  2. 「藏起來但打得進去」—— 選單不顯示，但用開發者工具直接打 API 照樣拿得到
 *     資料。所以這裡不看畫面，只看 HTTP 狀態碼。
 *  3. /role-permissions/mine 自說自話。API 回什麼就信什麼等於沒驗，所以這裡
 *     用兩份獨立重算的答案跟它對：一份呼叫後端 service，一份直接用 SQL 重寫
 *     一遍判定邏輯。三份必須完全一致。
 *  4. 一人身兼數職時權限只取「代表角色」而不是聯集 —— 症狀是把某頁開給救生員
 *     之後，櫃檯兼救生員的人還是看不到，而沒有人會把它回報成 bug。
 *  5. 個人 override 收不回來 —— 角色有開就壓過個人設定，等於「這個人不該碰
 *     退款」永遠做不到。
 *
 * ── 為什麼不直接跑 server/index.js ──────────────────────────────────
 * index.js 會一併啟動 cron 排程、WebSocket、schema bootstrap 與 demo seed，
 * 全部落在共用的 dev 資料庫上。這支測試只驗權限，不需要那些副作用。
 * 這裡沿用 tests/e2e/_server.js 既有的做法：真實 route 檔 + 真實 middleware
 * + 真實 DB，只把 index.js 第 85 行那個掛載原封不動搬過來
 * （app.use('/api/admin', require('./routes/admin'))），其餘一概不啟。
 * 所以 HTTP → 路由 → requireAdminAuth → requireResource → rolePermissions
 * → Postgres 這條鏈是完整的真貨。
 *
 * ── 伺服器身分驗證（假綠燈防線）──────────────────────────────────────
 * 「測試全綠但根本沒驗到東西」最常見的成因是打到了上一輪沒關掉的舊伺服器。
 * pkill -f "PORT=3001" 這種比對抓不到任何東西（環境變數不在 argv 裡），舊的
 * process 會一直活著。這裡改成三重確認，任何一項不符就直接中止：
 *   (a) 子行程由本測試自己 spawn，PID 直接拿得到，不靠字串比對
 *   (b) 啟動前確認該 port 沒有 listener；子行程 EADDRINUSE 一律當硬失敗，
 *       絕不「反正有人回應就繼續」
 *   (c) 每輪產生一個隨機 nonce 傳給子行程，測試第一件事就是打 /__smoke/ping，
 *       回來的 nonce 與 pid 必須完全等於本輪的值
 *
 * ── 為什麼登入要換來源 IP ────────────────────────────────────────────
 * auth.js 有 per-IP 登入限流（5 次 / 5 分鐘）。本測試要證明四個角色都能登入，
 * 加上複數身分與教練共 7 次，一定會撞到第 6 次。這裡不去關掉限流（那會讓限流
 * 本身失去驗證），而是讓每次登入從不同的 127.0.0.x 送出 —— 限流仍然是開著的，
 * 只是每個帳號各自算自己的額度。過程中若真的收到 429，測試會直接判失敗，
 * 因為那代表後面的結果都不可信。
 *
 * ── 測試資料 ────────────────────────────────────────────────────────
 * 全部自建自刪，一律 smoke_ 前綴，一眼看得出是測試帳號。清理放在 finally，
 * 中途失敗也會刪掉。絕不碰既有的 role_permissions 設定 —— 那是共用組態，
 * 測試只讀它、依它現況挑資源，不改它。
 *
 * 用法：node scripts/tests/permission_smoke_test.js
 */

const assert = require('assert');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');

// ── 子行程模式：最小但真實的伺服器 ──────────────────────────────────────
// 同一個檔案身兼測試與伺服器，是為了讓「我啟動的到底是哪個 process」沒有
// 任何模糊空間 —— spawn 回來的 PID 就是答案。
function runHarness() {
  const express = require(path.join(SERVER, 'node_modules', 'express'));
  const nonce = process.env.SMOKE_CHILD_NONCE;
  const app = express();

  // 與 server/index.js 相同的 body 解析設定。
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 身分證明端點：不掛任何 auth，讓測試能在做任何斷言前先確認
  // 「回應我的這台，就是我剛剛啟動的那台」。
  app.get('/__smoke/ping', (_req, res) => res.json({ nonce, pid: process.pid }));

  // 真正的後台路由樹（server/index.js:85 的原樣搬移）。
  app.use('/api/admin', require(path.join(SERVER, 'routes', 'admin')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
  });

  const port = Number(process.env.PORT);
  const srv = app.listen(port, '127.0.0.1', () => {
    console.log('SMOKE_READY ' + JSON.stringify({ pid: process.pid, port: srv.address().port, nonce }));
  });
  // port 被佔用時必須硬失敗。這裡若默默放過，測試就會轉頭去打那台舊的伺服器。
  srv.on('error', (e) => {
    console.error('SMOKE_LISTEN_ERROR ' + e.code + ' ' + e.message);
    process.exit(9);
  });
}

// ── 計分 ────────────────────────────────────────────────────────────────
let failures = 0;
let passes = 0;
function check(label, fn) {
  try { fn(); passes++; console.log('  ok   ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + '\n         → ' + e.message); }
}
function section(title) { console.log('\n' + title); }
function note(msg) { console.log('       · ' + msg); }

// ── HTTP ────────────────────────────────────────────────────────────────
function request(port, method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
    const o = { host: '127.0.0.1', port, method, path: urlPath, headers: {} };
    if (opts.sourceIp) o.localAddress = opts.sourceIp;
    if (opts.token) o.headers.Authorization = 'Bearer ' + opts.token;
    if (data) { o.headers['Content-Type'] = 'application/json'; o.headers['Content-Length'] = data.length; }
    const r = http.request(o, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 非 JSON 回應，保留 raw */ }
        resolve({ status: res.statusCode, body: json, raw: buf });
      });
    });
    r.setTimeout(30000, () => r.destroy(new Error(`request timeout: ${method} ${urlPath}`)));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 取一個目前沒有 listener 的 port（先問 OS 要一個 ephemeral，再用 lsof 複查）。 */
async function pickFreePort() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    if (pidsOnPort(port).length === 0) return port;
  }
  throw new Error('找不到閒置的 port');
}

/** 目前佔用某 port 的 PID 清單。lsof 沒有相符時 exit code 為 1，視為空。 */
function pidsOnPort(port) {
  try {
    const out = execFileSync('lsof', ['-ti:' + port], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
  } catch { return []; }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
async function main() {
  const { pool } = require(path.join(SERVER, 'models', 'db'));
  const svc = require(path.join(SERVER, 'services', 'rolePermissions'));
  const { RESOURCE_KEYS } = require(path.join(SERVER, 'constants', 'adminResources'));
  const { verifyToken } = require(path.join(SERVER, 'middlewares', 'adminAuth'));

  const RUN = Date.now().toString(36);
  const P = (suffix) => `smoke_${suffix}_${RUN}`;         // admin_staff.id
  const U = (staffId) => `U_${staffId}`;                  // admin_users.id（auth.js 自動建立的規則）

  // 受 requireResource 保護、且唯讀無副作用的 GET 端點。
  // 只列「不需要路徑參數」的，才能對任何角色重複打而不依賴既有資料。
  const ENDPOINTS = {
    'role-permissions':    '/api/admin/role-permissions',
    'staff':               '/api/admin/staff',
    'settings':            '/api/admin/settings',
    'ragic-status':        '/api/admin/ragic-status',
    'course-types':        '/api/admin/course-types',
    'customer-parents':    '/api/admin/customer-parents',
    'customer-students':   '/api/admin/customer-students',
    'sessions':            '/api/admin/sessions',
    'dashboard':           '/api/admin/sessions/today',
    'revive':              '/api/admin/sessions/cancelled',
    'checkin':             '/api/admin/checkins',
    'checkin-modes':       '/api/admin/periods/checkin-modes',
    'manual-deduction':    '/api/admin/manual-deductions',
    'chat-logs':           '/api/admin/chat/rooms',
    'keywords':            '/api/admin/chat/keywords',
    'alerts':              '/api/admin/chat/alerts',
    'transfers':           '/api/admin/transfers',
    'tags':                '/api/admin/learn/tags',
    'coach-eval':          '/api/admin/learn/coach-eval',
    'eval-threshold':      '/api/admin/learn/thresholds',
    'coach-intros-review': '/api/admin/learn/intros',
    'promotions':          '/api/admin/promotions',
    'promotions-active':   '/api/admin/promotions/active',
  };

  // 每個帳號一個來源 IP，各自吃各自的登入限流額度（見檔頭說明）。
  const ACCOUNTS = [
    { key: 'admin',     staff: P('adm'),  name: 'smoke 系統管理員', role: 'admin',     flags: {},                                 ip: '127.0.0.11', expectRole: 'admin' },
    { key: 'manager',   staff: P('mgr'),  name: 'smoke 場館主管',   role: 'manager',   flags: {},                                 ip: '127.0.0.12', expectRole: 'manager' },
    { key: 'staff',     staff: P('stf'),  name: 'smoke 行政櫃檯',   role: 'staff',     flags: { is_counter: true },               ip: '127.0.0.13', expectRole: 'staff' },
    { key: 'lifeguard', staff: P('lif'),  name: 'smoke 救生員',     role: 'lifeguard', flags: { is_lifeguard: true },             ip: '127.0.0.14', expectRole: 'lifeguard' },
    { key: 'dual',      staff: P('dual'), name: 'smoke 櫃檯兼救生', role: 'staff',     flags: { is_counter: true, is_lifeguard: true }, ip: '127.0.0.15', expectRole: 'staff' },
    { key: 'mix',       staff: P('mix'),  name: 'smoke 櫃檯兼主管', role: 'staff',     flags: { is_counter: true },               ip: '127.0.0.16', expectRole: 'manager', manualRoles: ['manager'] },
    // ↑ 這個人的 admin_staff.role 是 'staff'（Ragic 認定的櫃檯），主管身分是
    //   管理員在 F-A02 手動勾的，只存在 admin_staff_roles。
    //   期望值原本是 'staff' —— 那是舊行為：登入裁決根本沒讀那張表，
    //   手動指派的身分對登入完全無效。修好之後
    //   highestRole(['staff','manager']) = 'manager'，這才是正確的代表值。
    { key: 'coach',     staff: P('coa'),  name: 'smoke 純教練',     role: 'coach',     flags: { is_coach: true },                 ip: '127.0.0.17', expectRole: null },
  ];
  const PHONE = {};
  ACCOUNTS.forEach((a, i) => { PHONE[a.key] = '09' + String(90000000 + i); });

  const staffIds = ACCOUNTS.map((a) => a.staff);
  const userIds = staffIds.map(U);

  let child = null;
  let port = null;

  try {
    // ── 0. 種資料（在啟動伺服器之前，避免任何快取時序問題）─────────────
    section('[0] 建立 smoke_ 測試帳號');
    const venue = await pool.query(
      `SELECT venue_id FROM admin_staff WHERE venue_id IS NOT NULL AND TRIM(venue_id) <> '' GROUP BY venue_id ORDER BY count(*) DESC LIMIT 1`
    );
    const venueId = venue.rows[0]?.venue_id || null;
    await cleanup(pool, staffIds, userIds);   // 前一輪如果異常中斷，先掃乾淨
    for (const a of ACCOUNTS) {
      await pool.query(
        `INSERT INTO admin_staff (id, name, role, venue_id, phone, active, is_counter, is_coach, is_lifeguard)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$8)`,
        [a.staff, a.name, a.role, venueId, PHONE[a.key],
          !!a.flags.is_counter, !!a.flags.is_coach, !!a.flags.is_lifeguard]
      );
      for (const r of a.manualRoles || []) {
        await pool.query(
          `INSERT INTO admin_staff_roles (staff_id, role, updated_by) VALUES ($1,$2,'smoke-test')`,
          [a.staff, r]
        );
      }
    }
    note(`已建立 ${ACCOUNTS.length} 筆 admin_staff（venue_id=${venueId || 'NULL'}），run id = ${RUN}`);

    // ── 1. 啟動伺服器並確認身分 ────────────────────────────────────────
    section('[1] 啟動伺服器並確認「回應我的就是我啟動的那台」');
    port = await pickFreePort();
    const nonce = crypto.randomBytes(12).toString('hex');
    note(`選定 port ${port}（lsof 確認無 listener）`);

    child = spawn(process.execPath, [__filename], {
      cwd: SERVER,
      env: { ...process.env, PORT: String(port), SMOKE_CHILD_NONCE: nonce },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await waitForReady(child, 60000);
    note(`子行程 spawn PID = ${child.pid}，READY 回報 pid=${ready.pid} port=${ready.port}`);

    check('READY 回報的 PID 等於 spawn 拿到的 PID', () => {
      assert.strictEqual(ready.pid, child.pid, `READY 說 ${ready.pid}，spawn 說 ${child.pid}`);
    });
    check('READY 回報的 port 等於指定的 port', () => {
      assert.strictEqual(ready.port, port);
    });
    const pids = pidsOnPort(port);
    check('lsof 查到佔用該 port 的 PID 只有我啟動的那個', () => {
      assert.deepStrictEqual(pids, [child.pid],
        `lsof -ti:${port} 回 [${pids.join(',')}]，期望 [${child.pid}]；` +
        '不相符代表有另一台伺服器在同一個 port 上，後面所有結果都不可信');
    });
    const ping = await request(port, 'GET', '/__smoke/ping');
    check('/__smoke/ping 回本輪的 nonce 與 pid（確認不是上一輪殘留的伺服器）', () => {
      assert.strictEqual(ping.status, 200, `ping 回 ${ping.status}`);
      assert.strictEqual(ping.body && ping.body.nonce, nonce, 'nonce 不符 —— 打到的是別台伺服器');
      assert.strictEqual(ping.body && ping.body.pid, child.pid, 'pid 不符 —— 打到的是別台伺服器');
    });
    // 身分沒確認就往下跑，得到的只會是「某台伺服器」的行為，不是這次要驗的那台。
    if (failures) throw new Error('伺服器身分確認失敗，中止測試（繼續下去只會產生假結果）');

    // ── 2. 登入 ────────────────────────────────────────────────────────
    section('[2] 四個後台角色都能登入，且 JWT 上的 role 是正確的最高身分');
    const sess = {};
    for (const a of ACCOUNTS) {
      // 走 auth.js 的「員工編號 + 電話」預設登入，因為 highestRole() 這個
      // 最危險的判定就在那條路徑上（救生員被降級成櫃檯的原始 bug 出處）。
      const r = await login(port, a.staff, PHONE[a.key], a.ip);
      sess[a.key] = r;
    }

    check('沒有任何一次登入撞到 429 限流（撞到的話後面結果全部不可信）', () => {
      const hit = ACCOUNTS.filter((a) => sess[a.key].status === 429).map((a) => a.key);
      assert.deepStrictEqual(hit, [], `這些帳號吃到 429：${hit.join('、')}`);
    });

    for (const a of ACCOUNTS.filter((x) => x.expectRole)) {
      check(`${a.key} 能登入後台`, () => {
        assert.strictEqual(sess[a.key].status, 200, `HTTP ${sess[a.key].status}`);
        assert.ok(sess[a.key].body && sess[a.key].body.token,
          `登入回 ${JSON.stringify(sess[a.key].body)} —— 帳密錯誤時 auth.js 回的是 200 + null`);
      });
    }
    for (const a of ACCOUNTS.filter((x) => x.expectRole)) {
      check(`${a.key} 的 JWT role = ${a.expectRole}（不是一律落成 staff）`, () => {
        const tok = sess[a.key].body && sess[a.key].body.token;
        assert.ok(tok, '沒拿到 token，無從驗證');
        // 用後端自己的 verifyToken 驗簽，不是只 base64 解開 —— 沒驗簽的 token
        // 內容是誰都能捏造的，拿它做斷言等於沒驗。
        const claims = verifyToken(tok);
        assert.strictEqual(claims.role, a.expectRole,
          `JWT 上是 ${claims.role}；救生員被寫成 staff 就是那個「52 人靜默提權」的 bug`);
        assert.strictEqual(sess[a.key].body.role, a.expectRole,
          `回應 body 的 role (${sess[a.key].body.role}) 與 JWT (${claims.role}) 不一致`);
      });
    }
    const tokens = {};
    for (const a of ACCOUNTS.filter((x) => x.expectRole)) tokens[a.key] = sess[a.key].body && sess[a.key].body.token;
    // 少一個 token，後面每一條都會退化成「未帶 token → 401」，那不是在驗權限。
    const noToken = ACCOUNTS.filter((x) => x.expectRole && !tokens[x.key]).map((x) => x.key);
    if (noToken.length) throw new Error(`這些帳號沒有登入成功，無法繼續：${noToken.join('、')}`);

    // ── 3. coach 不能登入後台 ──────────────────────────────────────────
    section('[3] 純教練不能登入後台（他走 LIFF）');
    check('coach 登入被拒', () => {
      const r = sess.coach;
      assert.notStrictEqual(r.status, 429, '吃到限流，這一條沒驗到');
      // auth.js 對「帳密不成立」回的是 200 + null（與前端 mock 一致），
      // 所以這裡看的是「有沒有拿到 token」，不是狀態碼。
      const tok = r.body && r.body.token;
      assert.ok(!tok, `教練竟然拿到了 token（HTTP ${r.status}）：${JSON.stringify(r.body)}`);
    });

    // ── 4. /mine 與獨立重算比對 ────────────────────────────────────────
    section('[4] /role-permissions/mine 與兩份獨立重算的結果完全一致');
    const mineOf = {};   // key → /mine 回的 allowed 陣列
    for (const a of ACCOUNTS.filter((x) => x.expectRole)) {
      const uid = U(a.staff);
      const r = await request(port, 'GET', '/api/admin/role-permissions/mine', { token: tokens[a.key] });
      mineOf[a.key] = (r.body && Array.isArray(r.body.allowed)) ? r.body.allowed : null;

      // 重算一：呼叫後端 service。本行程與伺服器是兩個 process，快取各自獨立，
      // 但仍先 invalidate() —— service 有 15 秒快取，不清會拿到自己剛剛的舊答案。
      svc.invalidate();
      const bySvc = await svc.effectiveResources({ role: a.expectRole, userId: uid });

      // 重算二：完全繞開 service，直接用 SQL 把判定邏輯重寫一遍。
      // 只信 service 的話，service 自己壞掉時這一條會跟著一起壞、卻仍然全綠。
      const bySql = await recomputeFromSql(pool, RESOURCE_KEYS, uid, a.expectRole);

      check(`${a.key}：/mine == service.effectiveResources() == SQL 重算`, () => {
        assert.strictEqual(r.status, 200, `/mine 回 ${r.status}`);
        assert.ok(r.body && Array.isArray(r.body.allowed), `/mine 回 ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.role, a.expectRole, `/mine 的 role 是 ${r.body.role}`);
        assert.deepStrictEqual(r.body.allowed, bySvc,
          `API 與 service 不一致\n           API: ${r.body.allowed.join(',') || '(空)'}\n           SVC: ${bySvc.join(',') || '(空)'}`);
        assert.deepStrictEqual(bySql, bySvc,
          `SQL 重算與 service 不一致（兩者其中之一有 bug）\n           SQL: ${bySql.join(',') || '(空)'}\n           SVC: ${bySvc.join(',') || '(空)'}`);
      });
      note(`${a.key} 可見 ${mineOf[a.key] ? mineOf[a.key].length : '?'} 項`);
    }
    const noMine = Object.keys(mineOf).filter((k) => mineOf[k] === null);
    if (noMine.length) throw new Error(`這些帳號的 /mine 沒有回出清單，無法繼續：${noMine.join('、')}`);

    // ── 5. admin 全開 ──────────────────────────────────────────────────
    section('[5] admin 打任何資源都不會被 403 擋');
    const adminStatus = {};
    for (const [key, url] of Object.entries(ENDPOINTS)) {
      const r = await request(port, 'GET', url, { token: tokens.admin });
      adminStatus[key] = r.status;
    }
    check(`admin 對 ${Object.keys(ENDPOINTS).length} 個受保護端點皆非 403`, () => {
      const blocked = Object.entries(adminStatus).filter(([, s]) => s === 403).map(([k, s]) => `${k}=${s}`);
      assert.deepStrictEqual(blocked, [], `這些被擋了：${blocked.join('、')}`);
    });
    // 這一條同時是端點清單本身的體檢：401/404 代表清單寫錯（路徑不存在或沒掛
    // 到 auth），那樣後面的「403 / 非 403」比對就完全失去意義。
    check('端點清單有效（admin 不應該拿到 401 / 404）', () => {
      const bad = Object.entries(adminStatus).filter(([, s]) => s === 401 || s === 404).map(([k, s]) => `${k}=${s}`);
      assert.deepStrictEqual(bad, [], `這些端點路徑或掛載有問題：${bad.join('、')}`);
    });
    const usable = Object.keys(ENDPOINTS).filter((k) => adminStatus[k] >= 200 && adminStatus[k] < 300);
    note(`admin 取得 2xx 的端點 ${usable.length}/${Object.keys(ENDPOINTS).length} 個，後續挑選只用這些`);
    const nonOk = Object.entries(adminStatus).filter(([, s]) => s < 200 || s >= 300);
    if (nonOk.length) note(`非 2xx（不影響權限結論，僅記錄）：${nonOk.map(([k, s]) => k + '=' + s).join('、')}`);

    // ── 6. 有 / 沒有權限的資源，打 API 的實際結果 ───────────────────────
    section('[6] 沒權限的資源 → 403；有權限的資源 → 非 403');
    for (const a of ACCOUNTS.filter((x) => x.expectRole && x.key !== 'admin')) {
      const allowed = new Set(mineOf[a.key]);
      const denyKey = usable.find((k) => !allowed.has(k));
      const okKey = usable.find((k) => allowed.has(k));

      if (denyKey) {
        const r = await request(port, 'GET', ENDPOINTS[denyKey], { token: tokens[a.key] });
        check(`${a.key} 打「沒有權限」的 ${denyKey} → 403`, () => {
          assert.strictEqual(r.status, 403,
            `實際 ${r.status}（200 = 藏起來但打得進去；404/500 = 擋錯地方，錯誤訊息會誤導排查）`);
          assert.strictEqual(r.body && r.body.code, 'RESOURCE_FORBIDDEN',
            `403 但 code 是 ${r.body && r.body.code} —— 應由 requireResource 擋下，不是別的中介層`);
        });
      } else {
        failures++;
        console.error(`  FAIL ${a.key} 找不到「沒有權限」的端點可測（他對清單內每一項都有權限？）`);
      }

      if (okKey) {
        const r = await request(port, 'GET', ENDPOINTS[okKey], { token: tokens[a.key] });
        check(`${a.key} 打「有權限」的 ${okKey} → 非 403（實際 ${r.status}）`, () => {
          assert.notStrictEqual(r.status, 403, '有權限卻被擋，等於權限設定沒有生效');
          assert.notStrictEqual(r.status, 401, '被當成未登入，token 有問題');
          assert.notStrictEqual(r.status, 404, '路徑不存在，這一條沒驗到東西');
        });
      } else {
        // 不靜默跳過：沒有可測的端點本身就是一個要被看見的事實。
        note(`${a.key} 的角色權限為空，本節「有權限 → 非 403」改由 [8] 的個人 override 授予後驗證`);
      }
    }

    // ── 7. 複數身分 = 聯集 ─────────────────────────────────────────────
    section('[7] 一人身兼數職，可見資源必須是各身分的聯集');
    svc.invalidate();
    const staffOnly = new Set(await svc.allowedResources('staff'));
    const lifeguardOnly = new Set(await svc.allowedResources('lifeguard'));
    const managerOnly = new Set(await svc.allowedResources('manager'));

    // 7a：規格字面上的案例 —— 櫃檯 + 救生員。
    const dualAllowed = mineOf.dual;
    const dualUnion = RESOURCE_KEYS.filter((k) => staffOnly.has(k) || lifeguardOnly.has(k));
    check('櫃檯兼救生員的可見資源 = 櫃檯 ∪ 救生員', () => {
      assert.deepStrictEqual(dualAllowed, dualUnion,
        `實際 ${dualAllowed.length} 項、聯集 ${dualUnion.length} 項`);
    });
    const lifeguardExtra = [...lifeguardOnly].filter((k) => !staffOnly.has(k));
    if (lifeguardExtra.length === 0) {
      // 這個事實要講出來，否則上面那條看起來很強、其實只是 X ∪ ∅ = X。
      note(`注意：目前 role_permissions 沒有給救生員任何資源（${lifeguardOnly.size} 項），` +
        '所以上面那條聯集在數學上等於「櫃檯的集合」，證明力有限。真正的聯集由 7b 驗。');
    }

    // 7b：非空聯集 —— 櫃檯（Ragic 旗標）+ 主管（admin_staff_roles 手動指派）。
    // 這個人的 JWT role 是 staff，如果權限只看「代表角色」，主管那一側會整個消失。
    const mixAllowed = mineOf.mix;
    const mixUnion = RESOURCE_KEYS.filter((k) => staffOnly.has(k) || managerOnly.has(k));
    const mgrExtra = RESOURCE_KEYS.filter((k) => managerOnly.has(k) && !staffOnly.has(k));
    const stfExtra = RESOURCE_KEYS.filter((k) => staffOnly.has(k) && !managerOnly.has(k));
    check('聯集測試前提成立：兩個角色各自都有對方沒有的資源', () => {
      assert.ok(mgrExtra.length > 0, '主管沒有任何櫃檯以外的資源，這條測不出聯集');
      assert.ok(stfExtra.length > 0, '櫃檯沒有任何主管以外的資源，這條測不出聯集');
    });
    check('櫃檯兼主管的可見資源 = 櫃檯 ∪ 主管', () => {
      assert.deepStrictEqual(mixAllowed, mixUnion,
        `實際 ${mixAllowed.length} 項、聯集 ${mixUnion.length} 項`);
    });
    check(`聯集是真的聯集：主管獨有的 ${mgrExtra.length} 項全都看得到（JWT 上他是 manager，這 6 項櫃檯獨有的只能來自聯集）`, () => {
      const miss = mgrExtra.filter((k) => !mixAllowed.includes(k));
      assert.deepStrictEqual(miss, [], `少了：${miss.join('、')} —— 權限只取了代表角色`);
    });
    check(`聯集沒有反向吃掉：櫃檯獨有的 ${stfExtra.length} 項也全都看得到`, () => {
      const miss = stfExtra.filter((k) => !mixAllowed.includes(k));
      assert.deepStrictEqual(miss, [], `少了：${miss.join('、')}`);
    });
    // 聯集不只要出現在 /mine，後端閘門也要真的放行。
    const mgrExtraUsable = mgrExtra.find((k) => usable.includes(k));
    if (mgrExtraUsable) {
      const r = await request(port, 'GET', ENDPOINTS[mgrExtraUsable], { token: tokens.mix });
      check(`聯集在後端閘門也生效：mix 打主管獨有的 ${mgrExtraUsable} → 非 403（實際 ${r.status}）`, () => {
        assert.notStrictEqual(r.status, 403, '/mine 看得到卻打不進去 —— 選單與閘門讀的不是同一份判定');
      });
    }

    // ── 8. 個人 override ───────────────────────────────────────────────
    section('[8] 個人 override：收回的立刻消失，開通的立刻出現');
    const revokeKey = mgrExtraUsable || usable.find((k) => mixAllowed.includes(k));
    const grantKey = usable.find((k) => !mixAllowed.includes(k));
    if (!revokeKey || !grantKey) {
      throw new Error('找不到可用來測 override 的資源組合（需要一個他有、一個他沒有的端點）');
    }
    note(`對 mix 收回 ${revokeKey}（他的角色有開）、開通 ${grantKey}（他的角色沒開）`);

    // 走真正的 API 而不是直接寫 DB：setUserOverrides 會在伺服器行程內
    // invalidate() 快取。直接改資料庫的話，伺服器最多會有 15 秒拿到舊答案，
    // 那時測出來的「立刻生效」是假的。
    const put = await request(port, 'PUT', `/api/admin/role-permissions/users/${U(P('mix'))}`, {
      token: tokens.admin,
      body: { overrides: { [revokeKey]: false, [grantKey]: true } },
    });
    check('管理員寫入個人 override 成功', () => {
      assert.strictEqual(put.status, 200, `HTTP ${put.status}：${JSON.stringify(put.body)}`);
    });

    const mine2 = await request(port, 'GET', '/api/admin/role-permissions/mine', { token: tokens.mix });
    svc.invalidate();
    const bySvc2 = await svc.effectiveResources({ role: 'manager', userId: U(P('mix')) });
    const bySql2 = await recomputeFromSql(pool, RESOURCE_KEYS, U(P('mix')), 'manager');

    check(`override 之後 /mine 仍與兩份獨立重算一致`, () => {
      assert.strictEqual(mine2.status, 200);
      assert.deepStrictEqual(mine2.body.allowed, bySvc2, 'API 與 service 不一致');
      assert.deepStrictEqual(bySql2, bySvc2, 'SQL 重算與 service 不一致');
    });
    check(`被收回的 ${revokeKey} 從 /mine 消失（即使他的角色有開）`, () => {
      assert.ok(mixAllowed.includes(revokeKey), '前提：收回前他本來看得到');
      assert.ok(!mine2.body.allowed.includes(revokeKey),
        '角色壓過了個人例外 —— 那等於「這個人不該碰某頁」永遠做不到');
    });
    check(`被開通的 ${grantKey} 出現在 /mine`, () => {
      assert.ok(mine2.body.allowed.includes(grantKey));
    });

    const revoked = await request(port, 'GET', ENDPOINTS[revokeKey], { token: tokens.mix });
    check(`被收回的 ${revokeKey} 後端閘門也擋下來 → 403`, () => {
      assert.strictEqual(revoked.status, 403,
        `實際 ${revoked.status} —— 選單藏起來但 API 打得進去，是最糟的一種假權限`);
      assert.strictEqual(revoked.body && revoked.body.code, 'RESOURCE_FORBIDDEN');
    });
    const granted = await request(port, 'GET', ENDPOINTS[grantKey], { token: tokens.mix });
    check(`被開通的 ${grantKey} 後端閘門放行 → 非 403（實際 ${granted.status}）`, () => {
      assert.notStrictEqual(granted.status, 403);
      assert.notStrictEqual(granted.status, 404);
    });

    // 補上 [6] 對「角色權限為空」的角色欠的那一條：
    // 用個人 override 開通一項，確認他不是被硬性封死，而是真的照設定走。
    const emptyRole = ACCOUNTS.find((a) => a.expectRole && a.key !== 'admin'
      && mineOf[a.key].length === 0);
    if (emptyRole) {
      const key = usable[0];
      const p2 = await request(port, 'PUT', `/api/admin/role-permissions/users/${U(emptyRole.staff)}`, {
        token: tokens.admin, body: { overrides: { [key]: true } },
      });
      const r2 = await request(port, 'GET', ENDPOINTS[key], { token: tokens[emptyRole.key] });
      check(`${emptyRole.key}（角色權限為空）經個人 override 開通 ${key} 後 → 非 403（實際 ${r2.status}）`, () => {
        assert.strictEqual(p2.status, 200, `寫入 override 失敗：${JSON.stringify(p2.body)}`);
        assert.notStrictEqual(r2.status, 403, '開通了還是被擋，代表該角色被硬性封死而非照設定走');
      });
    }
    // ── 8.5 首頁計數 ───────────────────────────────────────────────────
    section('[8.5] 首頁計數：/enrollments/stats 必須跟清單自己數出來的一模一樣');
    // 首頁原本用 enrollmentsApi.list({}) 把整份清單拉回前端，再 .filter().length
    // 數出兩個數字。正式庫 1,140 筆（含 4 個 LEFT JOIN 與 students 陣列），
    // 換回兩個整數。改成後端計數之後，這裡要釘住的是「換了做法，答案不能變」。
    //
    // 判準刻意選「跟清單比」而不是「跟寫死的數字比」：清單那條路徑的場館範圍
    // 是既有且被信任的行為，拿它當真值，等於同時驗了計數的正確性與場館隔離。
    // stats 若漏掉 scope，staff 會數到全公司而清單只回自己場館 —— 兩邊立刻對不上。
    // 這種漏法在畫面上只是一個數字，沒有任何一列可以讓人察覺不對，靠人看是看不出來的。
    const statsSeen = {};
    let compared = 0;
    for (const key of ['admin', 'manager', 'staff']) {
      if (!tokens[key]) continue;
      const statsR = await request(port, 'GET', '/api/admin/enrollments/stats', { token: tokens[key] });
      const listR = await request(port, 'GET', '/api/admin/enrollments', { token: tokens[key] });
      if (statsR.status === 403 && listR.status === 403) continue;   // 這個角色本來就不該看報名
      compared++;
      statsSeen[key] = statsR.body;
      check(`${key}：stats 的數字與清單自己數出來的一致`, () => {
        assert.strictEqual(statsR.status, 200, `stats 回 HTTP ${statsR.status}`);
        assert.strictEqual(listR.status, 200, `list 回 HTTP ${listR.status}`);
        const rows = listR.body;
        assert.ok(Array.isArray(rows), '清單回的不是陣列，無法當真值');
        const want = {
          pending: rows.filter((e) => e.status === 'pending_payment').length,
          active: rows.filter((e) => e.status === 'active' || e.status === 'confirmed').length,
        };
        assert.deepStrictEqual(
          { pending: statsR.body && statsR.body.pending, active: statsR.body && statsR.body.active },
          want,
          `stats 回 ${JSON.stringify(statsR.body)}，但清單 ${rows.length} 筆數出來是 ${JSON.stringify(want)}`
        );
      });
    }
    check('至少比對到兩個角色（比不到就代表上面整段是空轉的假綠）', () => {
      assert.ok(compared >= 2, `只比對到 ${compared} 個角色`);
    });
    check('有範圍的角色不可能數到比 admin 多', () => {
      const a = statsSeen.admin;
      assert.ok(a, 'admin 沒有拿到 stats，無法當上界');
      const over = Object.keys(statsSeen).filter((k) => k !== 'admin'
        && (statsSeen[k].pending > a.pending || statsSeen[k].active > a.active));
      assert.deepStrictEqual(over, [], `這些角色數到的比 admin 還多：${over.join('、')}`);
    });
    // 誠實記一筆：dev 庫如果所有報名都落在同一個場館，上面那條等式就分辨不出
    // 「scope 有生效」與「scope 是空的」。不裝作驗過了。
    {
      const a = statsSeen.admin;
      const scoped = Object.keys(statsSeen).filter((k) => k !== 'admin');
      const same = a && scoped.every((k) => statsSeen[k].active === a.active
        && statsSeen[k].pending === a.pending);
      if (same && scoped.length) {
        note('注意：本輪 dev 資料裡有範圍的角色與 admin 數字相同，'
          + '這條無法分辨「場館範圍有生效」與「範圍是空的」——'
          + '場館隔離本身由 [6][7] 的資源權限負責。');
      }
    }

  } finally {
    // ── 收尾：先關伺服器，再刪資料。兩段各自 try/catch，
    //    任何一段出錯都不可以蓋掉上面真正的失敗原因。
    section('[9] 收尾');
    try {
      if (child) {
        const pid = child.pid;
        await stopChild(child);
        const left = port ? pidsOnPort(port) : [];
        check(`伺服器已關閉（PID ${pid}），port ${port} 沒有殘留 listener`, () => {
          assert.deepStrictEqual(left, [], `port 上還有 PID ${left.join(',')}`);
        });
      }
    } catch (e) {
      failures++;
      console.error('  FAIL 關閉伺服器時出錯 → ' + e.message);
    }
    try {
      const removed = await cleanup(pool, staffIds, userIds);
      note(`已刪除測試資料：admin_staff ${removed.staff}、admin_users ${removed.users}、`
        + `admin_staff_roles ${removed.roles}、user_permission_overrides ${removed.overrides}`);
      const leftover = await pool.query(
        `SELECT count(*)::int n FROM admin_staff WHERE id = ANY($1::text[])`, [staffIds]);
      check('測試資料已清乾淨（dev 庫不留 smoke_ 帳號）', () => {
        assert.strictEqual(leftover.rows[0].n, 0, `還剩 ${leftover.rows[0].n} 筆 admin_staff`);
      });
      await pool.end();
    } catch (e) {
      failures++;
      console.error('  FAIL 清理測試資料時出錯 → ' + e.message);
    }

    console.log(`\n── permission smoke：${passes} passed, ${failures} failed`);
    process.exitCode = failures ? 1 : 0;
  }
}

// ── 輔助 ────────────────────────────────────────────────────────────────

function login(port, username, password, sourceIp) {
  return request(port, 'POST', '/api/admin/auth/login', { body: { username, password }, sourceIp });
}

/** 等子行程印出 READY；期間把 stderr 留著，啟動失敗時才有東西可看。 */
function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      reject(new Error(`伺服器 ${timeoutMs}ms 內沒有 READY。\nstdout:\n${out}\nstderr:\n${err}`));
    }, timeoutMs);
    const done = (fn, arg) => { clearTimeout(timer); fn(arg); };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/SMOKE_READY (\{.*\})/);
      if (m) done(resolve, JSON.parse(m[1]));
    });
    child.stderr.on('data', (c) => {
      err += c;
      if (/SMOKE_LISTEN_ERROR/.test(err)) {
        done(reject, new Error('伺服器搶不到 port（很可能有舊的伺服器還活著）：\n' + err));
      }
    });
    child.on('exit', (code) => done(reject,
      new Error(`伺服器啟動失敗，exit ${code}\nstdout:\n${out}\nstderr:\n${err}`)));
    child.on('error', (e) => done(reject, e));
  });
}

/** SIGTERM →（3 秒沒死）SIGKILL。PID 是自己 spawn 的，不靠字串比對。 */
function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已經死了 */ } }, 3000);
    child.on('exit', () => { clearTimeout(hard); setTimeout(resolve, 200); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(hard); resolve(); }
  });
}

/**
 * 把 effectiveResources() 的判定用 SQL 重寫一遍，完全不經過 service。
 *
 * 這是刻意的重複實作。只拿 service 跟 API 比的話，service 自己算錯時
 * 兩邊會一起錯、測試照樣全綠 —— checker 必須有自己的答案。
 */
async function recomputeFromSql(pool, RESOURCE_KEYS, userId, tokenRole) {
  const idq = await pool.query(
    `SELECT s.role, s.is_counter, s.is_coach, s.is_lifeguard,
            COALESCE(ARRAY(SELECT r.role FROM admin_staff_roles r WHERE r.staff_id = s.id), '{}') AS manual_roles
       FROM admin_users u JOIN admin_staff s ON s.id = u.staff_id
      WHERE u.id = $1`, [userId]);

  const roles = new Set();
  if (idq.rowCount) {
    const row = idq.rows[0];
    if (row.role) roles.add(row.role);
    if (row.is_counter) roles.add('staff');
    if (row.is_coach) roles.add('coach');
    if (row.is_lifeguard) roles.add('lifeguard');
    for (const r of row.manual_roles || []) if (r) roles.add(r);
  }
  // 沒有連到 admin_staff 的帳號，退回 token 上的單一角色（與 _rolesOf 相同）。
  if (roles.size === 0 && tokenRole) roles.add(tokenRole);

  if (roles.has('admin')) return [...RESOURCE_KEYS];

  const base = new Set();
  const rp = await pool.query(
    `SELECT resource_key FROM role_permissions WHERE role = ANY($1::text[])`, [[...roles]]);
  for (const r of rp.rows) base.add(r.resource_key);

  const ov = await pool.query(
    `SELECT resource_key, allowed FROM user_permission_overrides WHERE user_id = $1`, [userId]);
  for (const r of ov.rows) { if (r.allowed) base.add(r.resource_key); else base.delete(r.resource_key); }

  return RESOURCE_KEYS.filter((k) => base.has(k));
}

/** 只刪自己建的那幾筆，靠明確的 id 清單，不用 LIKE 'smoke%' 之類的模糊比對。 */
async function cleanup(pool, staffIds, userIds) {
  const out = {};
  let r;
  r = await pool.query(`DELETE FROM user_permission_overrides WHERE user_id = ANY($1::text[])`, [userIds]);
  out.overrides = r.rowCount;
  r = await pool.query(`DELETE FROM admin_staff_roles WHERE staff_id = ANY($1::text[])`, [staffIds]);
  out.roles = r.rowCount;
  r = await pool.query(`DELETE FROM admin_users WHERE id = ANY($1::text[]) OR staff_id = ANY($2::text[])`, [userIds, staffIds]);
  out.users = r.rowCount;
  r = await pool.query(`DELETE FROM admin_staff WHERE id = ANY($1::text[])`, [staffIds]);
  out.staff = r.rowCount;
  return out;
}

// ── 進入點（放在最後，讓上面所有宣告都已完成初始化）──────────────────────
if (process.env.SMOKE_CHILD_NONCE) {
  runHarness();
} else {
  main().catch((e) => {
    console.error('\n測試中止：' + (e && e.message || e));
    if (e && e.stack) console.error(e.stack);
    process.exitCode = 1;
  });
}
