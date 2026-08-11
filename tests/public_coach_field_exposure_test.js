'use strict';
/**
 * 公開教練端點的欄位外洩鎖。
 *
 * ── 事故 ──
 * 2026-08-11 實測：`GET /api/coaches` 不需要任何憑證，一次回出正式站
 * **165 位教練、165 支手機、138 個 Email、165 個員工編號**。
 * `GET /coaches/:id` 走同一個過濾器，同樣公開。
 *
 * 根因是黑名單：
 *     const { line_uid, staff_active, coach_profile_active, ...safe } = coach;
 *     return safe;                       // 只剝三個，其餘全放行
 *
 * 這種寫法會自己惡化——只要有人往 COACH_STAFF_PROFILE_SELECT 加一個欄位，
 * 公開端點就自動多洩一個。`intro_review_note`（主管內部評語）就是這樣混進去的。
 *
 * 所以這支測試鎖兩件事：
 *   1. 過濾器必須是白名單（fail-closed：新欄位預設不外露）
 *   2. 白名單裡不得出現任何個資／內部欄位
 *
 * 用**實際執行過濾器**來驗，不是掃字串——掃字串擋不住「白名單裡混進 phone」。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed += 1; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const src = read('server/routes/coaches.js');

// 絕對不可以出現在公開回應裡的欄位。
const FORBIDDEN = [
  'phone', 'email', 'line_uid',
  'ragic_employee_id', 'ragic_record_id', 'ragic_data_no',
  'intro_review_note', 'intro_reviewed_by',
  'staff_active', 'coach_profile_active',
];

check('過濾器是白名單，不是黑名單', () => {
  assert.ok(/const PUBLIC_COACH_FIELDS = \[/.test(src),
    '找不到 PUBLIC_COACH_FIELDS —— 白名單不存在');
  // 黑名單寫法的特徵：解構後把 rest 直接回出去
  assert.ok(!/const \{[^}]*\}\s*=\s*coach;\s*\n\s*return safe;/.test(src),
    '仍是「解構剝掉幾個、其餘 ...rest 全放行」的黑名單寫法');
  assert.ok(/for \(const k of PUBLIC_COACH_FIELDS\)/.test(src),
    'publicCoach 沒有走白名單迴圈');
});

check('白名單本身不含任何個資／內部欄位', () => {
  const m = src.match(/const PUBLIC_COACH_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(m, '掃描失效：取不到白名單內容');
  const fields = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.ok(fields.length >= 5, '白名單只解析到 ' + fields.length + ' 個欄位，掃描可能失效');
  const bad = fields.filter((f) => FORBIDDEN.includes(f));
  assert.deepStrictEqual(bad, [],
    '白名單裡出現了不該公開的欄位：' + bad.join(', '));
});

check('實際執行過濾器：餵一列完整資料，敏感欄位不得出現在輸出', () => {
  // 把 publicCoach 連同它依賴的 normalizeCoach / withMultiplierAlias / cleanVenueList
  // 從原始碼取出來跑。不 require 整個 route 檔——那會連 DB 與中介層一起載入。
  const pick = (name) => {
    const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}', 'm');
    const hit = src.match(re);
    assert.ok(hit, '掃描失效：取不到 ' + name);
    return hit[0];
  };
  const whitelist = src.match(/const PUBLIC_COACH_FIELDS = \[[\s\S]*?\];/)[0];

  // cleanVenueList / withMultiplierAlias 來自別的模組，用等效替身即可 ——
  // 這條測的是「哪些 key 被留下」，不是場館清理邏輯。
  const sandbox = `
    const cleanVenueList = (v) => Array.isArray(v) ? v.filter(Boolean) : [];
    const withMultiplierAlias = (r) => r && { ...r, multiplier: r.pricing_multiplier };
    ${whitelist}
    ${pick('normalizeCoach')}
    ${pick('publicCoach')}
    publicCoach;
  `;
  // eslint-disable-next-line no-eval
  const publicCoach = eval(sandbox);

  const row = {
    id: 'c1', name: '王教練', specialties: '自由式',
    // is_senior 是 SQL 算出來的欄位（multiplier <> 1.00），不是資料表原欄位
    is_senior: true,
    pricing_multiplier: 1.2, bio_rich_text: '介紹', intro_review_status: 'published',
    venue_ids: ['B'], venues: ['B'],
    // 以下全部不該外流
    phone: '0912345678', email: 'coach@example.com', line_uid: 'U123',
    ragic_employee_id: '0605065', ragic_record_id: '123', ragic_data_no: '9',
    intro_review_note: '主管內部評語：照片請換', intro_reviewed_by: 'admin01',
    staff_active: true, coach_profile_active: true,
    // 未來新增的欄位，預設就不該外流（fail-closed）
    salary: 99999, id_number: 'A123456789',
  };
  const out = publicCoach(row);
  const keys = Object.keys(out);

  for (const f of FORBIDDEN.concat(['salary', 'id_number'])) {
    assert.ok(!(f in out), '公開輸出含有「' + f + '」：' + JSON.stringify(out[f]));
  }
  // 反向確認：該留的有留（否則「全部剝光」也會通過上面每一條）
  for (const f of ['id', 'name', 'is_senior', 'venue_ids', 'bio']) {
    assert.ok(f in out, '公開輸出少了必要欄位「' + f + '」，前端會壞：' + keys.join(', '));
  }
});

check('教練自己的退回原因走需要登入的端點', () => {
  assert.ok(/router\.get\('\/:id\/private',\s*requireCoach,\s*requireCoachOwner\('id'\)/.test(src),
    'GET /:id/private 不存在或沒有 requireCoach + requireCoachOwner —— '
    + '教練的審核評語要嘛看不到、要嘛又變成公開的');
  // 前端要真的改用它，否則後端擋掉之後那個功能就消失了
  const page = read('client/liff/src/pages/CoachProfilePage.jsx');
  assert.ok(/coachesApi\s*\.\s*privateProfile\(/.test(page),
    'CoachProfilePage 沒有改用 privateProfile —— 主管退回原因會顯示不出來');
  assert.ok(!/\.detail\([\s\S]{0,400}intro_review_note/.test(page),
    'CoachProfilePage 仍從公開的 detail() 讀 intro_review_note');
});

check('兩支公開端點都沒有掛認證（確認這支測試守的是對的目標）', () => {
  // 這條不是要求它們公開，而是確認前提沒變：它們確實無認證，
  // 所以欄位過濾是唯一那道防線。哪天有人加上認證，這條會提醒你重新評估。
  const list = src.match(/router\.get\('\/',\s*([^)]*)\)/);
  assert.ok(list, '掃描失效：找不到 GET /');
  assert.ok(!/requireCoach|requireAdmin/.test(list[1]),
    'GET /coaches 已改成需要認證 —— 白名單的必要性要重新評估（這是好事，但別忘了同步這支測試）');
});

if (failed) { console.error('public_coach_field_exposure_test: ' + failed + ' failed'); process.exit(1); }
console.log('public_coach_field_exposure_test: all passed');
