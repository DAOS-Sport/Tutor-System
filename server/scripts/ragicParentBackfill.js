// 把「本地有、Ragic Z01 沒有或缺 LINE UID」的家長補回 Ragic。
//
// ── 為什麼需要這支 ──
// ragic_sync_outbox 裡有一批 CREATE_Z01_PARENT / BIND_Z01_LINE_UID 從 2026-07-14
// 起就是 pending 且 attempts=0 —— 排空它的 cron 被 STABILITY_FLAGS.RAGIC_PARENT_OUTBOX
// （預設 false）擋著，從來沒跑過。後果有兩個，都會在 log 上看到：
//   [parent-refresh] Z01 LINE UID 尚未回寫（待 outbox 回寫收斂）
//   [parents/me/sync] refresh 失敗：Ragic Z01 查無剛寫入的會員資料
// 因為 _lookupZ01 先用 LINE UID 查 Z01，而那個欄位一直是空的。
//
// ── 為什麼走 ragicWriteback 而不是打開那個旗標 ──
// outbox 的 CREATE 路徑用 _findRemoteByTrueUid（**以 LINE UID 欄位查重**）。
// 而卡住的這批正是「Z01 上 UID 欄位空白」的人 —— 查不到 → 會建出第二筆重複的 Z01。
// ragicWriteback.syncParentNow 走的是 resolveParentRagicRecord：
//   ragic_record_id → 手機 → 都沒有才建立
// 以手機查重，正好避開那個坑。而且它就是家長在 App 裡按「儲存」時跑的同一條路
// （routes/parents.js 的 PATCH /me），沒有任何旗標擋著，行為已經被日常使用驗證過。
//
// ── 用法 ──
//   node scripts/ragicParentBackfill.js                 # dry-run，只列要做什麼
//   node scripts/ragicParentBackfill.js --limit=5 --apply
//   node scripts/ragicParentBackfill.js --apply         # 全部
//
// ⚠️ --apply 會**真的寫進 Ragic**（外部系統，不易回復）。務必先小批量跑過再放大。
// ⚠️ 這支要在「資料在哪裡就在哪裡跑」—— 待補的那批在正式庫，DEV 跑只會處理 DEV 的資料。
'use strict';

const { pool } = require('../models/db');
const writeback = require('../services/ragicWriteback');

const arg = (k) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const APPLY = process.argv.includes('--apply');
const LIMIT = Number(arg('limit')) || null;

// 間隔的取捨：
//   syncParentNow 每位家長是 2~3 次 HTTP（查既有 record → 必要時用手機查 → upsert），
//   220 位約 660 次。250ms 對整趟只多約 55 秒，而總耗時由 Ragic 自己的回應時間主導 ——
//   為了省這 55 秒去冒 429 的風險不划算。
//   另一方面也不需要更保守：services/ragic.js 的傳輸層已經把 429 標成
//   RAGIC_RATE_LIMITED 並做指數退避（500ms × 2^n + jitter，最多 3 次），
//   這個間隔只是第二層保險。
// 而且不猜死一個值：真的撞到 429 就把間隔加倍（上限 2s），讓它自我修正。
const GAP_START_MS = Number(arg('gap')) || 250;
const GAP_MAX_MS = 2000;
let gapMs = GAP_START_MS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (p) => String(p || '').replace(/^(\d{4})\d+(\d{2})$/, '$1****$2');

