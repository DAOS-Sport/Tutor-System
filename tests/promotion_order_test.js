'use strict';
/**
 * 進行中優惠的顯示排序鎖。
 *
 * 起因：家長首頁的優惠橫幅「每次重新整理就換位置」。原因是兩支查詢都只有
 * ORDER BY end_date，而同一波活動常常四檔同一天結束 —— 那些列之間沒有任何
 * 決定性順序，Postgres 每次回的次序都可能不同。
 *
 * 這支鎖的是 SQL 的形狀；名稱解析規則本身已對真的 Postgres 驗過
 * （含「滿1000折100」不得被解析成組別 0 的陷阱案例）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
const promotions = require(path.join(ROOT, 'server/services/promotions'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('  ok   ' + label); }
  catch (e) { failures += 1; console.error('  FAIL ' + label + '\n       ' + e.message); }
}

console.log('promotion_order_test');

check('排序鍵：檔期晚的在前 → 組別小的在前 → id', () => {
  const sql = promotions.promoDisplayOrderSql('p');
  assert.ok(sql.length > 50, '產生的 SQL 太短 —— 掃描失效，非真的通過');
  const keys = sql.replace(/^\s*ORDER BY\s*/, '').split(/,\n/).map((s) => s.trim());
  assert.ok(keys.length >= 3, '只有 ' + keys.length + ' 個排序鍵，至少要三層');
  assert.ok(/^p\.end_date DESC$/.test(keys[0]), '第一鍵應為 p.end_date DESC，實際：' + keys[0]);
  assert.ok(/applicable_course_types/.test(keys[1]), '第二鍵應處理組別，實際：' + keys[1]);
  // 最後一鍵是決定性保證：沒有它，同檔期同組別的活動順序就是隨機的。
  assert.strictEqual(keys[keys.length - 1], 'p.id',
    '最後一個排序鍵必須是 p.id —— 那是「不會亂跳」的唯一保證，不是美觀考量。實際：'
    + keys[keys.length - 1]);
});

check('每個欄位參照都帶 alias（換 alias 不能有漏網）', () => {
  const sql = promotions.promoDisplayOrderSql('zz');
  assert.ok(!/\bp\./.test(sql), '有寫死的 p. 前綴');
  const refs = (sql.match(/zz\./g) || []).length;
  assert.ok(refs >= 4, '只有 ' + refs + ' 處帶 alias —— 掃描失效或真的有漏');
});

check('名稱解析要求分隔字，不是「抓 1 後面的數字」', () => {
  const sql = promotions.promoDisplayOrderSql('p');
  // 「滿1000折100」不能被解析成組別 0 而排到最前面。
  assert.ok(/1\[\[:space:\]\]\*對/.test(sql), '缺少「1對N」的解析');
  assert.ok(!/from '1\(\[0-9\]/.test(sql), '直接抓 1 後面的數字會把「滿1000」誤判成組別 0');
  assert.ok(/99/.test(sql), '解析不到時應排到最後（99），不可插隊到有標組別的活動前面');
});

check('家長端與教練端共用同一份排序', () => {
  assert.ok(/promoDisplayOrderSql\(/.test(read('server/services/promotions.js')),
    'listActivePromotions 沒用共用排序');
  assert.ok(/promoDisplayOrderSql\(/.test(read('server/routes/sessions.js')),
    '教練端優惠查詢沒用共用排序 —— 兩邊順序不一致的話，教練念的第一檔跟家長看到的對不上');
});

if (failures) {
  console.error('\npromotion_order_test: ' + failures + ' failed');
  process.exit(1);
}
console.log('promotion_order_test: all passed');
process.exit(0);
