// Run real page event handlers with in-memory API responses; never connects to a database.
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
function load(file, stubs = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const code = transformSync(source, { loader: 'jsx', format: 'cjs', target: 'node20' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, URLSearchParams, Date, console,
    document: { activeElement: { blur() {} }, getElementById() { return { scrollIntoView() {} }; } },
    require(name) {
      if (name === 'react') return hooks;
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (name.endsWith('/utils/format')) return load(path.resolve(path.dirname(file), name + '.js'));
      if (name.endsWith('/venueColors.mjs')) return load(path.resolve(path.dirname(file), name));
      if (name.includes('/components/') || name.includes('/shared/')) return { __esModule: true, default: name.split('/').pop() };
      if (name.startsWith('.') && /\.m?js$/.test(name)) return load(path.resolve(path.dirname(file), name), stubs);
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
      owner.render(); owner.effects.splice(0).forEach(fn => fn());
      await new Promise(resolve => setImmediate(resolve));
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
  return React.isValidElement(value) ? words(value.props.children) : (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
}
const click = (owner, label) => {
  const found = nodes(owner.tree).find(n => n.type === 'button' && words(n).includes(label));
  assert.ok(found, 'Missing button: ' + label); found.props.onClick(); owner.render();
};

(async () => {
  const messages = []; const navigation = [];
  const toast = Object.fromEntries(['error', 'warning', 'success'].map(k => [k, m => messages.push(m)]));
  const coach = { id: 'coach-test', name: '測試教練' };
  const expiring = { count: 1, items: [{ id: 'ORDER-EXPIRES', students: ['測試學員'], course_type: 1,
    venue_name: '新北高中', period_number: 1, used_sessions: 2, total_sessions: 6,
    days_left: 10, course_expires_at: '2026-09-19T15:59:00.000Z' }] };
  const home = mount('client/liff/src/pages/CoachTodayPage.jsx', {
    'react-router-dom': { useNavigate: () => target => navigation.push(target) },
    '../api/sessions': { sessionsApi: { todayByCoach: async () => [], promotionsByCoach: async () => ({ promotions: [] }), enrollmentsByCoach: async () => ({ expiring }) } },
    '../context/AuthContext': { useAuth: () => ({ coach }) },
    '../context/ToastContext': { useToast: () => toast },
    '../utils/promotionLabel': { promotionValueLabel: () => '' },
  });
  await home.settle();
  click(home, '3 個月內即將到期'); // Regression: missing formatPlainDate used to throw here.
  assert.match(words(home.tree), /2026-09-19/);
  assert.match(words(home.tree), /請提醒家長進行授課/);
  click(home, '查看這筆報名');
  assert.equal(navigation.pop(), '/coach/orders?enrollment=ORDER-EXPIRES');

  const calls = []; const venues = [{ id: 'B', name: '新北高中' }, { id: 'K', name: '三重商工' }, { id: 'L', name: '三民高中' }, { id: 'C', name: '松山國小' }];
  const records = [{ id: 's1', date: '2026-01-01', start: '10:00', venue_id: 'B', students: [], course_type: 1 }];
  let rejectQuery = false;
  const sessionPage = mount('client/admin/src/pages/SessionsPage.jsx', {
    '../context/AuthContext': { useAuth: () => ({ role: 'lifeguard', isAdmin: false, isStaff: false, venueIds: ['B', 'K', 'L', 'C'] }) },
    '../context/ToastContext': { useToast: () => toast },
    '../api/sessions': { sessionsApi: { range: async q => { calls.push(q); if (rejectQuery) throw Error('offline'); return records; }, venueOptions: async () => venues } },
    '../api/venues': { venuesApi: { list: async () => venues } },
    '../utils/csvExport': { exportSessionsCsv() {}, exportSessionsXlsx() {} },
    '../components/DateRangeSelect': { rangeForPreset() {} },
  });
  await sessionPage.settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, calls[0].to, 'Default must be today through today');
  const pickers = () => nodes(sessionPage.tree).filter(n => n.type === 'DateTimePicker.jsx');
  pickers()[0].props.onChange('2026-01-01'); sessionPage.render();
  assert.equal(pickers()[0].props.value, '2026-01-01', 'Historical starting date must be editable before applying the range');
  assert.equal(calls.length, 1, 'Editing a date must not fetch');
  pickers()[1].props.onChange('2026-01-31'); sessionPage.render();
  click(sessionPage, '三重');
  assert.equal(calls.length, 1, 'Venue selection must not fetch');
  const oldKey = nodes(sessionPage.tree).find(n => n.type === 'FilterBar').key;
  click(sessionPage, '查詢'); await sessionPage.settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].from, '2026-01-01'); assert.equal(calls[1].to, '2026-01-31');
  assert.deepEqual([...calls[1].venueIds], ['K']);
  assert.notEqual(nodes(sessionPage.tree).find(n => n.type === 'FilterBar').key, oldKey, 'Query must remount and close the filter popovers');
  click(sessionPage, '查詢'); await sessionPage.settle();
  assert.equal(calls.length, 3, 'Same criteria query must refresh');
  pickers()[1].props.onChange('2026-05-01'); sessionPage.render();
  click(sessionPage, '查詢'); await sessionPage.settle();
  assert.equal(calls.length, 3, 'Over-limit query must be rejected without losing the page');
  assert.ok(messages.some(m => m.includes('三個月')));
  click(sessionPage, '當日');
  assert.equal(calls.length, 3, 'Today shortcut must only edit the draft');
  rejectQuery = true; click(sessionPage, '查詢'); await sessionPage.settle();
  assert.match(words(sessionPage.tree), /載入失敗/);
  rejectQuery = false; click(sessionPage, '查詢'); await sessionPage.settle();
  assert.ok(nodes(sessionPage.tree).some(n => n.type === 'DataTable'));
  const colors = load(path.join(root, 'client/admin/src/utils/venueColors.mjs'));
  assert.equal(colors.venueColor('K'), '#67b7dc');
  assert.equal(colors.venueColor('B'), '#6794dc');
  assert.equal(colors.venueColor('L'), '#6771dc');
  assert.equal(colors.venueColor('unknown'), '#e5e7eb');
  console.log('PASS: expanded expiry list, enrollment link, manual filters, historical dates, same-query refresh, close key, range rejection, failure recovery and fixed venue colors');
})().catch(error => { console.error(error); process.exitCode = 1; });
