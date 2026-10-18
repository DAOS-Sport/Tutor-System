/**
 * 前端診斷回報通道的驗證。
 *
 * 這是一個「不需要登入就能寫進資料庫」的端點，所以重點不只是它會不會動，
 * 更是它會不會被拿來灌爆：欄位白名單、長度上限、筆數上限、限流。
 */
const { pool } = require('../models/db');

const BASE = process.env.DIAG_BASE || 'http://localhost:3001';
const URL = BASE + '/api/diagnostics/client';

let pass = 0, fail = 0;
const problems = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; problems.push(label + (detail ? '  → ' + detail : '')); console.log('  FAIL ' + label); }
};

const post = async (body, raw) => {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  return r.status;
};

const countSince = async (t) => (await pool.query(
  'SELECT count(*)::int n FROM client_diagnostics WHERE created_at > $1', [t])).rows[0].n;

(async () => {
  console.log('=== 表建起來了嗎 ===');
  const cols = (await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='client_diagnostics' ORDER BY ordinal_position`)).rows.map(r => r.column_name);
  console.log('  欄位：' + cols.join(', '));
  ok('client_diagnostics 存在', cols.length > 0);

  const t0 = new Date();

  console.log('');
  console.log('=== A. 正常回報 ===');
  const s1 = await post({
    kind: 'picker_closed_without_pick',
    reason: '選過年或月之後，面板在未選到日期前關閉',
    path: '/liff/register',
    events: ['選了年：2012', '選了月：2', '守門攔下（body）', '★ 判定為點到外面 → 關閉（body）'],
  });
  ok('回 204', s1 === 204, 'HTTP ' + s1);
  await new Promise(r => setTimeout(r, 300));
  const row = (await pool.query(
    `SELECT kind, reason, path, events, length(user_agent) AS ua_len
       FROM client_diagnostics WHERE created_at > $1 ORDER BY id DESC LIMIT 1`, [t0])).rows[0];
  console.log('  存進去的：' + JSON.stringify(row));
  ok('有寫進資料庫', !!row);
  ok('事件序列完整保留', row && Array.isArray(row.events) && row.events.length === 4,
     JSON.stringify(row?.events));

  console.log('');
  console.log('=== B. 不在白名單的 kind 一律丟棄 ===');
  const before = await countSince(t0);
  const s2 = await post({ kind: '亂寫的種類', events: ['x'] });
  await new Promise(r => setTimeout(r, 300));
  ok('仍回 204（不給呼叫端任何線索）', s2 === 204, 'HTTP ' + s2);
  ok('沒有寫進資料庫', (await countSince(t0)) === before);

  console.log('');
  console.log('=== C. 灌超量：事件被截到 20 筆、字串被切短 ===');
  const s3 = await post({
    kind: 'picker_panel_never_shown',
    reason: 'R'.repeat(500),
    path: 'P'.repeat(500),
    events: Array.from({ length: 200 }, (_, i) => 'E'.repeat(500) + i),
  });
  await new Promise(r => setTimeout(r, 300));
  const big = (await pool.query(
    `SELECT jsonb_array_length(events) AS n, length(reason) AS r, length(path) AS p
       FROM client_diagnostics WHERE created_at > $1 ORDER BY id DESC LIMIT 1`, [t0])).rows[0];
  console.log('  存進去的：事件 ' + big.n + ' 筆、reason ' + big.r + ' 字、path ' + big.p + ' 字');
  ok('回 204', s3 === 204, 'HTTP ' + s3);
  ok('事件最多 20 筆', big.n <= 20, String(big.n));
  ok('reason 有上限', big.r <= 60, String(big.r));
  ok('path 有上限', big.p <= 120, String(big.p));

  console.log('');
  console.log('=== D. 壞掉的 body 不可以炸 ===');
  for (const [label, raw] of [['不是 JSON', 'hello'], ['空 body', ''], ['陣列', '[]'], ['null', 'null']]) {
    const st = await post(null, raw);
    ok(label + ' 不會 5xx', st < 500, 'HTTP ' + st);
  }

  console.log('');
  console.log('=== E. 限流（每 IP 5 分鐘 20 筆）===');
  let blocked = 0;
  const beforeFlood = await countSince(t0);
  for (let i = 0; i < 30; i++) {
    await post({ kind: 'picker_closed_without_pick', events: ['flood' + i] });
  }
  await new Promise(r => setTimeout(r, 400));
  const written = (await countSince(t0)) - beforeFlood;
  console.log('  送了 30 筆，實際寫入 ' + written + ' 筆');
  ok('超過額度就不再寫入', written < 30, String(written));

  console.log('');
  console.log('=== 收尾：刪掉這次的測試資料 ===');
  const del = await pool.query('DELETE FROM client_diagnostics WHERE created_at > $1', [t0]);
  console.log('  刪除 ' + del.rowCount + ' 筆');

  console.log('');
  console.log(pass + ' 通過 / ' + fail + ' 失敗');
  for (const p of problems) console.log('  ✗ ' + p);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('中斷：', e.message); process.exit(2); });

