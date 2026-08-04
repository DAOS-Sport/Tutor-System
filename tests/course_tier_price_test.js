/**
 * 課程需求 x 加成級距明價的定價解析。
 *
 * 這條路徑決定實際成交金額（個人報名、團購發起、團購加入、後台核准四處共用），
 * 算錯就是真的收錯錢，所以邊界一律釘死。
 */
const assert = require('assert');
const { tierKey, explicitTierPrice, resolveUnitPrice, normalizeTierPrices } = require('../server/services/coursePricing');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

// ── tierKey：NUMERIC(5,2) 讀出來可能是 1.5 也可能是 "1.50"，兩者必須同 key ──
t('tierKey 正規化', () => {
  assert.strictEqual(tierKey(1.5), '1.50');
  assert.strictEqual(tierKey('1.50'), '1.50');
  assert.strictEqual(tierKey(1.500), '1.50');
  assert.strictEqual(tierKey(1.2), '1.20');
  assert.strictEqual(tierKey(null), '1.00');
  assert.strictEqual(tierKey('abc'), '1.00');
  assert.strictEqual(tierKey(0), '1.00');
});

// ── 沒設定明價 → 行為必須跟改動前一模一樣 ──
t('未設定時完全沿用舊公式', () => {
  assert.strictEqual(resolveUnitPrice(6900, 1.5, null), 10350);
  assert.strictEqual(resolveUnitPrice(6900, 1.5, undefined), 10350);
  assert.strictEqual(resolveUnitPrice(6900, 1.5, {}), 10350);
  assert.strictEqual(resolveUnitPrice(3750, 1.2, null), 4500);
  assert.strictEqual(resolveUnitPrice(6900, 1, null), 6900);
  assert.strictEqual(resolveUnitPrice(0, 1.5, null), 0);
});

// ── 公司實際定價（POS 對照）──
t('公司定價：一對一 50% = 9000 而非 10350', () => {
  const tp = { '1.20': 8280, '1.50': 9000 };
  assert.strictEqual(resolveUnitPrice(6900, 1.5, tp), 9000);
  assert.strictEqual(resolveUnitPrice(6900, 1.2, tp), 8280);
  // 沒列的級距照舊公式，不會被別的級距污染
  assert.strictEqual(resolveUnitPrice(6900, 1.3, tp), 8970);
});

// ── key 沒正規化也要查得到：查不到會靜默回退舊公式、金額默默算錯 ──
t('DB 躺著未正規化的 key 仍命中', () => {
  assert.strictEqual(resolveUnitPrice(6900, 1.5, { '1.5': 9000 }), 9000);
  assert.strictEqual(resolveUnitPrice(6900, '1.50', { '1.5': 9000 }), 9000);
});

// ── 0 是合法明價（免費方案），不可被當成「未設定」而回退 ──
t('0 元是明價不是未設定', () => {
  assert.strictEqual(explicitTierPrice({ '1.50': 0 }, 1.5), 0);
  assert.strictEqual(resolveUnitPrice(6900, 1.5, { '1.50': 0 }), 0);
});

// ── 壞值一律回退，不可產生 NaN 金額 ──
t('壞值回退而非 NaN', () => {
  for (const bad of ['', null, undefined, 'abc', -1, NaN]) {
    const got = resolveUnitPrice(6900, 1.5, { '1.50': bad });
    assert.strictEqual(got, 10350, 'bad=' + String(bad) + ' got=' + got);
    assert.ok(Number.isFinite(got));
  }
});

// ── normalize：後台送上來的表單值 ──
t('normalizeTierPrices 只留有效項', () => {
  assert.deepStrictEqual(normalizeTierPrices({ '1.5': '9000', '1.2': '', '1.3': null }), { '1.50': 9000 });
  assert.deepStrictEqual(normalizeTierPrices({ '1.5': '9000.4' }), { '1.50': 9000 });
  assert.strictEqual(normalizeTierPrices({}), null);
  assert.strictEqual(normalizeTierPrices({ '1.5': '' }), null);
  assert.strictEqual(normalizeTierPrices(null), null);
  assert.strictEqual(normalizeTierPrices('not json'), null);
  assert.strictEqual(normalizeTierPrices([1, 2]), null);
  // 級距 key 本身無效 → 丟掉（避免寫入 "abc": 9000 這種永遠查不到的髒資料）
  assert.strictEqual(normalizeTierPrices({ abc: 9000 }), null);
  assert.strictEqual(normalizeTierPrices({ '0': 9000 }), null);
});

// ── 突變檢查：若 resolveUnitPrice 退化成「永遠用舊公式」，上面的公司定價案例必須爆 ──
t('突變防護：明價路徑真的有被走到', () => {
  const withPrice = resolveUnitPrice(6900, 1.5, { '1.50': 9000 });
  const without = resolveUnitPrice(6900, 1.5, null);
  assert.notStrictEqual(withPrice, without, '明價與自動計算結果相同，這個測試就失去鑑別力');
});

console.log('\n' + n + ' 個測試全數通過');