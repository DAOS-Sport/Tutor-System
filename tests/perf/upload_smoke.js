// 媒體上傳成功率：對 POST /api/learn/uploads（教練 JWT 必填）連續 N 次
// 使用：BASE_URL + COACH_JWT 環境變數；不給 COACH_JWT 則退回測 chat upload，
// 兩者皆缺則明顯失敗（exit 2）讓 CI 不會誤判通過。
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const COACH = process.env.COACH_JWT || '';
const PARENT = process.env.PARENT_JWT || '';
const ROOM = process.env.ROOM_ID || '';
const N = Number(process.env.N || 100);

(async () => {
  if (!COACH && !(PARENT && ROOM)) {
    console.error('FATAL: 需要 COACH_JWT 或 (PARENT_JWT + ROOM_ID)；請從 LIFF 拿 token 後設定環境變數重跑。');
    process.exit(2);
  }

  const url = COACH
    ? `${BASE}/api/learn/uploads`
    : `${BASE}/api/chat/rooms/${encodeURIComponent(ROOM)}/upload`;
  const auth = COACH || PARENT;

  const fakeJpg = Buffer.from(Array.from({ length: 200 * 1024 }, (_v, i) => i & 0xff));
  let ok = 0, fail = 0;
  for (let i = 0; i < N; i++) {
    const fd = new FormData();
    fd.append('file', new Blob([fakeJpg], { type: 'image/jpeg' }), `t${i}.jpg`);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth}` },
        body: fd,
      });
      if (r.ok) ok++; else { fail++; if (i === 0) console.warn('first response:', r.status, await r.text().catch(()=>'')); }
    } catch (e) { fail++; if (i === 0) console.warn('first error:', e.message); }
  }
  const rate = (ok / (ok + fail)) * 100;
  console.log(`uploads ok=${ok} fail=${fail} success=${rate.toFixed(2)}%`);
  process.exit(rate >= 99 ? 0 : 1);
})();
