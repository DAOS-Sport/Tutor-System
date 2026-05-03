// Ragic 高併發快取驗證（H01/H05 熱讀路徑）
// 策略：把 ragic.js 內部 axios.get monkeypatch 成計次 stub，
// 然後對 4 條函數各跑 N 次並發，量「外部呼叫次數」+「快取命中率」。
// 驗收：外部呼叫應 ≈ 函數數量（每條函數首載 1 次），命中率 ≥ 95%。
const Module = require('module');
let extCalls = 0;
const origLoad = Module._load;
Module._load = function (req, parent) {
  if (req === 'axios' && parent && parent.id && parent.id.endsWith('services/ragic.js')) {
    return {
      create: () => ({
        get: async () => { extCalls++; return { data: { __stub: extCalls } }; },
      }),
    };
  }
  return origLoad.apply(this, arguments);
};
delete require.cache[require.resolve('../../server/services/ragic')];
process.env.RAGIC_BASE_URL = process.env.RAGIC_BASE_URL || 'http://stub';
process.env.RAGIC_API_KEY = process.env.RAGIC_API_KEY || 'stub';
process.env.RAGIC_FORM_H01 = process.env.RAGIC_FORM_H01 || '/h01';
process.env.RAGIC_FORM_H05 = process.env.RAGIC_FORM_H05 || '/h05';
const ragic = require('../../server/services/ragic');

(async () => {
  const fns = [
    ['getActiveCoaches', ragic.getActiveCoaches],
    ['getCounterStaff', ragic.getCounterStaff],
    ['getAllStaff', ragic.getAllStaff],
    ['getActiveVenues', ragic.getActiveVenues],
  ].filter(([, f]) => typeof f === 'function');
  if (!fns.length) { console.error('FATAL: 無熱讀函數'); process.exit(2); }

  const N = 100;
  // 先暖機 1 次，確認外部呼叫不超過函數數
  for (const [, fn] of fns) await fn().catch(() => {});
  const baseline = extCalls;
  console.log(`暖機後外部呼叫 = ${baseline}（預期 = ${fns.length}）`);

  // 高併發階段
  extCalls = 0;
  const tasks = [];
  for (let i = 0; i < N; i++) for (const [, fn] of fns) tasks.push(fn().catch(() => null));
  const t0 = Date.now();
  await Promise.all(tasks);
  const elapsed = Date.now() - t0;

  const total = N * fns.length;
  const hit = ((1 - extCalls / total) * 100).toFixed(1);
  console.log(`stress: ${total} requests / ${elapsed}ms`);
  console.log(`  暖機後外部呼叫 = ${extCalls}（預期 0；快取應吸收所有讀取）`);
  console.log(`  快取命中率 = ${hit}%（門檻 ≥ 95%）`);
  if (extCalls > 0 || baseline > fns.length) {
    console.error('✗ 快取未生效');
    process.exit(1);
  }
  console.log('✓ 快取生效，Ragic 高併發保護通過');
})().catch((e) => { console.error(e); process.exit(1); });
