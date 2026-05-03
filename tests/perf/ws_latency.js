// 量測 WebSocket 訊息延遲：對 /ws 發 100 個 ping → 期待 pong → 計 P50/P95
// 連線需要 parent JWT + room id；提供方式：環境變數 PARENT_JWT + ROOM_ID
// 若沒提供，腳本會以「TCP / WS handshake roundtrip」作為粗估指標，並印出警告。
const WS_BASE = process.env.WS_URL || 'ws://localhost:3000/ws';
const TOKEN = process.env.PARENT_JWT || '';
const ROOM = process.env.ROOM_ID || '';
const N = Number(process.env.N || 100);

(async () => {
  let WebSocket;
  try { WebSocket = require('ws'); }
  catch { console.error('ws 套件未安裝；請 `cd server && npm i ws` 後重跑'); process.exit(2); }

  const url = TOKEN && ROOM
    ? `${WS_BASE}?token=${encodeURIComponent(TOKEN)}&room=${encodeURIComponent(ROOM)}`
    : WS_BASE;

  if (!TOKEN || !ROOM) {
    console.warn('⚠ 未提供 PARENT_JWT/ROOM_ID — 改測 handshake roundtrip（無法量訊息延遲）');
    const samples = [];
    for (let i = 0; i < Math.min(N, 30); i++) {
      const t = Date.now();
      await new Promise((res) => {
        const ws = new WebSocket(url);
        ws.on('open', () => { samples.push(Date.now() - t); ws.close(); res(); });
        ws.on('close', () => res());
        ws.on('error', () => { samples.push(Date.now() - t); res(); });
      });
    }
    samples.sort((a, b) => a - b);
    const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
    console.log(`handshake samples=${samples.length}  P50=${p(0.5)}ms  P95=${p(0.95)}ms`);
    process.exit(samples.length === 0 ? 1 : 0);
  }

  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.on('open', res); ws.on('error', rej);
    ws.on('close', (code, reason) => rej(new Error(`closed ${code} ${reason}`)));
  });
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t = Date.now();
    await new Promise((res, rej) => {
      const handler = (raw) => {
        try { const m = JSON.parse(raw); if (m.type === 'pong') { samples.push(Date.now() - t); ws.off('message', handler); res(); } } catch {}
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ type: 'ping', i }));
      setTimeout(() => { ws.off('message', handler); rej(new Error('pong timeout')); }, 5000);
    });
  }
  ws.close();
  samples.sort((a, b) => a - b);
  const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  console.log(`ping samples=${samples.length}  P50=${p(0.5)}ms  P95=${p(0.95)}ms  P99=${p(0.99)}ms`);
  process.exit(p(0.95) < 200 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
