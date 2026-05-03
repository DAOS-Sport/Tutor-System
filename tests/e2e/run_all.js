// 跑完 8 條 E2E 路徑，回報 pass/fail
const { spawnSync } = require('child_process');
const path = require('path');

const PATHS = [
  ['A', 'path_a_purchase.js'],
  ['B', 'path_b_slot.js'],
  ['C', 'path_c_group_confirm.js'],
  ['D', 'path_d_self_cancel.js'],
  ['E', 'path_e_promotion.js'],
  ['F', 'path_f_mgm.js'],
  ['G', 'path_g_learning_history.js'],
  ['H', 'path_h_transfer.js'],
];

const results = [];
for (const [tag, file] of PATHS) {
  const r = spawnSync('node', [path.join(__dirname, file)], { stdio: 'inherit' });
  results.push({ tag, ok: r.status === 0 });
}

console.log('\n=== E2E summary ===');
for (const r of results) console.log(` Path ${r.tag}: ${r.ok ? '✅ PASS' : '❌ FAIL'}`);
const failed = results.filter((r) => !r.ok).length;
process.exit(failed === 0 ? 0 : 1);
