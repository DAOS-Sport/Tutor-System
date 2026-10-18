'use strict';
// 教練端首頁版面契約（2026-09-22 Owner 指定的樣式）。
// 用真實元件搭配記憶體內的假 API 回應渲染，不連資料庫、不打網路。
//
// 守的東西：
//   1. 頁首：教練名 + 綠點 + 當日日期。
//   2. 到期卡：標題「即將到期通知」＋組數徽章；右側收合／查看；
//      紅色藥丸「請提醒家長進行授課」**收合時也要看得到**（那是這張卡存在的理由）。
//   3. 每筆報名：剩餘天數徽章（依急迫度配色）＋組別／場館／期別／堂數＋期限＋入口。
//   4. 今日課程標題與場次數。
//
// 顏色一律斷言設計系統的 brand-* token —— 全 liff 有過 emerald 孤例的教訓
// （見 tests/coach_checkin_badge_style_test.js）。
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
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs', target: 'node20' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, URLSearchParams, Date, console,
    document: { activeElement: { blur() {} }, getElementById() { return { scrollIntoView() {} }; } },
    require(name) {
      if (name === 'react') return hooks;
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (name.endsWith('/utils/format')) return load(path.resolve(path.dirname(file), name + '.js'));
      if (name.includes('/components/') || name.includes('/shared/')) {
        return { __esModule: true, default: name.split('/').pop() };
      }
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
/** 找出文字剛好等於 text 的最內層節點（用來讀它的 className）。 */
function leafWith(tree, text) {
  const hits = nodes(tree).filter((n) => words(n).trim() === text);
  return hits.length ? hits[hits.length - 1] : null;
}
const click = (owner, label) => {
  const found = nodes(owner.tree).find((n) => n.type === 'button' && words(n).includes(label));
  assert.ok(found, '找不到按鈕：' + label);
  found.props.onClick(); owner.render();
};

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('PASS ' + name); };

const EXPIRING = {
  count: 2,
  items: [
    { id: 'ORDER-A', students: ['測試學員甲'], course_type: 1, venue_name: '測試場館',
      period_number: 1, used_sessions: 2, total_sessions: 6,
      days_left: 11, course_expires_at: '2026-10-02T15:59:00.000Z' },
    { id: 'ORDER-B', students: ['測試學員乙', '測試學員丙'], course_type: 2, venue_name: '測試場館',
      period_number: 1, used_sessions: 2, total_sessions: 6,
      days_left: 55, course_expires_at: '2026-11-15T15:59:00.000Z' },
  ],
};

function build(expiring = EXPIRING, sessions = []) {
  const navigation = [];
  const owner = mount('client/liff/src/pages/CoachTodayPage.jsx', {
    'react-router-dom': { useNavigate: () => (target) => navigation.push(target) },
    '../api/sessions': { sessionsApi: {
      todayByCoach: async () => sessions,
      promotionsByCoach: async () => ({ promotions: [] }),
      enrollmentsByCoach: async () => ({ expiring }),
    } },
    '../context/AuthContext': { useAuth: () => ({ coach: { id: 'c1', name: '測試教練' } }) },
    '../context/ToastContext': { useToast: () => ({ error() {}, warning() {}, success() {} }) },
    '../utils/promotionLabel': { promotionValueLabel: () => '' },
  });
  return { owner, navigation };
}

