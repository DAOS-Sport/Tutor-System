'use strict';
/**
 * 定價區骨架（F-A08 階段 1）的迴歸鎖。
 *
 * 這次改的是什麼：定價從「全公司一份」變成「每個定價區一份」。
 * course_type_configs 的主鍵由 (course_type) 換成 (pricing_zone_id, course_type)，
 * 而 course_type 本身獨立成字典表 course_types —— 因為 admin_course_intros、
 * course_type_config_audit_logs、group_orders 三張表的外鍵原本指著舊主鍵，
 * 分區打破了那個唯一性，它們必須有一個語意正確的新目標。
 *
 * 鎖的是「遷移不能被改壞」，尤其這三件：
 *   1. 換主鍵必須是冪等的（每次啟動都會跑，不能重做）
 *   2. 外鍵必須指字典表，不能指回 configs，也不能直接刪掉
 *      —— group_orders 有真實訂單，沒有外鍵就等於允許塞不存在的課別
 *   3. ensurePricingZones 必須排在 seedCourseTypeConfigs 之前
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../server/bootstrap/coreSchema.js'), 'utf8');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

check('定價區與課別字典兩張表都有建', () => {
  assert.ok(SRC.includes('CREATE TABLE IF NOT EXISTS pricing_zones'), 'pricing_zones must exist');
  assert.ok(SRC.includes('CREATE TABLE IF NOT EXISTS course_types'), 'course_types dictionary must exist');
});

check('一期堂數與期數上下限掛在定價區上', () => {
  // 松山一期 10 堂、三蘆 6 堂。這個值若留在全域設定，admin_enrollments 的拆期
  // 邏輯（1 期 = N 堂，超過就 ceil(總堂數/N) 拆單）會把松山的單拆錯、金額整組錯掉。
  for (const col of ['sessions_per_period', 'period_count_min', 'period_count_max']) {
    const zoneBlock = SRC.slice(SRC.indexOf('CREATE TABLE IF NOT EXISTS pricing_zones'));
    assert.ok(zoneBlock.slice(0, 600).includes(col), `pricing_zones must carry ${col}`);
  }
});

check('venues.pricing_zone_id 可為 NULL（守門在讀取端，不是欄位）', () => {
  const line = SRC.split('\n').find((l) => l.includes('ALTER TABLE venues ADD COLUMN IF NOT EXISTS pricing_zone_id'));
  assert.ok(line, 'venues.pricing_zone_id must be added');
  assert.ok(!line.includes('NOT NULL'),
    'making it NOT NULL breaks venue creation before the picker UI exists; the read path throws instead');
});

check('DO 區塊沒有被 $$ 跳脫吃掉一個 $', () => {
  // 這條看起來很蠢，但它擋的是真的發生過的事：用字串形式的 replacement 改這個檔，
  // $$ 會被當成跳脫序列變成 $，DDL 整個語法錯誤、bootstrap 拒絕啟動。
  assert.ok(!/DO \$ BEGIN/.test(SRC), 'a mangled "DO $ BEGIN" would take the whole bootstrap down');
  assert.ok(!/END \$;/.test(SRC), 'a mangled "END $;" would take the whole bootstrap down');
});

check('換主鍵是冪等的（看現行 PK 有沒有含 pricing_zone_id 就 return）', () => {
  assert.ok(SRC.includes("if (pkCols.includes('pricing_zone_id')) return;"),
    'the PK swap must short-circuit on restart, otherwise every boot rewrites constraints');
  assert.ok(SRC.includes('ADD PRIMARY KEY (pricing_zone_id, course_type)'),
    'the new composite primary key is what makes per-zone pricing possible');
});

check('三個外鍵改指字典表，而不是被刪掉', () => {
  for (const t of ['admin_course_intros', 'course_type_config_audit_logs', 'group_orders']) {
    const re = new RegExp(`ALTER TABLE ${t}[\\s\\S]{0,260}REFERENCES course_types\\(course_type\\)`);
    assert.ok(re.test(SRC), `${t} must be repointed at the course_types dictionary`);
  }
  assert.ok(!/REFERENCES course_type_configs\(course_type\)/.test(SRC),
    'nothing may reference course_type_configs(course_type) any more — it is no longer unique');
});

check('課別字典回填涵蓋三張參照表，不只 configs', () => {
  const block = SRC.slice(SRC.indexOf('INSERT INTO course_types (course_type)'));
  for (const t of ['course_type_configs', 'group_orders', 'admin_course_intros', 'course_type_config_audit_logs']) {
    assert.ok(block.slice(0, 700).includes(t),
      `backfill must include ${t}, or rebuilding its foreign key fails on historical rows`);
  }
});

check('ensurePricingZones 排在 seedCourseTypeConfigs 之前', () => {
  const a = SRC.indexOf('await ensurePricingZones();');
  const b = SRC.indexOf('await seedCourseTypeConfigs();');
  assert.ok(a > 0 && b > 0, 'both must be wired into bootstrap()');
  assert.ok(a < b, 'seeding configs needs the swapped primary key to already be in place');
});

check('新定價區只在「一筆設定都沒有」時補預設值', () => {
  // 逐筆 upsert 會讓後台刪掉的課別在下次重啟時復活。
  assert.ok(SRC.includes('WHERE NOT EXISTS (SELECT 1 FROM course_type_configs c WHERE c.pricing_zone_id = z.id)'),
    'defaults are a starting point for empty zones, not a per-boot reconciliation');
});

if (failed) {
  console.error(`\npricing_zone_schema_test: ${failed} FAILED`);
  process.exit(1);
}
console.log('pricing_zone_schema_test: PASS');
