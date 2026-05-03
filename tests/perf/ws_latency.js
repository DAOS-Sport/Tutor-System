// 量測 WebSocket 訊息延遲：連 100 條 ping、計算 P50/P95
// 假設後端 ws upgrade 路徑是 /ws/chat（與目前 chat 模組相同）
const WS_URL = (process.env.WS_URL) || 'ws://localhost:3000/ws/chat';
const N = Number(process.env.N || 100);

(async () => {
  let WebSocket;
  try { WebSocket = require('ws'); }
  catch { console.error('ws 套件未安裝；請 `npm i -g ws` 或在 server 目錄安裝後重跑'); process.exit(2); }

  const ws = new WebSocket(WS_URL);
  const samples = [];
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  for (let i = 0; i < N; i++) {
    const t = Date.now();
    await new Promise((res) => {
      ws.once('message', () => { samples.push(Date.now() - t); res(); });
      ws.send(JSON.stringify({ type: 'ping', i }));
    });
  }
  ws.close();
  samples.sort((a, b) => a - b);
  const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  console.log(`samples=${samples.length}  P50=${p(0.5)}ms  P95=${p(0.95)}ms  P99=${p(0.99)}ms`);
})().catch((e) => { console.error(e); process.exit(1); });