(async () => {
  const { owner, navigation } = build();
  await owner.settle();

  t('頁首：教練名、綠點、當日日期', () => {
    const text = words(owner.tree);
    assert.match(text, /測試教練 教練/, '頁首少了教練名');
    const dot = nodes(owner.tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('rounded-full') && n.props.className.includes('bg-brand-green')
      && n.props.className.includes('h-1.5'));
    assert.ok(dot, '頁首少了綠點');
    assert.match(text, /\d{4}\/\d{2}\/\d{2}（週.）/, '頁首少了當日日期');
  });

  t('到期卡：標題「即將到期通知」＋組數徽章', () => {
    const text = words(owner.tree);
    assert.match(text, /即將到期通知/, '標題不是「即將到期通知」');
    assert.ok(!/3 個月內即將到期/.test(text), '舊標題還在');
    const badge = leafWith(owner.tree, '2 組');
    assert.ok(badge, '少了組數徽章「2 組」');
    assert.match(badge.props.className, /rounded-full/, '組數不是藥丸徽章');
  });

  t('到期卡：紅色藥丸「請提醒家長進行授課」，收合時也看得到', () => {
    const pill = nodes(owner.tree).find((n) => typeof n.props.className === 'string'
      && n.props.className.includes('bg-brand-error')
      && words(n).includes('請提醒家長進行授課'));
    assert.ok(pill, '找不到紅色藥丸（收合狀態下應該就看得到）');
    assert.match(pill.props.className, /rounded-full/, '不是藥丸造型');
    assert.match(pill.props.className, /text-white/, '紅底沒有配白字');
  });

  t('到期卡：收合／展開文字會切換', () => {
    assert.match(words(owner.tree), /查看/, '收合時右側應該顯示「查看」');
    click(owner, '即將到期通知');
    assert.match(words(owner.tree), /收合/, '展開後右側應該顯示「收合」');
  });

  t('每筆報名：剩餘天數徽章依急迫度配色（近的橘、遠的綠）', () => {
    const near = leafWith(owner.tree, '剩 11 天');
    const far = leafWith(owner.tree, '剩 55 天');
    assert.ok(near && far, '剩餘天數徽章不見了');
    assert.match(near.props.className, /bg-brand-amber\/15/, '11 天不是橘色：' + near.props.className);
    assert.match(far.props.className, /bg-brand-green\/15/, '55 天不是綠色：' + far.props.className);
    for (const n of [near, far]) {
      assert.match(n.props.className, /rounded-full/, '剩餘天數不是藥丸徽章');
    }
    // 設計系統以外的原生色一律不准（emerald 孤例的教訓）
    const json = JSON.stringify([near.props.className, far.props.className]);
    assert.ok(!/emerald|orange-|red-\d|amber-\d/.test(json), '用了設計系統以外的原生色：' + json);
  });

  t('每筆報名：組別／場館／期別／堂數／期限／入口都在', () => {
    const text = words(owner.tree);
    for (const v of ['1對1', '1對2', '測試場館', '第 1 期', '2/6 堂', '2026-10-02 23:59', '查看這筆報名']) {
      assert.ok(text.includes(v), '少了「' + v + '」');
    }
  });

  t('每筆報名：點進去帶正確的報名 id', () => {
    click(owner, '查看這筆報名');
    assert.equal(navigation.pop(), '/coach/orders?enrollment=ORDER-A');
  });

  t('今日課程：標題與場次數', () => {
    const text = words(owner.tree);
    assert.match(text, /今日課程/, '少了今日課程標題');
    assert.match(text, /共 0 場/, '場次數不對');
  });

  // 紅色只留給真正急的：今天到期與已過期
  (async () => {})();
  const urgent = build({ count: 2, items: [
    { ...EXPIRING.items[0], id: 'U0', days_left: 0 },
    { ...EXPIRING.items[1], id: 'U1', days_left: -3 },
  ] });
  await urgent.owner.settle();
  click(urgent.owner, '即將到期通知');

  t('今天到期／已過期 → 紅色實心徽章', () => {
    const today = leafWith(urgent.owner.tree, '今天到期');
    const over = leafWith(urgent.owner.tree, '已過期');
    assert.ok(today && over, '缺少今天到期／已過期徽章');
    for (const n of [today, over]) {
      assert.match(n.props.className, /bg-brand-error/, '不是紅色：' + n.props.className);
      assert.match(n.props.className, /text-white/, '紅底沒有配白字');
    }
  });

  console.log(`\n${passed} 個測試全數通過`);
  if (passed < 9) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
