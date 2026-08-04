/**
 * 課程需求 x 加成級距明價的定價解析。
 *
 * 「課程需求管理」是價格的唯一來源。這條路徑同時決定：
 *   後端 —— 實際成交金額（個人報名、團購發起、團購加入、後台核准）
 *   前端 —— 家長在「選擇教練」與報名頁看到的價格
 * 兩邊算出不同數字，就是「畫面顯示 10,350、實際收 9,000」這種客訴，所以本檔
 * 除了驗規則，還會把兩份實作對同一組案例逐一比對。
 */
const assert = require('assert');
const srv = require('../server/services/coursePricing');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

(async () => {
  const cli = await import('../client/liff/src/utils/coursePricing.js');

  // ── tierKey：NUMERIC(5,2) 讀出來可能是 1.5 也可能是 "1.50"，兩者必須同 key ──
  t('tierKey 正規化', () => {
    for (const [input, want] of [[1.5, '1.50'], ['1.50', '1.50'], [1.500, '1.50'],
                                 [1.2, '1.20'], [null, '1.00'], ['abc', '1.00'], [0, '1.00']]) {
      assert.strictEqual(srv.tierKey(input), want, 'server tierKey(' + input + ')');
    }
  });

  // ── 沒設定明價 → 行為必須跟這個功能上線前一模一樣 ──
  t('未設定時完全沿用舊公式', () => {
    assert.strictEqual(srv.resolveUnitPrice(6900, 1.5, null), 10350);
    assert.strictEqual(srv.resolveUnitPrice(6900, 1.5, undefined), 10350);
    assert.strictEqual(srv.resolveUnitPrice(6900, 1.5, {}), 10350);
    assert.strictEqual(srv.resolveUnitPrice(3750, 1.2, null), 4500);
    assert.strictEqual(srv.resolveUnitPrice(6900, 1, null), 6900);
    assert.strictEqual(srv.resolveUnitPrice(0, 1.5, null), 0);
  });

  // ── 公司實際定價（POS 對照）：一對一 50% 是 9,000 不是 6900x1.5 ──
  t('公司定價：一對一 50% = 9000 而非 10350', () => {
    const tp = { '1.20': 8280, '1.50': 9000 };
    assert.strictEqual(srv.resolveUnitPrice(6900, 1.5, tp), 9000);
    assert.strictEqual(srv.resolveUnitPrice(6900, 1.2, tp), 8280);
    assert.strictEqual(srv.resolveUnitPrice(6900, 1.3, tp), 8970);  // 沒列的級距不被污染
  });

  t('DB 躺著未正規化的 key 仍命中', () => {
    assert.strictEqual(srv.resolveUnitPrice(6900, 1.5, { '1.5': 9000 }), 9000);
    assert.strictEqual(srv.resolveUnitPrice(6900, '1.50', { '1.5': 9000 }), 9000);
  });

  t('0 元是明價不是未設定', () => {
    assert.strictEqual(srv.explicitTierPrice({ '1.50': 0 }, 1.5), 0);
    assert.strictEqual(srv.resolveUnitPrice(6900, 1.5, { '1.50': 0 }), 0);
  });

  t('壞值回退而非 NaN', () => {
    for (const bad of ['', null, undefined, 'abc', -1, NaN]) {
      const got = srv.resolveUnitPrice(6900, 1.5, { '1.50': bad });
      assert.strictEqual(got, 10350, 'bad=' + String(bad));
      assert.ok(Number.isFinite(got));
    }
  });

  t('normalizeTierPrices 只留有效項', () => {
    assert.deepStrictEqual(srv.normalizeTierPrices({ '1.5': '9000', '1.2': '', '1.3': null }), { '1.50': 9000 });
    assert.deepStrictEqual(srv.normalizeTierPrices({ '1.5': '9000.4' }), { '1.50': 9000 });
    assert.strictEqual(srv.normalizeTierPrices({}), null);
    assert.strictEqual(srv.normalizeTierPrices({ '1.5': '' }), null);
    assert.strictEqual(srv.normalizeTierPrices(null), null);
    assert.strictEqual(srv.normalizeTierPrices('not json'), null);
    assert.strictEqual(srv.normalizeTierPrices([1, 2]), null);
    assert.strictEqual(srv.normalizeTierPrices({ abc: 9000 }), null);
    assert.strictEqual(srv.normalizeTierPrices({ '0': 9000 }), null);
  });

  t('突變防護：明價路徑真的有被走到', () => {
    assert.notStrictEqual(
      srv.resolveUnitPrice(6900, 1.5, { '1.50': 9000 }),
      srv.resolveUnitPrice(6900, 1.5, null),
      '明價與自動計算結果相同，這個測試就失去鑑別力');
  });

  // ══ 防漂移：後端（成交金額）與前端（畫面顯示）必須逐案一致 ══
  t('前後端兩份實作對同一組案例輸出一致', () => {
    const REAL = { '1.20': 8280, '1.50': 9000 };          // 公司實際定價
    const bases = [6900, 3750, 3300, 3000, 0];
    const mults = [1, 1.1, 1.2, 1.3, 1.5, '1.50', '1.2', null, 'abc'];
    const maps = [null, undefined, {}, REAL, { '1.5': 9000 }, { '1.50': 0 },
                  { '1.50': '' }, { '1.50': -1 }, { '1.50': 'abc' }];
    let cases = 0;
    for (const b of bases) for (const m of mults) for (const tp of maps) {
      const a = srv.resolveUnitPrice(b, m, tp);
      const c = cli.resolveUnitPrice(b, m, tp);
      assert.strictEqual(c, a,
        '前後端不一致 base=' + b + ' mult=' + String(m) + ' tier=' + JSON.stringify(tp) +
        ' → 後端(成交) ' + a + ' vs 前端(顯示) ' + c);
      cases += 1;
    }
    assert.ok(cases >= 400, '案例數 ' + cases + ' 太少，比對沒有覆蓋力');
    console.log('        （比對 ' + cases + ' 組案例）');
  });

  t('tierKey / explicitTierPrice 前後端也一致', () => {
    for (const m of [1.5, '1.50', 1.2, null, 'abc', 0, 1.05]) {
      assert.strictEqual(cli.tierKey(m), srv.tierKey(m), 'tierKey ' + String(m));
    }
    for (const tp of [null, { '1.50': 9000 }, { '1.5': 0 }, { '1.50': '' }]) {
      assert.strictEqual(cli.explicitTierPrice(tp, 1.5), srv.explicitTierPrice(tp, 1.5),
        'explicitTierPrice ' + JSON.stringify(tp));
    }
  });

  console.log('\n' + n + ' 個測試全數通過');
})().catch((e) => { console.error('\nFAIL: ' + e.message); process.exit(1); });