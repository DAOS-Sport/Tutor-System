// 上課紀錄查詢：篩選列上方的快速搜尋（2026-11-03 使用者需求）。
// 跑真的 SessionsPage 與 sessionSearch.mjs，API 用記憶體假資料，不連資料庫。
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
    module, exports: module.exports, URLSearchParams, Date, console, Intl,
    document: { activeElement: { blur() {} }, getElementById() { return { scrollIntoView() {} }; } },
    require(name) {
      if (name === 'react') return hooks;
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (name.endsWith('/utils/format')) return load(path.resolve(path.dirname(file), name + '.js'));
      if (name.includes('/components/') || name.includes('/shared/')) return { __esModule: true, default: name.split('/').pop() };
      if (name.startsWith('.') && (name.endsWith('.js') || name.endsWith('.mjs'))) return load(path.resolve(path.dirname(file), name), stubs);
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

(async () => {
  const search = load(path.join(root, 'client/admin/src/utils/sessionSearch.mjs'));
  assert.deepEqual([...search.dateVariants('2026-11-01')], ['2026-11-01', '2026/11/01', '11/01', '11/1', '11-01', '1101']);
  assert.deepEqual([...search.searchTokens('  王睿旭　１１/０１ ')], ['王睿旭', '11/01']);

  const toast = { error() {}, warning() {}, success() {} };
  const calls = [];
  const exported = [];
  const venues = [{ id: 'B', name: '新北高中', is_active: true }, { id: 'K', name: '三重商工', is_active: true }, { id: 'L', name: '三民高中', is_active: true }];
  // 虛構名字，不用正式資料。
  const records = [
    { id: 's1', date: '2026-11-01', start: '10:00', end: '11:00', venue_id: 'K', coach: '甲教練', students: ['王小明'], course_type: 1, checkin_status: 'checked_in', checkin_at: '2026-11-01T02:30:00.000Z' },
    { id: 's2', date: '2026-11-02', start: '15:00', end: '16:00', venue_id: 'B', coach: '乙教練', students: ['李小華'], course_type: 2, checkin_status: 'not_yet' },
    { id: 's3', date: '2026-11-01', start: '16:00', end: '17:00', venue_id: 'L', coach: '乙教練', students: ['陳小美'], course_type: 2, checkin_status: 'checked_in', checkin_at: '2026-11-01T08:05:00.000Z', deduction_reason: '家長確認補登', deducted_by: '櫃台丙' },
  ];
  const page = mount('client/admin/src/pages/SessionsPage.jsx', {
    '../context/AuthContext': { useAuth: () => ({ role: 'admin', isAdmin: true, isStaff: false, venueIds: [] }) },
    '../context/ToastContext': { useToast: () => toast },
    '../api/sessions': { sessionsApi: { range: async q => { calls.push(q); return records; }, coefficientCategories: async () => [] } },
    '../api/venues': { venuesApi: { list: async () => venues } },
    '../utils/csvExport': { exportSessionsXlsx(opts) { exported.push(opts); return { attendedCount: opts.sessions.length }; } },
  });
  await page.settle();
  const rows = () => nodes(page.tree).find(n => n.type === 'DataTable').props.rows.map(r => r.id);
  const type = (value) => {
    const input = nodes(page.tree).find(n => n.type === 'input' && n.props.id === 'session-quick-search');
    assert.ok(input, 'Missing quick search box');
    input.props.onChange({ target: { value } }); page.render();
  };
  assert.deepEqual(rows(), ['s1', 's2', 's3']);
  assert.equal(calls.length, 1);

  type('乙教練');
  assert.deepEqual(rows(), ['s2', 's3'], 'Coach name');
  assert.equal(calls.length, 1, 'Typing must not re-query the server');
  assert.match(words(page.tree), /搜尋符合 2 筆/);

  type('乙教練 11/01');
  assert.deepEqual(rows(), ['s3'], 'All words must match (coach AND date)');
  type('2026/11/02'); assert.deepEqual(rows(), ['s2'], 'Date written with slashes');
  type('三民'); assert.deepEqual(rows(), ['s3'], 'Short venue name');
  type('三重商工'); assert.deepEqual(rows(), ['s1'], 'Full venue name');
  type('家長確認'); assert.deepEqual(rows(), ['s3'], 'Deduction reason');
  type('櫃台丙'); assert.deepEqual(rows(), ['s3'], 'Who deducted');
  type('16:05'); assert.deepEqual(rows(), ['s3'], 'Check-in time in Taipei');
  type('李小華'); assert.deepEqual(rows(), ['s2'], 'Student name');
  type('不存在的人'); assert.deepEqual(rows(), []);
  assert.match(nodes(page.tree).find(n => n.type === 'DataTable').props.empty, /沒有符合搜尋/);

  type('乙教練');
  const exportButton = nodes(page.tree).find(n => n.type === 'button' && words(n).includes('匯出 Excel'));
  exportButton.props.onClick();
  assert.deepEqual(exported[0].sessions.map(r => r.id), ['s2', 's3'], 'Export follows the search');
  assert.ok(exported[0].filenamePrefix.endsWith('_搜尋'), 'Searched export is labelled');

  type('');
  assert.deepEqual(rows(), ['s1', 's2', 's3'], 'Clearing the box shows everything again');
  nodes(page.tree).find(n => n.type === 'button' && words(n).includes('匯出 Excel')).props.onClick();
  assert.equal(exported[1].sessions.length, 3);
  assert.ok(!exported[1].filenamePrefix.endsWith('_搜尋'));
  console.log('PASS: quick search filters loaded sessions by coach/date/venue/reason/time/student, AND words, no re-query, export follows search');
})().catch(error => { console.error(error); process.exitCode = 1; });
