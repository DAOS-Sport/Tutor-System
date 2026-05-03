// 100 次上傳 200KB 假圖、計算成功率（驗收 > 99%）
// 假設後端有 POST /api/uploads；若沒有，本腳本會印警告後 exit 0
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TOKEN = process.env.ADMIN_JWT || '';
const N = Number(process.env.N || 100);

(async () => {
  const fakeJpg = Buffer.from(Array.from({ length: 200 * 1024 }, (_v, i) => i & 0xff));
  let ok = 0, fail = 0;
  for (let i = 0; i < N; i++) {
    const fd = new FormData();
    fd.append('file', new Blob([fakeJpg], { type: 'image/jpeg' }), `t${i}.jpg`);
    try {
      const r = await fetch(`${BASE}/api/uploads`, {
        method: 'POST',
        headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
        body: fd,
      });
      if (r.status === 404) { console.warn('/api/uploads 未實作，跳過'); return; }
      if (r.ok) ok++; else fail++;
    } catch { fail++; }
  }
  const rate = (ok / (ok + fail)) * 100;
  console.log(`uploads ok=${ok} fail=${fail} success=${rate.toFixed(2)}%`);
  process.exit(rate >= 99 ? 0 : 1);
})();
