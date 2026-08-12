/**
 * 「乖乖坐鎮」—— 未授權存取內部 API 時回的東西。
 *
 * 為什麼不是單純回 401 JSON：這幾支端點的網址會被人直接貼進瀏覽器（同事、
 * 好奇的家長、掃描器都有）。回一頁看得懂的說明，比一行 {"error":"Unauthorized"}
 * 更能讓人知道「這裡本來就不對外，不是壞掉了」，也不會讓人以為找到了什麼漏洞。
 *
 * 但機器要拿到機器看得懂的東西。所以用 Accept 內容協商：
 *   瀏覽器（Accept 含 text/html）→ 這頁
 *   其他（fetch / curl / SDK）    → 原本的 JSON 401
 * 兩者的狀態碼都是 401，不因為好看就把它變成 200 —— 監控與前端的重試邏輯
 * 都靠狀態碼判斷，那個不能動。
 */

// 乖乖的點陣圖。綠色包裝、小男孩、下方那塊白色標籤區。
// 用等寬字型 <pre> 呈現；不用 box-drawing 以外的裝飾字元，避免在某些字型下錯位。
const GUAI_GUAI = String.raw`
        ┌──────────────────────────────┐
        │  ╭─────╮                     │
        │  │ ● ● │   乖 乖   造 句 包  │
        │  │  ‿  │   ────────────────  │
        │  ╰──┬──╯   奶 油 椰 子 口 味 │
        │   ╱─┴─╲                      │
        │  ╱     ╲                     │
        │ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
        │ ┃                          ┃ │
        │ ┃        乖    乖          ┃ │
        │ ┃                          ┃ │
        │ ┃  ──────────────────────  ┃ │
        │ ┃  ──────────────────────  ┃ │
        │ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │
        └──────────────────────────────┘

             乖乖坐鎮，機器運作正常。
             但這支 API 不對外開放。
`;

function wantsHtml(req) {
  // 只認明確要 HTML 的請求。curl 預設送的那個萬用 Accept 走 JSON ——
  // 拿萬用字元當成「是瀏覽器」會讓所有 API 客戶端都收到一頁 HTML。
  const accept = String(req.get('accept') || '');
  return accept.includes('text/html');
}

function html(message) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>401 — 這支 API 不對外開放</title>
<style>
  html,body{margin:0;height:100%;background:#0f1115;color:#8fbf3f;
    font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;}
  main{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;}
  pre{margin:0;font-size:13px;line-height:1.35;white-space:pre;}
  .note{color:#6b7280;font-size:12px;margin-top:18px;line-height:1.7;}
  @media (max-width:560px){pre{font-size:10px;}}
</style></head>
<body><main><div>
<pre>${esc(GUAI_GUAI)}</pre>
<div class="note">${esc(message)}<br>需要資料請從系統內登入後使用。</div>
</div></main></body></html>`;
}

/**
 * 回 401。瀏覽器拿到乖乖，程式拿到 JSON。
 * @param {string} [message] 給人看的說明；JSON 版用 error 欄位帶同一句
 */
function deny(req, res, message = '這支 API 需要登入後才能使用。') {
  if (wantsHtml(req)) {
    return res.status(401).type('html').send(html(message));
  }
  return res.status(401).json({ error: message, code: 'UNAUTHORIZED' });
}

module.exports = { deny, wantsHtml, GUAI_GUAI };
