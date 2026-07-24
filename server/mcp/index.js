/**
 * DAOS Workspace MCP Server
 *
 * 讓 Claude Desktop / Claude.ai 透過 MCP 連線，對本 Replit 工作區執行
 * 讀檔、寫檔、搜尋、執行指令等操作，權限與 Replit Agent 相同。
 *
 * 認證：Authorization: Bearer <MCP_API_KEY>
 * 端點：
 *   GET  /mcp        → SSE transport（Claude.ai / 舊版 Claude Desktop）
 *   POST /mcp        → StreamableHTTP transport（新版 Claude Desktop ≥ 0.7）
 *   POST /mcp/messages?sessionId=<id>  → SSE message 回傳
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const execFileAsync = promisify(execFile);

// 工作區根目錄（所有路徑都鎖在這裡面）
const WORKSPACE = '/home/runner/workspace';

// ── 路徑安全 ─────────────────────────────────────────────────────────
function resolveSafe(userPath) {
  // 把 userPath 視為相對於 WORKSPACE 的路徑（也可以接受絕對路徑）
  const abs = path.isAbsolute(userPath)
    ? userPath
    : path.join(WORKSPACE, userPath);
  const resolved = path.resolve(abs);
  if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`路徑越界（必須在 ${WORKSPACE} 以內）：${userPath}`);
  }
  return resolved;
}

function toRelative(abs) {
  return abs.startsWith(WORKSPACE) ? abs.slice(WORKSPACE.length + 1) : abs;
}

// ── MCP Server 工廠 ──────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({
    name: 'daos-workspace',
    version: '1.0.0',
  });

  // ── 工具 1：read_file ────────────────────────────────────────────
  server.tool(
    'read_file',
    '讀取工作區檔案內容。可指定起始行（1-indexed）與行數上限，適合大檔案分頁讀取。',
    {
      path: z.string().describe('相對於工作區根目錄的檔案路徑，例如 server/index.js'),
      offset: z.number().int().min(1).optional().describe('從第幾行開始讀（1-indexed，預設第 1 行）'),
      limit: z.number().int().min(1).max(2000).optional().describe('最多讀幾行（預設 500，最大 2000）'),
    },
    async ({ path: userPath, offset = 1, limit = 500 }) => {
      const abs = resolveSafe(userPath);
      const raw = await fs.promises.readFile(abs, 'utf8');
      const lines = raw.split('\n');
      const start = offset - 1;
      const slice = lines.slice(start, start + limit);
      const totalLines = lines.length;
      const header = `# ${toRelative(abs)} (${totalLines} 行，顯示 ${start + 1}–${Math.min(start + limit, totalLines)} 行)\n`;
      return { content: [{ type: 'text', text: header + slice.join('\n') }] };
    },
  );

  // ── 工具 2：write_file ───────────────────────────────────────────
  server.tool(
    'write_file',
    '將 content 完整寫入（或覆寫）工作區檔案。會自動建立所需的父目錄。',
    {
      path: z.string().describe('目標檔案路徑（相對於工作區）'),
      content: z.string().describe('要寫入的完整內容'),
    },
    async ({ path: userPath, content }) => {
      const abs = resolveSafe(userPath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      return { content: [{ type: 'text', text: `已寫入 ${toRelative(abs)}（${bytes} bytes）` }] };
    },
  );

  // ── 工具 3：edit_file ────────────────────────────────────────────
  server.tool(
    'edit_file',
    '在檔案內做精確字串替換（需要包含足夠上下文讓 old_string 唯一）。replace_all=true 時替換全部相符。',
    {
      path: z.string().describe('目標檔案路徑（相對於工作區）'),
      old_string: z.string().describe('要被取代的原始文字（必須完全符合，含空白縮排）'),
      new_string: z.string().describe('取代後的新文字'),
      replace_all: z.boolean().optional().describe('是否替換所有相符（預設 false，只換第一個）'),
    },
    async ({ path: userPath, old_string, new_string, replace_all = false }) => {
      const abs = resolveSafe(userPath);
      const original = await fs.promises.readFile(abs, 'utf8');
      const count = original.split(old_string).length - 1;
      if (count === 0) throw new Error(`old_string 在檔案中找不到：${userPath}`);
      if (count > 1 && !replace_all) {
        throw new Error(`old_string 在檔案中出現 ${count} 次，請加入更多上下文使其唯一，或設 replace_all=true`);
      }
      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.replace(old_string, new_string);
      await fs.promises.writeFile(abs, updated, 'utf8');
      return { content: [{ type: 'text', text: `已修改 ${toRelative(abs)}（替換 ${replace_all ? count : 1} 處）` }] };
    },
  );

  // ── 工具 4：list_directory ───────────────────────────────────────
  server.tool(
    'list_directory',
    '列出目錄內容（含類型、大小、修改時間）。',
    {
      path: z.string().optional().describe('目錄路徑（相對於工作區，預設為根目錄）'),
    },
    async ({ path: userPath = '.' }) => {
      const abs = resolveSafe(userPath);
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      const lines = await Promise.all(
        entries.map(async (e) => {
          try {
            const full = path.join(abs, e.name);
            const stat = await fs.promises.stat(full);
            const type = e.isDirectory() ? 'd' : '-';
            const size = e.isDirectory() ? '' : ` (${(stat.size / 1024).toFixed(1)} KB)`;
            const mtime = stat.mtime.toISOString().slice(0, 10);
            return `${type} ${e.name}${size}  [${mtime}]`;
          } catch {
            return `? ${e.name}`;
          }
        }),
      );
      lines.sort();
      const header = `# ${toRelative(abs) || '.'} — ${lines.length} 個項目\n`;
      return { content: [{ type: 'text', text: header + lines.join('\n') }] };
    },
  );

  // ── 工具 5：run_shell ────────────────────────────────────────────
  server.tool(
    'run_shell',
    '在工作區根目錄執行 bash 指令。timeout_ms 預設 60000（60 秒），最大 120000。',
    {
      command: z.string().describe('要執行的 shell 指令'),
      timeout_ms: z.number().int().min(1000).max(120000).optional().describe('逾時毫秒數（預設 60000）'),
    },
    async ({ command, timeout_ms = 60000 }) => {
      console.log(`[MCP/run_shell] ${command.slice(0, 200)}`);
      try {
        const { stdout, stderr } = await execFileAsync(
          'bash', ['-c', command],
          { cwd: WORKSPACE, timeout: timeout_ms, maxBuffer: 4 * 1024 * 1024 },
        );
        const out = (stdout || '').slice(0, 8000);
        const err = (stderr || '').slice(0, 2000);
        let text = out;
        if (err) text += `\n--- stderr ---\n${err}`;
        return { content: [{ type: 'text', text: text || '（無輸出）' }] };
      } catch (e) {
        const out = (e.stdout || '').slice(0, 4000);
        const err = (e.stderr || '').slice(0, 2000);
        throw new Error(`指令失敗（exit ${e.code}）\n${out}\n${err}`);
      }
    },
  );

  // ── 工具 6：search_code ──────────────────────────────────────────
  server.tool(
    'search_code',
    '用 ripgrep 在工作區搜尋字串或正規表達式。回傳帶行號的符合行。',
    {
      pattern: z.string().describe('要搜尋的字串或正規表達式（ripgrep 語法）'),
      path: z.string().optional().describe('限定搜尋目錄或檔案（相對於工作區，預設搜全域）'),
      glob: z.string().optional().describe('檔案 glob 過濾，例如 "*.js" 或 "**/*.tsx"'),
      case_insensitive: z.boolean().optional().describe('是否不分大小寫（預設 false）'),
      max_results: z.number().int().min(1).max(500).optional().describe('最多回傳幾行（預設 100）'),
    },
    async ({ pattern, path: userPath, glob, case_insensitive = false, max_results = 100 }) => {
      const searchRoot = userPath ? resolveSafe(userPath) : WORKSPACE;
      const args = [
        '--line-number',
        '--no-heading',
        '--color=never',
        `--max-count=${max_results}`,
      ];
      if (case_insensitive) args.push('--ignore-case');
      if (glob) args.push('--glob', glob);
      // 排除 node_modules / .git / build 產物
      args.push(
        '--glob=!node_modules/**',
        '--glob=!.git/**',
        '--glob=!server/public/**',
        '--glob=!dist/**',
        '--glob=!.local/bin/**',
        '--glob=!.local/state/**',
      );
      args.push(pattern, searchRoot);
      try {
        const { stdout } = await execFileAsync('rg', args, {
          cwd: WORKSPACE,
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024,
        });
        const lines = (stdout || '').trim().split('\n').slice(0, max_results);
        // 把絕對路徑縮短為相對路徑
        const out = lines.map(l => l.replace(WORKSPACE + '/', '')).join('\n');
        return { content: [{ type: 'text', text: out || '（無符合結果）' }] };
      } catch (e) {
        if (e.code === 1) return { content: [{ type: 'text', text: '（無符合結果）' }] };
        throw new Error(`搜尋失敗：${e.message}`);
      }
    },
  );

  // ── 工具 7：delete_file ──────────────────────────────────────────
  server.tool(
    'delete_file',
    '刪除工作區內的檔案（不可還原，請確認路徑）。',
    {
      path: z.string().describe('要刪除的檔案路徑（相對於工作區）'),
    },
    async ({ path: userPath }) => {
      const abs = resolveSafe(userPath);
      const stat = await fs.promises.stat(abs);
      if (stat.isDirectory()) throw new Error('請用 run_shell rm -rf 刪除目錄');
      await fs.promises.unlink(abs);
      return { content: [{ type: 'text', text: `已刪除 ${toRelative(abs)}` }] };
    },
  );

  return server;
}

