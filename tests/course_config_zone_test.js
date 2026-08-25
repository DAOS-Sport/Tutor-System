'use strict';
/**
 * 課別設定讀取入口（F-A08 階段 2）的行為鎖。
 *
 * 這支鎖的核心只有一句：**讀不到就丟例外，絕不退回任何預設值。**
 *
 * 分區之後最危險的失敗不是壞掉，是「錯得很安靜」—— 某個呼叫點忘了帶定價區，
 * 靜默拿到另一區的價，台北的家長付了三蘆的錢，前後端都沒有錯誤訊息，
 * 幾個月後對帳才發現，而那時候已經收了幾十筆。所以任何形式的
 * 「查不到就用預設區 / 第一筆 / 舊全域值」都必須被擋在門外。
 *
 * 不碰 DB 的部分用真的呼叫驗；需要 DB 的部分（跨區獨立性）由
 * tests/e2e 與 dev 實測涵蓋，這裡以原始碼斷言守住不變量。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const cc = require('../server/services/courseConfig');
const SRC = fs.readFileSync(
  path.resolve(__dirname, '../server/services/courseConfig.js'), 'utf8');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}
async function acheck(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const throwsCode = async (fn, code) => {
  try { await fn(); assert.fail('should have thrown ' + code); }
  catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    assert.ok(e instanceof cc.CourseConfigError, 'must be a CourseConfigError');
  }
};

(async () => {
  // ── 參數缺漏在碰 DB 之前就擋下（db 傳 null 也不該炸在連線上）──
  await acheck('漏帶課別 → COURSE_TYPE_REQUIRED', () =>
    throwsCode(() => cc.getCourseConfig(null, { venueId: 'L' }), 'COURSE_TYPE_REQUIRED'));
  await acheck('課別不是整數 → COURSE_TYPE_REQUIRED', () =>
    throwsCode(() => cc.getCourseConfig(null, { venueId: 'L', courseType: '一對三' }), 'COURSE_TYPE_REQUIRED'));
  await acheck('場館與定價區都沒給 → ZONE_REQUIRED', () =>
    throwsCode(() => cc.getCourseConfig(null, { courseType: 3 }), 'ZONE_REQUIRED'));
  await acheck('resolveZone 空參數 → ZONE_REQUIRED', () =>
    throwsCode(() => cc.resolveZone(null, {}), 'ZONE_REQUIRED'));
  await acheck('空字串場館 → VENUE_REQUIRED', () =>
    throwsCode(() => cc.resolveZoneByVenue(null, '   '), 'VENUE_REQUIRED'));
  await acheck('定價區 id 不是正整數 → ZONE_REQUIRED', () =>
    throwsCode(() => cc.getZone(null, 0), 'ZONE_REQUIRED'));

  // ── 不變量：沒有任何退路 ────────────────────────────────
  check('沒有「查不到就用第一筆／預設區」的退路', () => {
    // 這三種寫法都是靜默錯價的入口，一旦出現就代表不變量被破壞。
    assert.ok(!/ORDER BY[^`]*LIMIT 1/i.test(SRC),
      'picking "the first zone" as a fallback is exactly the silent-wrong-price failure');
    assert.ok(!/\|\|\s*1\b/.test(SRC.replace(/COALESCE[^)]*\)/g, '')),
      'defaulting a zone id to 1 would quietly price everything as the first zone');
    assert.ok(!/return null/.test(SRC),
      'returning null lets callers carry on with no price at all');
  });

  check('每個課別查詢都以 pricing_zone_id 為條件', () => {
    const queries = SRC.match(/FROM course_type_configs[\s\S]{0,160}/g) || [];
    assert.ok(queries.length > 0, 'must query course_type_configs');
    for (const q of queries) {
      assert.ok(q.includes('pricing_zone_id = $1'),
        'a course_type_configs read without a zone filter can return another zone’s row');
    }
  });

  check('取設定時一併回傳該區的一期堂數', () => {
    // 呼叫端最容易漏掉的就是「一期幾堂」，而它決定拆期；順手給出去，少一個漏點。
    assert.ok(SRC.includes('sessions_per_period: zone.sessions_per_period'),
      'callers must not have to look up sessions_per_period separately');
  });

  check('定價區欄位全部帶別名（避免與 venues.name 撞名）', () => {
    assert.ok(SRC.includes('z.id, z.name, z.sessions_per_period'),
      'unqualified columns break resolveZoneByVenue’s join against venues');
  });

  check('接受外部 db／交易 client', () => {
    assert.ok(SRC.includes('(db || pool)'),
      'money paths run inside transactions; they must be able to pass their own client');
  });

  if (failed) {
    console.error(`\ncourse_config_zone_test: ${failed} FAILED`);
    process.exit(1);
  }
  console.log('course_config_zone_test: PASS');
})();
