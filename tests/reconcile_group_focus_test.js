'use strict';
// 待對帳清單的「同團」入口：真元件 + 記憶體內假 API，不連資料庫、不打網路。
//
// 守的契約（2026-09-22 需求：團購審核過的，給個小連結方便一起查帳）：
//   1. 已核准且同團 2 家以上 → 家長欄出現「團購・同團 N 家」入口。
//   2. 一家的團、未核准的團、非團購 → 沒有入口（點了畫面不會變＝騙人按）。
//   3. 點下去只留同一團的付款單；再按「顯示全部」還原。
//   4. 同團已對完帳的那幾家不在待對帳清單裡 → 橫幅要講出來，不能讓櫃檯以為只有這幾家。
//
// DataTable 在這個測試環境是被 stub 掉的元件，但 columns / rows 仍留在它的 props 上，
// 所以直接取那兩個值來驗，比對 DOM 字串可靠。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(root, 'client/admin/package.json'));
const React = appRequire('react');
const { transformSync } = appRequire('esbuild');

let current;
const hooks = {
  ...React,
  useState(initial) {
    const owner = current; const i = owner.cursor++;
    if (!(i in owner.slots)) owner.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [owner.slots[i], (v) => { owner.slots[i] = typeof v === 'function' ? v(owner.slots[i]) : v; }];
  },
  useRef(initial) { return hooks.useState(() => ({ current: initial }))[0]; },
  useMemo(fn) { return fn(); },
  useEffect(fn, deps) {
    const i = current.cursor++; const previous = current.slots[i];
    if (!previous || deps.some((v, n) => v !== previous[n])) current.effects.push(fn);
    current.slots[i] = deps;
  },
};

const stubComponent = (name) => {
  const C = () => null;
  C.displayName = name;
  return C;
};

function load(file, stubs = {}) {
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs', target: 'node20' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, URLSearchParams, Date, console, Intl,
    document: { activeElement: { blur() {} }, getElementById() { return { scrollIntoView() {} }; } },
    require(name) {
      if (name === 'react') return hooks;
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (name.endsWith('/utils/format')) return load(path.resolve(path.dirname(file), name + '.js'), stubs);
      // format.js 自己還會 require 其他純資料模組，一律照實載入（它們沒有瀏覽器相依）。
      if (name.startsWith('.') && /\.(m?js)$/.test(name)) return load(path.resolve(path.dirname(file), name), stubs);
      if (name.includes('/components/StatusBadge')) {
        return { __esModule: true, default: stubComponent('StatusBadge'), STATUS_TONE: new Proxy({}, { get: () => 'gray' }) };
      }
      if (name.includes('/components/')) return { __esModule: true, default: stubComponent(name.split('/').pop()) };
      throw new Error('Unstubbed import: ' + name);
    },
  }, { filename: file });
  return module.exports;
}

function mount(relative, stubs) {
  const Component = load(path.join(root, relative), stubs).default;
  const owner = { slots: [], effects: [], cursor: 0, tree: null };
  owner.render = () => { current = owner; owner.cursor = 0; owner.tree = Component(); return owner.tree; };
  owner.settle = async () => {
    for (let i = 0; i < 3; i++) {
      owner.render(); owner.effects.splice(0).forEach((fn) => fn());
      await new Promise((resolve) => setImmediate(resolve));
    }
    owner.render();
  };
  return owner;
}

function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!React.isValidElement(value)) return [];
  return [value, ...Object.values(value.props).flatMap(nodes)];
}
function words(value) {
  if (Array.isArray(value)) return value.map(words).join('');
  if (React.isValidElement(value)) return words(value.props.children);
  return (typeof value === 'string' || typeof value === 'number') ? String(value) : '';
}
/** 取出 DataTable 拿到的 columns / rows —— 那是畫面真正要呈現的東西。 */
function table(owner) {
  const el = nodes(owner.tree).find((n) => n.props && Array.isArray(n.props.columns) && Array.isArray(n.props.rows));
  assert.ok(el, '找不到 DataTable');
  return { columns: el.props.columns, rows: el.props.rows };
}
function parentCell(owner, row) {
  const col = table(owner).columns.find((c) => c.key === 'parent');
  assert.ok(col, '找不到「家長」欄');
  return col.render(row);
}
function findButton(tree, text) {
  return nodes(tree).find((n) => n.type === 'button' && words(n).includes(text)) || null;
}

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_GROUP = '22222222-2222-2222-2222-222222222222';

function row(id, extra = {}) {
  return {
    checkout_id: id, parent_name: '家長' + id, parent_phone: '0900000000',
    total_amount: 1000, payment_status: 'pending_reconcile', order_kind: 'standard',
    submitted_at: '2026-09-20T02:00:00.000Z', created_at: '2026-09-20T02:00:00.000Z',
    venues: [{ venue_id: 'B', venue_name: '測試場館' }], venue_ids: ['B'],
    venue: { id: 'B', name: '測試場館' },
    sub_orders: [{ id: 'AE-' + id, students: ['學員' + id], coach: '教練', course_type: 1, venue_id: 'B' }],
    invoice_families: [{ family_key: 'f-' + id }], family_count: 1,
    requires_separate_invoices: false, payment_proof_urls: [], has_payment_proof: false,
    group_order: null, ...extra,
  };
}

