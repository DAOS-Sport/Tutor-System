/**
 * Ragic Webhook 的請求內容解析（純函式，無 DB／網路）。
 *
 * Ragic 文件只寫內容：預設是編號陣列 [1,2,4]；勾「發送更改記錄的完整內容」時是
 * { data: [...], eventType, ... }。**沒寫 Content-Type**。全域的 express.json() 只認
 * application/json；Ragic 若用 text/plain、表單格式或不標，內容就沒被解析 → 找不到編號 → 400，
 * 而且被拒的請求什麼都沒留下（2026-09-23 發布後「在 Ragic 改了資料卻沒進來」）。
 * 所以 webhook 路由改掛在全域 parser 之前、一律讀原始文字，由這裡統一解析。
 */

// 回傳交給 ragicAdmin.handleRagicWebhook 的 body：陣列（編號）或物件（完整內容格式）；看不懂回 {}。
function parseWebhookBody(raw) {
  // 保險：若前面已有 parser 解析過（例如掛載順序被改回去），原樣交出去
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const text = (Buffer.isBuffer(raw) ? raw.toString('utf8') : (typeof raw === 'string' ? raw : '')).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0) return [String(parsed)];
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 不是 JSON：只接受純數字清單「1,2,4」，其餘一律不猜
  }
  if (/^\d+(\s*,\s*\d+)*$/.test(text)) return text.split(',').map((s) => s.trim());
  return {};
}

// 從解析後的 body 取出 Ragic record id（編號陣列、{data:[{_ragicId}]}、單筆欄位三種形式）。
// 原本寫在 ragicAdmin.js 的 _extractWebhookRecordIds，搬來這裡讓「原始文字 → 編號」整段能不連 DB 測試。
function extractWebhookRecordIds(body) {
  if (Array.isArray(body)) return [...new Set(body.map((v) => String(v?._ragicId ?? v?.ragicId ?? v?.id ?? v ?? '').trim()).filter(Boolean))];
  const out = [];
  const add = (v) => {
    const s = String(v ?? '').trim();
    if (s) out.push(s);
  };
  for (const item of (Array.isArray(body?.data) ? body.data : [])) {
    add(item?._ragicId ?? item?.ragicId ?? item?.id);
  }
  add(body?._ragicId ?? body?.ragicId ?? body?.id ?? body?.nodeId ?? body?.recordId);
  return [...new Set(out)];
}

// 只描述形狀，給請求紀錄用（不存內容本身，內容可能含個資）
function describeBody(body) {
  if (Array.isArray(body)) return 'array';
  if (body && typeof body === 'object') return Object.keys(body).length ? 'object' : 'empty';
  return 'empty';
}

module.exports = { parseWebhookBody, extractWebhookRecordIds, describeBody };
