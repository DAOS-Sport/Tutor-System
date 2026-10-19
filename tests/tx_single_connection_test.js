'use strict';
// 交易內不可再向連線池借第二條連線（GitHub #10 開放報名尖峰壓測發現）。
//
// 事故型態：報名路由先 pool.connect() 開交易，交易中途又呼叫用 pool.query 的 helper
// （familyScope.actingParentIds、promotions.previewBestDiscount）。並發報名數 ≥ 連線池上限
// （pg 預設 10）時，10 條連線全被交易占住、每個交易都在等第 11 條 —— 永遠等不到，
// 整台伺服器卡死（連 /health 都不回），只能重啟。本機壓測 ENROLL_CONC=50 實測重現。
//
// 這支測兩件事：
//   A. previewBestDiscount 傳入 db 時，所有查詢都走那個 db、一條都不碰全域 pool。
//   B. 家長報名／團購路由在 BEGIN…COMMIT 之間呼叫這兩個 helper 時，一定把 client 帶進去。
// 純單元測試：不連資料庫。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://invalid@127.0.0.1:1/never_used_test';
const { pool } = require('../server/models/db');
pool.query = async () => { throw new Error('global pool must not be used when db is passed'); };
pool.connect = async () => { throw new Error('global pool must not be used when db is passed'); };
const promotions = require('../server/services/promotions');

let passed = 0;
const ok = (label) => { passed += 1; console.log('  PASS ' + label); };

(async () => {
  // ── A ──
  const now = Date.now();
  const promo = {
    id: '00000000-0000-4000-8000-000000000001', name: '測試', description: '', type: 'FIXED_AMOUNT',
    discount_value: '500', min_threshold_type: null, min_threshold_value: null,
    applicable_course_types: [1], applicable_venue_ids: ['B'], applicable_coach_multipliers: null,
    applicable_to_group_orders: false, show_on_parent_home: true, coupon_code: null, eligible_parent_id: null,
    start_date: new Date(now - 3600e3), end_date: new Date(now + 3600e3), max_uses: 10, current_uses: 0,
    platform_total_period_cap: null, parent_period_cap: 3, current_period_uses: 0, status: 'active',
  };
  const seen = [];
  const db = {
    query: async (sql) => {
      seen.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      if (/FROM promotions/i.test(sql)) return { rows: [promo], rowCount: 1 };
      return { rows: [{ used: 0, family_wide: false }], rowCount: 1 };
    },
  };
  const auto = await promotions.previewBestDiscount({
    originalPrice: 9000, courseType: 1, venueId: 'B', periodCount: 1,
    parentId: '00000000-0000-4000-8000-0000000000aa', coachMultiplier: 1, db,
  });
  assert.equal(auto.discountAmount, 500);
  const coupon = await promotions.previewBestDiscount({
    originalPrice: 9000, courseType: 1, venueId: 'B', periodCount: 1, couponCode: 'X',
    parentId: '00000000-0000-4000-8000-0000000000aa', coachMultiplier: 1, db,
  });
  assert.equal(coupon.discountAmount, 500);
  assert.ok(seen.length >= 3, `預期經過傳入的 db 查詢，實際 ${seen.length}`);
  ok('previewBestDiscount 傳入 db 時（自動套用與折價券兩條路）全部查詢走該 db，不碰全域 pool');

  // ── B ──
  for (const rel of ['server/routes/enrollments.js', 'server/routes/groupOrders.js']) {
    const lines = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').split('\n');
    let inTx = false;
    let checked = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // 區段取 BEGIN → client.release()：中途的提早 COMMIT/ROLLBACK 都在 if 分支裡，
      // 不能拿來當交易結束點；release 之前 client 都還被這個請求占著。
      if (/client\.query\('BEGIN'\)/.test(line)) inTx = true;
      if (/client\.release\(\)/.test(line)) inTx = false;
      if (!inTx) continue;
      if (/actingParentIds\(req/.test(line)) {
        checked += 1;
        assert.match(line, /actingParentIds\(req, client\)/, `${rel}:${i + 1} 交易內 actingParentIds 必須帶 client`);
      }
      if (/previewBestDiscount\(\{/.test(line)) {
        checked += 1;
        const call = lines.slice(i, i + 15).join('\n');
        const end = call.indexOf('});');
        assert.match(call.slice(0, end), /db: client/, `${rel}:${i + 1} 交易內 previewBestDiscount 必須傳 db: client`);
      }
    }
    assert.ok(checked >= 2, `${rel} 應至少檢查到 2 處交易內呼叫，實際 ${checked}（掃描規則失效？）`);
  }
  ok('家長報名與團購路由：交易內的 actingParentIds／previewBestDiscount 都帶同一個 client');

  console.log(`tx_single_connection_test: ${passed} 項通過`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
