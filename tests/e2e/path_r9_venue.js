/**
 * R9 — 停用場館的收款銀行帳戶不得外洩給未認證訪客。
 *
 * 破口：GET /api/venues/:id 為公開路由，但明細查詢缺 is_active 過濾，
 * 停用場館（列表已隱藏）仍可被 /api/venues/<id> 直接撈出銀行帳號。
 *
 * 本測試斷言「安全行為」：對停用場館的公開查詢應回 404、且不得回傳帳號。
 *   修前（未過濾）→ 200 + account_number 外洩 → 斷言失敗（暴露漏洞）。
 *   修後（加 is_active=TRUE）→ 404 → 斷言通過。
 */
const path = require('path');
const { Client } = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'pg'));

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const VID = '__R9';           // sentinel 場館 id（varchar；短碼風格）
const LEAK_ACCT = '99998888';
let failed = false;
function ok(c, m) { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failed = true; }

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    // setup：建立一個「停用」場館，帶可辨識的收款帳號
    await db.query(`DELETE FROM admin_venues WHERE id = $1`, [VID]).catch(() => {});
    await db.query(
      `INSERT INTO venues (id, name, is_active, account_holder, account_number)
       VALUES ($1, 'R9 停用場館', FALSE, 'R9 帳戶持有人', $2)
       ON CONFLICT (id) DO UPDATE SET is_active = FALSE,
         account_holder = EXCLUDED.account_holder, account_number = EXCLUDED.account_number`,
      [VID, LEAK_ACCT]
    );

    // probe：完全未認證（無 Authorization header）
    const res = await fetch(`${BASE}/api/venues/${VID}`);
    let body; try { body = await res.json(); } catch { body = null; }
    console.log(`  probe GET /api/venues/${VID} -> ${res.status} ${JSON.stringify(body)}`);

    ok(res.status === 404, '停用場館的公開明細查詢應回 404（列表隱藏，明細亦應隱藏）');
    ok(!body || body.account_number !== LEAK_ACCT, '回應不得洩漏停用場館的銀行帳號');
  } finally {
    await db.query(`DELETE FROM venues WHERE id = $1`, [VID]).catch(() => {});
    await db.query(`DELETE FROM admin_venues WHERE id = $1`, [VID]).catch(() => {});
    await db.end();
  }
}

main().then(() => { console.log(failed ? '\nR9 FAIL' : '\nR9 PASS'); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error('R9 ERROR', e); process.exit(2); });