// 同團 3 家，但清單裡只有 2 家（第 3 家已經對完帳）
const APPROVED = { id: GROUP_ID, status: 'approved', checkout_count: 3, pending_checkout_count: 2 };
const LIST = [
  row('A', { group_order: APPROVED }),
  row('B', { group_order: APPROVED }),
  row('C'),                                                             // 非團購
  row('D', { group_order: { id: OTHER_GROUP, status: 'approved', checkout_count: 1, pending_checkout_count: 1 } }),
  row('E', { group_order: { id: 'submitted-group', status: 'submitted', checkout_count: 2, pending_checkout_count: 2 } }),
];

function build(list = LIST) {
  return mount('client/admin/src/pages/ReconcilePage.jsx', {
    '../context/ToastContext': { useToast: () => ({ error() {}, warning() {}, success() {} }) },
    '../context/AuthContext': { useAuth: () => ({ user: { role: 'admin' }, isAdmin: true, venueIds: [] }) },
    '../api/enrollments': { enrollmentsApi: {} },
    '../api/checkouts': { checkoutsApi: { list: async () => list } },
    '../api/venues': { venuesApi: { list: async () => [{ id: 'B', name: '測試場館' }] } },
    '../utils/csvExport': { exportEnrollmentsCsv() {}, exportEnrollmentsXlsx() {} },
    '../utils/imagePreview.mjs': { isSupportedImageCandidate: () => false, RECEIPT_IMAGE_ACCEPT: '' },
  });
}

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('PASS ' + name); };

(async () => {
  const owner = build();
  await owner.settle();

  t('一開始五筆全都在', () => {
    assert.equal(table(owner).rows.length, 5, '清單筆數不對');
  });

  t('已核准且同團 2 家以上 → 出現「團購・同團 N 家」入口', () => {
    const cell = parentCell(owner, LIST[0]);
    const text = words(cell);
    assert.match(text, /團購・同團 3 家/, '家長欄沒有同團入口：' + text);
    assert.ok(findButton(cell, '同團'), '同團入口不是可以點的按鈕');
  });

  t('非團購、一家的團、未核准的團 → 都沒有入口', () => {
    for (const [label, r] of [['非團購', LIST[2]], ['只有一家', LIST[3]], ['未核准', LIST[4]]]) {
      const text = words(parentCell(owner, r));
      assert.ok(!/同團/.test(text), label + ' 也出現了同團入口：' + text);
    }
  });

  t('點下去只留同一團的付款單', () => {
    findButton(parentCell(owner, LIST[0]), '同團').props.onClick();
    owner.render();
    const ids = table(owner).rows.map((r) => r.checkout_id).sort();
    assert.deepEqual(ids, ['A', 'B'], '沒有收斂到同一團：' + ids.join(','));
  });

  t('橫幅要講出「有幾家已經不在待對帳清單」', () => {
    const text = words(owner.tree);
    assert.match(text, /只顯示這一團的付款單/, '沒有出現聚焦橫幅');
    assert.match(text, /同團/, '橫幅沒講同團家數');
    assert.match(text, /1 家已不在待對帳清單/,
      '橫幅沒講已對完帳的那幾家（3 家 − 待對帳 2 家 = 1 家）：' + text);
  });

  t('按「顯示全部」還原', () => {
    const back = findButton(owner.tree, '顯示全部');
    assert.ok(back, '找不到「顯示全部」');
    back.props.onClick(); owner.render();
    assert.equal(table(owner).rows.length, 5, '沒有還原成全部');
    assert.ok(!/只顯示這一團的付款單/.test(words(owner.tree)), '橫幅沒有跟著消失');
  });

  t('同團全都還沒對帳時，橫幅不加那句多餘的註解', async () => {
    const all = [
      row('X', { group_order: { id: GROUP_ID, status: 'approved', checkout_count: 2, pending_checkout_count: 2 } }),
      row('Y', { group_order: { id: GROUP_ID, status: 'approved', checkout_count: 2, pending_checkout_count: 2 } }),
    ];
    const o2 = build(all);
    return o2.settle().then(() => {
      findButton(parentCell(o2, all[0]), '同團').props.onClick();
      o2.render();
      const text = words(o2.tree);
      assert.match(text, /只顯示這一團的付款單/);
      assert.ok(!/已不在待對帳清單/.test(text), '兩家都還在清單裡，不該出現那句話');
    });
  });

  // 上一條是非同步的，等它跑完再收尾
  await new Promise((r) => setImmediate(r));
  console.log(`\n${passed} 個測試全數通過`);
  if (passed < 7) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
