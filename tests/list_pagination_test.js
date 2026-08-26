'use strict';
/**
 * 清單分批載入的迴歸鎖（退費頁 / 所有報名頁）。
 *
 * ── 為什麼需要這一支 ──
 * 這兩頁原本都是「一次把整張表撈回來」。正式庫的 admin_enrollments 已經破千，
 * 而前端 axios 的 timeout 是 10 秒 —— 在手機網路上，這兩頁的失敗方式不是「慢」，
 * 是整頁載不出來。改成分批之後很容易在後續改動中被還原成全量載入：
 * 只要有人把 limit 拿掉，畫面在開發機（151 筆）上看起來完全正常，
 * 正式站才會壞。所以要有東西盯著。
 *
 * ── 判準刻意不只是「原始碼有沒有出現 limit 這個字」──
 * 後端那一段是把真實程式碼切出來、在沙箱裡實際跑一遍再自己算一次預期值，
 * 而不是比對字串。字串比對擋不住「參數收了但沒接進 SQL」這種改法。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ROUTE = path.join(ROOT, 'server/routes/admin/enrollments.js');
const SRC = path.join(ROOT, 'client/admin/src');
const PAGES = {
  RefundPage: path.join(SRC, 'pages/RefundPage.jsx'),
  EnrollmentsPage: path.join(SRC, 'pages/EnrollmentsPage.jsx'),
};

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

const read = (p) => fs.readFileSync(p, 'utf8');

/** 從 open 位置的括號開始配對，回傳含頭尾的整段。 */
function balanced(src, open, oc, cc) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === oc) depth += 1;
    else if (src[i] === cc) {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

// ───────────────────────── 後端：limit / offset 的實際行為 ─────────────────────────

const routeSrc = read(ROUTE);

/**
 * 把路由裡「把 req.query.limit/offset 正規化並接成 SQL 尾巴」那一段原封不動切出來執行。
 * 切不到就直接失敗 —— 代表那段被改寫或刪掉了，這支測試的前提已經不成立。
 */
function extractPaginationSnippet() {
  const start = routeSrc.indexOf('const rawLimit = Number(req.query.limit);');
  assert.ok(start > 0, '找不到 limit 正規化的起點（server/routes/admin/enrollments.js）');
  const ifIdx = routeSrc.indexOf('if (limit !== null) {', start);
  assert.ok(ifIdx > start, '找不到 `if (limit !== null)` 區塊：limit 可能已經不會接進 SQL');
  const block = balanced(routeSrc, routeSrc.indexOf('{', ifIdx), '{', '}');
  assert.ok(block, '`if (limit !== null)` 的大括號無法配對');
  return routeSrc.slice(start, routeSrc.indexOf(block, ifIdx) + block.length);
}

const snippet = extractPaginationSnippet();
// eslint-disable-next-line no-new-func
const runPagination = new Function('req', 'args', `${snippet}\nreturn { tail, limit, offset };`);

/** args 先塞一個既有參數，才驗得到 $n 的編號有沒有接續下去。 */
function paginate(query) {
  const args = ['%既有的 where 參數%'];
  const out = runPagination({ query }, args);
  return { ...out, args };
}

check('後端：不帶 limit → 完全不加 LIMIT/OFFSET（維持回全部）', () => {
  const r = paginate({});
  assert.strictEqual(r.limit, null);
  assert.strictEqual(r.tail, '', `不帶 limit 時 tail 應為空字串，實際：${JSON.stringify(r.tail)}`);
  assert.deepStrictEqual(r.args, ['%既有的 where 參數%'], '不帶 limit 不該多推參數');
});

check('後端：帶 limit → LIMIT/OFFSET 的 $n 接在既有參數之後', () => {
  const r = paginate({ limit: '50' });
  assert.strictEqual(r.limit, 50);
  assert.strictEqual(r.offset, 0);
  assert.strictEqual(r.tail, ' LIMIT $2 OFFSET $3', `實際 tail：${JSON.stringify(r.tail)}`);
  assert.deepStrictEqual(r.args, ['%既有的 where 參數%', 50, 0]);
});

check('後端：offset 有帶就要傳下去', () => {
  const r = paginate({ limit: '50', offset: '100' });
  assert.deepStrictEqual(r.args.slice(1), [50, 100]);
});

check('後端：limit 夾在 1000 以內（避免用超大 limit 繞過分頁）', () => {
  assert.strictEqual(paginate({ limit: '99999' }).limit, 1000);
  assert.strictEqual(paginate({ limit: '1000' }).limit, 1000);
});

check('後端：無效的 limit 一律視同不帶（不是視同 0 筆）', () => {
  for (const bad of ['0', '-5', 'abc', '', '1.5']) {
    const r = paginate({ limit: bad });
    assert.strictEqual(r.limit, null, `limit=${JSON.stringify(bad)} 應視同不帶`);
    assert.strictEqual(r.tail, '', `limit=${JSON.stringify(bad)} 不該產生 LIMIT`);
  }
});

check('後端：負的 offset 收斂成 0（不能讓 OFFSET 變成 SQL 錯誤）', () => {
  assert.strictEqual(paginate({ limit: '50', offset: '-5' }).offset, 0);
  assert.strictEqual(paginate({ limit: '50', offset: 'abc' }).offset, 0);
});

check('後端：算出來的 tail 真的有接到 SQL 上', () => {
  assert.ok(
    /ORDER BY ae\.submitted_at DESC\$\{tail\}/.test(routeSrc),
    'SQL 樣板沒有把 tail 接在 ORDER BY 之後 —— 參數收了卻沒用到',
  );
});

check('後端：搜尋涵蓋場館名稱（退費頁的搜尋改走後端後仍要搜得到場館）', () => {
  assert.ok(
    /LEFT JOIN venues v ON v\.id = ae\.venue_id/.test(routeSrc),
    '少了 venues 的 JOIN，場館名稱搜尋會失效',
  );
  assert.ok(
    /LOWER\(COALESCE\(v\.name,''\)\) LIKE \$\$\{idx\}/.test(routeSrc),
    '搜尋條件裡沒有比對 v.name',
  );
});

// ───────────────────────── 前端：兩頁都要真的分批 ─────────────────────────

/** 取出檔案裡所有 enrollmentsApi.list(...) 的引數字串。 */
function listCallArgs(src) {
  const out = [];
  let i = -1;
  while ((i = src.indexOf('enrollmentsApi.list(', i + 1)) >= 0) {
    out.push(balanced(src, src.indexOf('(', i), '(', ')'));
  }
  return out;
}

for (const [name, file] of Object.entries(PAGES)) {
  const src = read(file);

  check(`${name}：有 import 並實際渲染 ListFooter`, () => {
    assert.ok(/import\s+ListFooter\s+from\s+'\.\.\/components\/ListFooter'/.test(src), '沒有 import ListFooter');
    assert.ok(/<ListFooter\b/.test(src), '有 import 但沒有渲染 ListFooter');
  });

  check(`${name}：ListFooter 有拿到 sentinelRef（沒有它就永遠不會載下一批）`, () => {
    const tag = src.slice(src.indexOf('<ListFooter'), src.indexOf('/>', src.indexOf('<ListFooter')));
    for (const prop of ['loading', 'done', 'error', 'count', 'onRetry', 'sentinelRef']) {
      assert.ok(new RegExp(`\\b${prop}=`).test(tag), `<ListFooter> 少了 ${prop}`);
    }
  });

  check(`${name}：清單走 useInfiniteList，並把 limit/offset 轉給後端`, () => {
    assert.ok(/import\s+useInfiniteList\s+from\s+'\.\.\/hooks\/useInfiniteList'/.test(src), '沒有 import useInfiniteList');
    const at = src.indexOf('useInfiniteList(');
    assert.ok(at > 0, '沒有呼叫 useInfiniteList');
    const call = balanced(src, src.indexOf('(', at), '(', ')');
    assert.ok(/\{\s*limit\s*,\s*offset\s*\}/.test(call), 'fetchPage 沒有收下 { limit, offset }');
    assert.ok(/\blimit\b/.test(call) && /\boffset\b/.test(call), 'fetchPage 沒有把 limit/offset 往後端送');
  });

  check(`${name}：沒有任何一處還在全量載入（每個 enrollmentsApi.list 都要帶 limit）`, () => {
    const calls = listCallArgs(src);
    assert.ok(calls.length > 0, `${name} 找不到 enrollmentsApi.list 呼叫`);
    calls.forEach((argsText, i) => {
      assert.ok(
        /\blimit\b/.test(argsText),
        `第 ${i + 1} 處 enrollmentsApi.list 沒有帶 limit → 會整包撈回來：${argsText.slice(0, 120)}`,
      );
    });
  });
}

check('RefundPage：搜尋改由後端做（不再用前端過濾回答「找不到」）', () => {
  const src = read(PAGES.RefundPage);
  const at = src.indexOf('useInfiniteList(');
  const call = balanced(src, src.indexOf('(', at), '(', ')');
  assert.ok(/search/.test(call), '搜尋字串沒有送進後端查詢');
  assert.ok(
    !/function matchesQuery\b/.test(src),
    '前端全域過濾函式仍在：分批載入後它只看得到已載入的批次，會給出錯誤的「找不到」',
  );
});

check('ListFooter 不再是死碼（全 repo 至少有一個 import）', () => {
  const hits = [];
  (function walk(dir) {
    for (const n of fs.readdirSync(dir)) {
      const full = path.join(dir, n);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.jsx?$/.test(n) && !full.endsWith('ListFooter.jsx')
        && /from\s+'[^']*ListFooter'/.test(fs.readFileSync(full, 'utf8'))) hits.push(full);
    }
  }(SRC));
  assert.ok(hits.length >= 2, `ListFooter 目前只有 ${hits.length} 個呼叫端，預期至少 2 個`);
});

console.log(failures === 0
  ? `\n清單分批載入：全部通過`
  : `\n清單分批載入：${failures} 項失敗`);
process.exitCode = failures === 0 ? 0 : 1;