(async () => {
  if (!process.env.RAGIC_API_KEY || !process.env.RAGIC_BASE_URL) {
    console.error('Ragic 未設定（RAGIC_API_KEY / RAGIC_BASE_URL），無事可做。');
    process.exit(1);
  }

  const db = (await pool.query('SELECT current_database() AS d')).rows[0].d;

  // 收斂條件刻意寬鬆：只要 outbox 還卡著這位家長，就代表他的 Z01 狀態不完整。
  // 不在這裡自己判斷「Z01 上 UID 到底有沒有」—— 那要對每個人打一次 Ragic 讀取，
  // 幾百次的成本換不到什麼，syncParentNow 本來就會做正確的 resolve。
  const rows = (await pool.query(`
    SELECT DISTINCT p.id, p.name, p.phone, p.ragic_record_id
      FROM ragic_sync_outbox o
      JOIN identity_claims ic ON ic.id = o.claim_id
      JOIN parents p ON p.id = ic.canonical_parent_id
     WHERE o.state = 'pending'
       AND p.is_active IS NOT FALSE
       AND p.line_uid ~ '^U[0-9a-f]{32}$'
     ORDER BY p.ragic_record_id NULLS FIRST, p.name
  `)).rows;

  const targets = LIMIT ? rows.slice(0, LIMIT) : rows;
  const willCreate = targets.filter((r) => !r.ragic_record_id).length;

  console.log('資料庫：' + db);
  console.log('待處理家長：' + rows.length + ' 位'
    + (LIMIT ? '（本次只跑前 ' + targets.length + ' 位）' : ''));
  console.log('  本地無 ragic_record_id（會先以手機查重，查不到才新建）：' + willCreate);
  console.log('  已有 ragic_record_id（只更新欄位＋補寫 LINE UID）：' + (targets.length - willCreate));
  console.log('模式：' + (APPLY ? '** 實際寫入 Ragic **' : 'dry-run（不寫任何東西）'));
  console.log('');

  if (!APPLY) {
    targets.slice(0, 20).forEach((r, i) => {
      console.log('  ' + String(i + 1).padStart(3) + '. ' + String(r.name).padEnd(18)
        + mask(r.phone).padEnd(12) + (r.ragic_record_id ? 'Z01#' + r.ragic_record_id : '（無 Z01）'));
    });
    if (targets.length > 20) console.log('  …其餘 ' + (targets.length - 20) + ' 位');
    console.log('\n加上 --apply 才會真的寫入。建議先 --limit=5 --apply 看一輪結果。');
    await pool.end();
    process.exit(0);
  }

  const out = { ok: 0, failed: 0, skipped: 0, rateLimited: 0, errors: [], durations: [] };
  const t0all = Date.now();
  for (let i = 0; i < targets.length; i += 1) {
    const r = targets[i];
    const tag = '[' + (i + 1) + '/' + targets.length + '] ' + r.name + ' ' + mask(r.phone);
    const t0 = Date.now();
    try {
      const ragicId = await writeback.syncParentNow(r.id);
      const ms = Date.now() - t0;
      out.durations.push(ms);
      if (ragicId) {
        out.ok += 1;
        console.log(tag + ' → Z01#' + ragicId
          + (r.ragic_record_id ? '' : '（新建或以手機比對到）') + '  ' + ms + 'ms');
      } else {
        // syncParentNow 對停用／未綁 UID 的列會回 null 並自己 warn，不算失敗。
        out.skipped += 1;
        console.log(tag + ' → 略過（見上一行原因）');
      }
    } catch (e) {
      out.failed += 1;
      out.errors.push(r.name + '：' + (e.code ? e.code + ' ' : '') + e.message);
      console.warn(tag + ' → 失敗：' + e.message);
      // 真的被限流才放慢，不用事先猜對一個間隔。
      // 只認明確的限流訊號 —— 拿「任何錯誤都放慢」當保險會把欄位格式錯之類的
      // 問題也拖成龜速，而那種錯慢慢打一樣是錯。
      if (e.code === 'RAGIC_RATE_LIMITED' || /RAGIC_RETRY_EXHAUSTED/.test(String(e.code))) {
        out.rateLimited += 1;
        const next = Math.min(gapMs * 2, GAP_MAX_MS);
        if (next !== gapMs) {
          console.warn('  ↳ 撞到限流，間隔 ' + gapMs + 'ms → ' + next + 'ms');
          gapMs = next;
        }
      }
    }
    if (i < targets.length - 1) await sleep(gapMs);
  }

  const avg = out.durations.length
    ? Math.round(out.durations.reduce((a, b) => a + b, 0) / out.durations.length) : 0;
  console.log('\n完成：成功 ' + out.ok + ' / 略過 ' + out.skipped + ' / 失敗 ' + out.failed);
  console.log('每位平均 ' + avg + 'ms，總耗時 ' + Math.round((Date.now() - t0all) / 1000) + 's，'
    + '結束時間隔 ' + gapMs + 'ms' + (out.rateLimited ? '（曾撞限流 ' + out.rateLimited + ' 次）' : '（全程未撞限流）'));
  if (out.rateLimited === 0 && gapMs === GAP_START_MS && out.durations.length >= 5) {
    console.log('提示：全程沒撞限流，下次可以用 --gap=100 更快，或維持現值求穩。');
  }
  if (out.errors.length) {
    console.log('失敗清單（前 20 筆）：');
    out.errors.slice(0, 20).forEach((e) => console.log('  ' + e));
  }
  console.log('\n注意：outbox 那幾筆仍是 pending。這是刻意的 —— 先確認 Ragic 上結果正確，');
  console.log('再決定要不要把它們標成已處理，否則哪天 RAGIC_PARENT_OUTBOX 被打開會重跑一次。');
  await pool.end();
  process.exit(out.failed ? 1 : 0);
})().catch((e) => { console.error('中止：' + e.message); process.exit(1); });
