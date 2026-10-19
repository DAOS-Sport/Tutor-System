'use strict';
// MCP 金鑰驗證：掛真的 createMcpRouter，不連 DB。
// 驗的是對外看得到的結果（狀態碼與回應內容），改用固定時間比對前後必須完全相同。
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require(require.resolve('express', { paths: [path.join(__dirname, '../server')] }));
const { createMcpRouter } = require('../server/mcp');

const KEY = 'test-mcp-key-0123456789';
const UNAUTHORIZED = { error: '認證失敗：Authorization: Bearer <MCP_API_KEY>' };
const NOT_CONFIGURED = { error: 'MCP 未設定：請在 Replit Secrets 加入 MCP_API_KEY' };

const app = express();
app.use('/mcp', createMcpRouter());
// 驗證通過後，沒有對應路由的請求會落到這裡；用來證明「進到下一層」。
app.use('/mcp', (req, res) => res.status(299).json({ passed: true }));

function get(server, headers) {
  return new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path: '/mcp/__auth_probe', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    }).on('error', reject);
  });
}

(async () => {
  const server = app.listen(0);
  const original = process.env.MCP_API_KEY;
  try {
    process.env.MCP_API_KEY = KEY;

    const ok = await get(server, { authorization: `Bearer ${KEY}` });
    assert.deepEqual([ok.status, ok.json], [299, { passed: true }], '正確金鑰要進到下一層');

    const cases = {
      錯誤金鑰: { authorization: `Bearer ${KEY.slice(0, -1)}X` },
      長度較短: { authorization: `Bearer ${KEY.slice(0, -3)}` },
      長度較長: { authorization: `Bearer ${KEY}extra` },
      少了Bearer前綴: { authorization: KEY },
      沒有Authorization: {},
      // 字元數與金鑰相同、位元組數不同（é 在 UTF-8 佔 2 bytes）：不可讓比對丟例外
      同字數不同位元組: { authorization: `Bearer ${'é'.repeat(KEY.length)}` },
    };
    for (const [label, headers] of Object.entries(cases)) {
      const r = await get(server, headers);
      assert.deepEqual([r.status, r.json], [401, UNAUTHORIZED], `${label} 要回 401 且內容不變`);
    }

    delete process.env.MCP_API_KEY;
    const none = await get(server, { authorization: `Bearer ${KEY}` });
    assert.deepEqual([none.status, none.json], [503, NOT_CONFIGURED], '沒設 MCP_API_KEY 要回 503 且內容不變');

    console.log('PASS MCP 金鑰驗證：正確→下一層、錯誤／長度不同／缺 header→401、未設定→503');
  } finally {
    if (original === undefined) delete process.env.MCP_API_KEY; else process.env.MCP_API_KEY = original;
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
