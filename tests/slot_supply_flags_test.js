'use strict';
// 自動時段供給旗標 — 三入口守門與 canary 範圍（零外部相依）
const assert = require('assert');
const path = require('path');

// 每次都重新載入，才能測不同的環境變數組合
function load() {
  delete require.cache[require.resolve('../server/config/slotSupplyFlags')];
  return require('../server/config/slotSupplyFlags');
}
function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  try { fn(load()); } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// ── 總開關：fail-closed ──
withEnv({ SLOT_GEN_ENABLED: undefined }, (f) => {
  assert.strictEqual(f.isSlotSupplyEnabled(), false, '未設定應為關閉');
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'c', venueId: 'B' }), false);
});
withEnv({ SLOT_GEN_ENABLED: '0' }, (f) => assert.strictEqual(f.isSlotSupplyEnabled(), false));
withEnv({ SLOT_GEN_ENABLED: 'true' }, (f) => assert.strictEqual(f.isSlotSupplyEnabled(), false, '只認 "1"'));
withEnv({ SLOT_GEN_ENABLED: '1' }, (f) => assert.strictEqual(f.isSlotSupplyEnabled(), true));

// ── canary 為空 = 全體適用 ──
withEnv({ SLOT_GEN_ENABLED: '1', SLOT_GEN_CANARY_COACH_IDS: undefined, SLOT_GEN_CANARY_VENUE_IDS: undefined }, (f) => {
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'any', venueId: 'any' }), true);
});

// ── canary 教練白名單 ──
withEnv({ SLOT_GEN_ENABLED: '1', SLOT_GEN_CANARY_COACH_IDS: 'c1,c2' }, (f) => {
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'c1', venueId: 'B' }), true);
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'c9', venueId: 'B' }), false, '不在白名單應排除');
  assert.strictEqual(f.isInSlotSupplyScope({ venueId: 'B' }), false, '缺 coachId 應排除');
});

// ── canary 場館白名單 ──
withEnv({ SLOT_GEN_ENABLED: '1', SLOT_GEN_CANARY_VENUE_IDS: 'B, K' }, (f) => {
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'c', venueId: 'B' }), true);
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'c', venueId: 'K' }), true, '含空白應被 trim');
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'c', venueId: 'L' }), false);
});

// ── 兩者同時設定：必須都符合 ──
withEnv({ SLOT_GEN_ENABLED: '1', SLOT_GEN_CANARY_COACH_IDS: 'c1', SLOT_GEN_CANARY_VENUE_IDS: 'B' }, (f) => {
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'c1', venueId: 'B' }), true);
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'c1', venueId: 'K' }), false, '教練對但場館不對');
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'c2', venueId: 'B' }), false, '場館對但教練不對');
});

// ── 總開關關閉時，canary 設了也無效 ──
withEnv({ SLOT_GEN_ENABLED: '0', SLOT_GEN_CANARY_COACH_IDS: 'c1' }, (f) => {
  assert.strictEqual(f.isInSlotSupplyScope({ coachId: 'c1', venueId: 'B' }), false, '總開關優先');
});

// ── parseList 防呆 ──
withEnv({}, (f) => {
  assert.deepStrictEqual(f.parseList(''), []);
  assert.deepStrictEqual(f.parseList(null), []);
  assert.deepStrictEqual(f.parseList('a, ,b,'), ['a', 'b'], '空項須濾掉');
});

console.log('slot_supply_flags_test: PASS');