// ── Express Router ────────────────────────────────────────────────────
function createMcpRouter() {
  const express = require('express');
  const router = express.Router();

  // SSE transport 的 session 管理（GET /mcp → SSE，POST /mcp/messages → message）
  const sseSessions = new Map();

  // ── GET /mcp/info → 快速確認 MCP 是否活著（不需 auth，放在 auth 前）
  router.get('/info', (req, res) => {
    res.json({
      name: 'daos-workspace',
      version: '1.0.0',
      transport: ['sse', 'streamable-http'],
      auth: 'Bearer token (MCP_API_KEY)',
      tools: ['read_file', 'write_file', 'edit_file', 'list_directory', 'run_shell', 'search_code', 'delete_file'],
      workspace: WORKSPACE,
      mcp_configured: !!process.env.MCP_API_KEY,
    });
  });

  // Auth middleware（/info 之外的所有端點）
  router.use((req, res, next) => {
    const key = process.env.MCP_API_KEY;
    if (!key) {
      return res.status(503).json({ error: 'MCP 未設定：請在 Replit Secrets 加入 MCP_API_KEY' });
    }
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${key}`) {
      return res.status(401).json({ error: '認證失敗：Authorization: Bearer <MCP_API_KEY>' });
    }
    next();
  });

  // ── GET /mcp → SSE transport（Claude.ai / 舊版 Claude Desktop）
  router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    const transport = new SSEServerTransport('/mcp/messages', res);
    sseSessions.set(transport.sessionId, transport);
    transport.onclose = () => sseSessions.delete(transport.sessionId);
    const mcpServer = createMcpServer();
    try {
      await mcpServer.connect(transport);
    } catch (err) {
      console.error('[MCP/SSE] connect error:', err.message);
      sseSessions.delete(transport.sessionId);
    }
  });

  // ── POST /mcp/messages → SSE session message handler
  router.post('/messages', express.json(), async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = sseSessions.get(sessionId);
    if (!transport) {
      return res.status(404).json({ error: `Session 不存在：${sessionId}` });
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      console.error('[MCP/SSE/messages] error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // ── StreamableHTTP session 管理（POST /mcp 必須用同一個 transport 實例跨請求）
  // SDK validateSession：_initialized=false 時任何非 initialize 請求都丟 400。
  // 修法：session Map 存 transport 實例；initialize → 建新 transport 並存入 Map；
  // 後續請求帶 mcp-session-id header → 從 Map 取出舊 transport 繼續用；
  // 無 session 且非 initialize → 回友善的 JSON-RPC 400（不是 500）。
  const httpSessions = new Map();

  // ── OPTIONS /mcp → CORS preflight（不需 auth）
  router.options('/', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept');
    res.status(204).end();
  });

  // ── POST /mcp → StreamableHTTP transport（新版 Claude Desktop ≥ 0.7）
  router.post('/', express.json(), async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    // 帶 session id → 路由至既有 transport
    if (sessionId) {
      const existing = httpSessions.get(sessionId);
      if (!existing) {
        const body = req.body;
        return res.status(404).json({
          jsonrpc: '2.0',
          id: (body && !Array.isArray(body)) ? (body.id ?? null) : null,
          error: { code: -32000, message: `Session 不存在或已過期：${sessionId}` },
        });
      }
      try {
        await existing.handleRequest(req, res, req.body);
      } catch (err) {
        console.error('[MCP/HTTP/session] error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
      }
      return;
    }

    // 無 session id → 只允許 initialize（或批次中含 initialize）
    const body = req.body;
    const msgs = Array.isArray(body) ? body : [body];
    const isInit = msgs.some(m => m && m.method === 'initialize');

    if (!isInit) {
      // 探測請求 / 重連嘗試：回 400 JSON-RPC 而非 express 預設的 Cannot POST
      return res.status(400).json({
        jsonrpc: '2.0',
        id: (!Array.isArray(body) && body) ? (body.id ?? null) : null,
        error: {
          code: -32600,
          message: '尚未初始化連線：請先送 initialize 請求，後續請求需在 header 帶 Mcp-Session-Id',
        },
      });
    }

    // initialize → 建立新 transport 並存入 session Map
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => require('crypto').randomUUID(),
      onsessioninitialized: (id) => {
        httpSessions.set(id, transport);
        console.log(`[MCP/HTTP] session opened: ${id} (total: ${httpSessions.size})`);
      },
      onsessionclosed: (id) => {
        httpSessions.delete(id);
        console.log(`[MCP/HTTP] session closed: ${id} (total: ${httpSessions.size})`);
      },
    });

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MCP/HTTP] initialize error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // ── DELETE /mcp → 終止 session（標準 MCP session termination）
  router.delete('/', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) {
      const existing = httpSessions.get(sessionId);
      if (existing) {
        try { await existing.close(); } catch { /* ignore */ }
        httpSessions.delete(sessionId);
        console.log(`[MCP/HTTP] session terminated by client: ${sessionId}`);
      }
    }
    res.status(200).end();
  });

  return router;
}

module.exports = { createMcpRouter };
