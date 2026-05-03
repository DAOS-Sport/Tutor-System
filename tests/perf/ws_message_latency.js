// 量測 /ws ping → pong 往返延遲（自動 mint parent JWT + 取一個 chat_room.id）
// 不需 LIFF；用 server JWT_SECRET 直接簽 parent token，與 production verify 路徑一致。
const path = require('path');
const jwt = require('../../server/node_modules/jsonwebtoken');
const { Client } = require('../../server/node_modules/pg');
let WS;
try { WS = require('../../server/node_modules/ws'); }
catch { console.error('需 ws 套件'); process.exit(2); }

const N = Number(process.env.N || 100);
const BASE = (process.env.WS_URL || 'ws://localhost:3000/ws');

(async () => {
  const SECRET = process.env.JWT_SECRET;
  if (!SECRET) { console.error('FATAL: JWT_SECRET 未設定'); process.exit(2); }

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const r = await pg.query(
    `SELECT cr.id AS room_id, p.id AS parent_id, p.phone
       FROM chat_rooms cr
       JOIN course_periods cp ON cp.id = cr.course_period_id
       JOIN course_period_enrollments cpe ON cpe.course_period_id=cp.id AND cpe.status='active'
       JOIN students s ON s.id=cpe.student_id
       JOIN parents p ON p.id=s.parent_id
      LIMIT 1`,
  );
  await pg.end();
  if (!r.rowCount) { console.error('無可用 chat_room+parent 種子，請至少建立一筆 active period+chat_room'); process.exit(2); }
  const { room_id, parent_id, phone } = r.rows[0];

  const token = jwt.sign({ parentId: parent_id, phone, type: 'parent' }, SECRET, { expiresIn: '15m' });
  const url = `${BASE}?token=${encodeURIComponent(token)}&room=${encodeURIComponent(room_id)}`;

  const ws = new WS(url);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    ws.on('close', (c, why) => rej(new Error(`closed ${c} ${why}`)));
  });

  const samples = [];
  for (let i = 0; i < N; i++) {
    const t = Date.now();
    await new Promise((res, rej) => {
      const handler = (raw) => {
        try { const m = JSON.parse(String(raw));
          if (m && m.type === 'pong') { samples.push(Date.now() - t); ws.off('message', handler); res(); }
        } catch {}
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ type: 'ping', i }));
      setTimeout(() => { ws.off('message', handler); rej(new Error('pong timeout')); }, 5000);
    });
  }
  ws.close();

  samples.sort((a, b) => a - b);
  const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  console.log(`ws ping/pong samples=${samples.length}  P50=${p(0.5)}ms  P95=${p(0.95)}ms  P99=${p(0.99)}ms`);
  process.exit(p(0.95) < 200 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
