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
// Ragic 有速率限制，而且這批要跑好幾百次。間隔太短會被擋，太長則跑不完。
const GAP_MS = Number(arg('gap')) || 400;

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

  const out = { ok: 0, failed: 0, errors: [] };
  for (let i = 0; i < targets.length; i += 1) {
    const r = targets[i];
    const tag = '[' + (i + 1) + '/' + targets.length + '] ' + r.name + ' ' + mask(r.phone);
    try {
      const ragicId = await writeback.syncParentNow(r.id);
      if (ragicId) {
        out.ok += 1;
        console.log(tag + ' → Z01#' + ragicId + (r.ragic_record_id ? '' : '（新建或以手機比對到）'));
      } else {
        // syncParentNow 對停用／未綁 UID 的列會回 null 並自己 warn，不算失敗。
        console.log(tag + ' → 略過（見上一行原因）');
      }
    } catch (e) {
      out.failed += 1;
      out.errors.push(r.name + '：' + e.message);
      console.warn(tag + ' → 失敗：' + e.message);
    }
    if (i < targets.length - 1) await sleep(GAP_MS);
  }

  console.log('\n完成：成功 ' + out.ok + ' / 失敗 ' + out.failed);
  if (out.errors.length) {
    console.log('失敗清單（前 20 筆）：');
    out.errors.slice(0, 20).forEach((e) => console.log('  ' + e));
  }
  console.log('\n注意：outbox 那幾筆仍是 pending。這是刻意的 —— 先確認 Ragic 上結果正確，');
  console.log('再決定要不要把它們標成已處理，否則哪天 RAGIC_PARENT_OUTBOX 被打開會重跑一次。');
  await pool.end();
  process.exit(out.failed ? 1 : 0);
})().catch((e) => { console.error('中止：' + e.message); process.exit(1); });
