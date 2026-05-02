/**
 * 聊天訊息關鍵字掃描（F-A07 / F-M03）
 *
 * - 從 keyword_list 讀取「啟用中」關鍵字，做不分大小寫的子字串比對
 * - 命中時：插入 keyword_alerts (status=pending) 並回傳命中清單給呼叫方
 *
 * 快取策略：
 * - 模組內維持 in-memory 字典 + 30s TTL，避免每筆訊息都打 DB
 * - 呼叫 invalidateCache() 讓 admin keywords CRUD 立即生效
 */
const { pool } = require('../models/db');

let CACHE = null;
let CACHE_AT = 0;
const TTL_MS = 30 * 1000;

async function loadActiveKeywords() {
  const now = Date.now();
  if (CACHE && now - CACHE_AT < TTL_MS) return CACHE;
  const r = await pool.query(
    `SELECT keyword, category FROM keyword_list WHERE is_active = TRUE`
  );
  CACHE = r.rows.map((row) => ({
    keyword: String(row.keyword || ''),
    keywordLower: String(row.keyword || '').toLowerCase().trim(),
    category: row.category,
  })).filter((k) => k.keywordLower.length > 0);
  CACHE_AT = now;
  return CACHE;
}

function invalidateCache() {
  CACHE = null;
  CACHE_AT = 0;
}

/**
 * 掃描單則訊息文字內容，回傳命中關鍵字清單
 * @param {string} content
 * @returns {Promise<Array<{keyword:string,category:string}>>}
 */
async function scanContent(content) {
  if (!content || typeof content !== 'string') return [];
  const text = content.toLowerCase();
  const list = await loadActiveKeywords();
  const hits = [];
  const seen = new Set();
  for (const item of list) {
    if (text.includes(item.keywordLower) && !seen.has(item.keyword)) {
      hits.push({ keyword: item.keyword, category: item.category });
      seen.add(item.keyword);
    }
  }
  return hits;
}

/**
 * 對訊息掃描並寫入 keyword_alerts；回傳 alert 列（可拿去推 Flex 給主管）
 */
async function scanAndAlert({ messageId, chatRoomId, content }) {
  const hits = await scanContent(content);
  if (!hits.length) return [];
  const alerts = [];
  for (const h of hits) {
    const r = await pool.query(
      `INSERT INTO keyword_alerts (chat_room_id, message_id, triggered_keyword, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, triggered_keyword, status, created_at`,
      [chatRoomId, messageId, h.keyword]
    );
    alerts.push({ ...r.rows[0], category: h.category });
  }
  return alerts;
}

module.exports = { scanContent, scanAndAlert, invalidateCache };
