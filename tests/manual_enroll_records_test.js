// 手動建檔「建檔記錄」＋待對帳「建單人」（使用者 2026-11-03：每個帳號建過的單都要列得出來）。
// 不連資料庫：後端篩選用假 req 驗證；前端元件用記憶體假 API 實際渲染。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const appRequire = createRequire(path.join(root, 'client/admin/package.json'));
const React = appRequire('react');
const { renderToStaticMarkup } = appRequire('react-dom/server');
const { transformSync } = appRequire('esbuild');

// 1. 後端：只認 createdBy=me，帳號取自登入 token
const { pushCreatedByMe } = require('../server/services/createdByFilter');
const DOLLAR = String.fromCharCode(36);
{
  const args = []; const where = [];
  assert.equal(pushCreatedByMe({ query: {}, adminUser: { sub: 'U_1' } }, args, where), true);
  assert.deepEqual([args, where], [[], []], '沒帶 createdBy 時清單不變');
  assert.equal(pushCreatedByMe({ query: { createdBy: 'me' }, adminUser: { sub: 'U_1' } }, args, where), true);
  assert.deepEqual(args, ['U_1']);
  assert.deepEqual(where, ['ae.created_by = ' + DOLLAR + '1']);
  assert.equal(pushCreatedByMe({ query: { createdBy: 'me' }, adminUser: {} }, [], []), false, '認不出登入帳號要擋');
  const a2 = []; const w2 = [];
  pushCreatedByMe({ query: { createdBy: 'U_OTHER' }, adminUser: { sub: 'U_1' } }, a2, w2);
  assert.deepEqual([a2, w2], [[], []], '不接受前端指定別人的帳號');
}
const route = read('server/routes/admin/enrollments.js');
assert.ok(route.includes("if (!pushCreatedByMe(req, args, where)) return res.status(403)"), '清單路由要套用 createdBy 篩選');
const checkouts = read('server/services/checkouts.js');
assert.ok(checkouts.includes("'created_by', ae.created_by,") && checkouts.includes("'created_by_name', (SELECT au_cb.name"), '待對帳子訂單要帶建單人');

// 2. 前端：建檔記錄元件
let current;
const hooks = {
  ...React,
  useState(initial) {
    const owner = current; const i = owner.cursor++;
    if (!(i in owner.slots)) owner.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [owner.slots[i], (v) => { owner.slots[i] = typeof v === 'function' ? v(owner.slots[i]) : v; }];
  },
  useEffect(fn, deps) {
    const i = current.cursor++; const previous = current.slots[i];
    if (!previous || deps.some((v, n) => v !== previous[n])) current.effects.push(fn);
    current.slots[i] = deps;
  },
};
function load(file, stubs) {
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs', target: 'node20' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Intl, Date,
    require(name) {
      if (name === 'react') return hooks;
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (name.endsWith('/utils/format')) return load(path.resolve(path.dirname(file), name + '.js'), {});
      if (name.startsWith('.') && (name.endsWith('.js') || name.endsWith('.mjs'))) return load(path.resolve(path.dirname(file), name), {});
      throw new Error('Unstubbed import: ' + name);
    },
  }, { filename: file });
  return module.exports;
}

(async () => {
  const calls = [];
  const rows = [
    { id: 'EM1', submitted_at: '2026-11-03T02:00:00Z', parent_name: '虛構家長', parent_phone: '0900215261', students: ['甲'], venue_id: 'B', course_type: 2, coach: '乙教練', total_sessions: 6, period_number: 1, period_count: 1, final_price: 3000, original_price: 3000, payment_method: '轉帳', status: 'pending_payment' },
    { id: 'EM2', submitted_at: '2026-11-02T02:00:00Z', parent_name: '虛構家長', parent_phone: '0900215261', students: ['丙'], venue_id: 'K', course_type: 1, coach: '丁教練', total_sessions: 6, period_number: 2, period_count: 2, final_price: 6000, original_price: 6900, payment_method: '舊系統轉移', status: 'confirmed' },
  ];
  const Records = load(path.join(root, 'client/admin/src/components/ManualEnrollRecords.jsx'), {
    'react-router-dom': { Link: 'Link' },
    '../api/enrollments': { enrollmentsApi: { list: async (q) => { calls.push(q); return rows; } } },
  }).default;
  const owner = { slots: [], effects: [], cursor: 0 };
  const render = (props) => { current = owner; owner.cursor = 0; return Component(props); };
  const Component = Records;
  const settle = async (props) => {
    for (let i = 0; i < 3; i++) { render(props); owner.effects.splice(0).forEach((fn) => fn()); await new Promise((r) => setImmediate(r)); }
    return render(props);
  };
  const html = renderToStaticMarkup(await settle({ refreshKey: 0, venueName: (id) => ({ B: '新北高中', K: '三重商工' })[id] }));
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({ createdBy: 'me', limit: 100 }), '只向後端要「我建的」');
  assert.match(html, /建檔記錄/);
  assert.ok(!html.includes('暫存累計'), '舊標題要拿掉');
  assert.match(html, /待對帳/); assert.match(html, /已對帳/);
  assert.match(html, /新北高中/); assert.match(html, /第 2\/2 期/);
  await settle({ refreshKey: 1, venueName: (id) => id });
  assert.equal(calls.length, 2, '剛建好一筆（refreshKey 變了）要重新載入');

  // 3. 手動建檔頁用這個元件、不再留暫存清單
  const page = read('client/admin/src/pages/ManualEnrollPage.jsx');
  assert.ok(page.includes('<ManualEnrollRecords refreshKey={recordsVersion} venueName={venueName} />'));
  assert.ok(page.includes('setRecordsVersion((v) => v + 1);'), '建檔成功要讓記錄重新載入');
  assert.ok(!/setFiled|本次操作建檔歷程/.test(page), '暫存清單要拿掉');

  // 4. 待對帳：建單人篩選（我建的／家長自己報名／指定人）
  const rec = read('client/admin/src/pages/ReconcilePage.jsx');
  assert.ok(rec.includes("{ key: 'createdBy', label: '建單人', type: 'select', options: createdByOptions }"));
  assert.ok(rec.includes("String(o.created_by) === String(user.id)"), '「我建的」比對登入帳號');
  assert.ok(rec.includes("filters.createdBy === '__parent__' && orders.some((o) => o.created_by)"));
  console.log('PASS: created-by filter (server + reconcile) and manual enroll records list this account\'s orders with live status');
})().catch((e) => { console.error(e); process.exitCode = 1; });
