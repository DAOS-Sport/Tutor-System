/**
 * 整合 API 的服務金鑰認證（U16）。
 *
 * 用途：讓場館現場的外部前端（救生台頁面等）能查「這個場館現在有哪些課」，
 * 而不必給它後台帳號，也不必把上課紀錄做成公開端點。
 *
 * ── 為什麼不是公開 API ──
 * 上課紀錄是一份「誰、在哪、幾點、跟誰上課」的名冊，其中多數是未成年學員。
 * 公開端點的真正風險不是單筆外洩，是「可以整包枚舉、還能定時抓來看異動」——
 * tests/public_api_exposure_test.js 記的就是 GET /api/coaches 那次（165 筆教練
 * 名冊連同計價資訊整份端出去）。所以這裡從一開始就是：金鑰 + 場館綁定 + 強制篩選。
 *
 * ── 一把金鑰綁一個場館 ──
 * 金鑰放 Replit Secrets 的 INTEGRATION_KEYS（JSON）：
 *
 *   {
 *     "<32+ 字元隨機字串>": { "label": "三民高中救生台", "venue_ids": ["L"] },
 *     "<另一把>":          { "label": "松山國小救生台", "venue_ids": ["C"] }
 *   }
 *
 * 一台一把、一把只開一個場館：某台的金鑰外流，能看到的也只有那個場館當下的課，
 * 而且可以單獨換掉那一把，不影響其他場館。`venue_ids` 省略或設為 null 代表不限
 * 場館，那是給內部用的，發之前想清楚。
 *
 * 全程 fail-closed：沒設定 → 503；JSON 壞掉 → 503（不是放行）；金鑰不符 → 401。
 */
const crypto = require('crypto');
const { pool } = require('../models/db');

const RL_WINDOW_MS = 5 * 60 * 1000;
const RL_MAX = 60;                      // 每把金鑰 60 次 / 5 分鐘
const AUDIT_THROTTLE_MS = 10 * 60 * 1000; // 成功查詢每把金鑰最多 10 分鐘記一筆
const VENUE_FLAG_TTL_MS = 30 * 1000;      // 場館開關快取；現場頁面會定時刷新，不必每次打 DB

let cached = null;   // { raw, parsed }

/**
 * 解析 INTEGRATION_KEYS。回 null 代表沒設定或設定壞掉——兩者都必須擋，
 * 不可以因為「解析失敗」就當成沒有限制。
 * 以原始字串為快取鍵，Secrets 改了會自動重讀，不必重啟。
 */
function loadKeys() {
  const raw = process.env.INTEGRATION_KEYS;
  if (!raw || !raw.trim()) return null;
  if (cached && cached.raw === raw) return cached.parsed;
  let parsed = null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      parsed = new Map();
      for (const [key, cfg] of Object.entries(obj)) {
        if (typeof key !== 'string' || key.length < 32) continue;  // 太短的金鑰直接不收
        const venueIds = Array.isArray(cfg?.venue_ids)
          ? cfg.venue_ids.map(String).filter(Boolean)
          : null;
        parsed.set(key, {
          label: String(cfg?.label || '未命名整合').slice(0, 60),
          venueIds: venueIds && venueIds.length ? venueIds : null,
        });
      }
      if (!parsed.size) parsed = null;
    }
  } catch (e) {
    console.error('[integrationAuth] INTEGRATION_KEYS 解析失敗，一律拒絕：', e.message);
    parsed = null;
  }
  cached = { raw, parsed };
  return parsed;
}

// 定長比較，避免用字串相等比出時間差。
function sameKey(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const buckets = new Map();  // keyLabel → { count, windowStart }
function overRateLimit(label) {
  const now = Date.now();
  const rec = buckets.get(label);
  if (!rec || now - rec.windowStart > RL_WINDOW_MS) {
    buckets.set(label, { count: 1, windowStart: now });
    return false;
  }
  rec.count += 1;
  return rec.count > RL_MAX;
}

const lastAudit = new Map();  // label → ts
/**
 * 存取紀錄寫進既有的 audit_logs（不另開表）。
 *
 * 失敗一定記，成功則每把金鑰 10 分鐘最多記一筆彙總 —— 救生台頁面會定時刷新，
 * 每次都記會把 audit_logs 灌成噪音，反而讓真正的安全事件被埋掉。
 * best-effort：寫日誌失敗不能讓查詢掛掉。
 */
async function logAccess({ label, action, severity, details }) {
  try {
    if (severity === 'info') {
      const now = Date.now();
      const prev = lastAudit.get(label) || 0;
      if (now - prev < AUDIT_THROTTLE_MS) return;
      lastAudit.set(label, now);
    }
    await pool.query(
      `INSERT INTO audit_logs (action, severity, admin_id, target_type, target_ids, details)
       VALUES ($1, $2, $3, 'integration_sessions', '{}', $4)`,
      [action, severity, `整合:${label}`, JSON.stringify(details || {})]
    );
  } catch (e) {
    console.warn('[integrationAuth] 存取紀錄寫入失敗:', e.message);
  }
}

/**
 * Express 中介層。通過後掛上 req.integration = { label, venueIds }。
 * venueIds 為 null 代表不限場館（路由層仍然要求必須指定 venue_id，不允許裸列舉）。
 */
function requireIntegrationKey(req, res, next) {
  const keys = loadKeys();
  if (!keys) {
    return res.status(503).json({
      error: '整合 API 未啟用：請在 Replit Secrets 設定 INTEGRATION_KEYS',
      code: 'INTEGRATION_NOT_CONFIGURED',
    });
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ error: '需要 Authorization: Bearer <key>', code: 'KEY_REQUIRED' });
  }
  let matched = null;
  for (const [key, cfg] of keys) {
    if (sameKey(key, token)) { matched = cfg; break; }
  }
  if (!matched) {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();
    console.warn('[integrationAuth] 金鑰不符 ip=' + ip);
    logAccess({
      label: 'unknown',
      action: '整合 API 認證失敗',
      severity: 'warning',
      details: { path: req.originalUrl, ip },
    });
    return res.status(401).json({ error: '認證失敗', code: 'KEY_INVALID' });
  }
  if (overRateLimit(matched.label)) {
    logAccess({
      label: matched.label,
      action: '整合 API 觸發流量上限',
      severity: 'warning',
      details: { path: req.originalUrl, limit: RL_MAX, window_ms: RL_WINDOW_MS },
    });
    return res.status(429).json({ error: '查詢次數過多，請稍後再試', code: 'RATE_LIMITED' });
  }
  req.integration = matched;
  next();
}

/**
 * 場館層級的即時開關：admin_settings 的 `integration_venue_enabled_<場館>`，0 = 停用。
 *
 * 為什麼要有這個，金鑰不是已經綁場館了嗎 —— 因為金鑰在 Replit Secrets 裡，
 * 改了要重新部署才會生效。真的出事那天（某台平板遺失、某館金鑰外流），
 * 你要的是 30 秒內切斷，不是排一次 Republish。這個開關在資料庫，改完最多 30 秒生效。
 *
 * 語意分工：**金鑰決定「誰能查」，這個開關決定「這個場館現在開不開」**。
 * 未設定視為開啟 —— 整體仍然是 opt-in，因為沒發金鑰的場館本來就沒人查得到；
 * 若這裡也預設關，會變成兩道都要開，運維上很容易踩到「明明配好了卻查不到」。
 */
const venueFlagCache = new Map(); // venueId → { enabled, at }
async function isVenueEnabled(venueId) {
  const now = Date.now();
  const hit = venueFlagCache.get(venueId);
  if (hit && now - hit.at < VENUE_FLAG_TTL_MS) return hit.enabled;
  let enabled = true;
  try {
    const r = await pool.query(
      'SELECT value FROM admin_settings WHERE key = $1',
      [`integration_venue_enabled_${venueId}`]
    );
    if (r.rowCount) enabled = Number(r.rows[0].value) !== 0;
  } catch (e) {
    // 讀不到設定時維持上一次的判斷；沒有上一次就放行。
    // 這裡刻意不 fail-closed：DB 一抖就讓全場館的救生台同時失效，
    // 造成的營運中斷比「開關晚 30 秒生效」嚴重得多。真正的門禁是金鑰那一層。
    console.warn('[integrationAuth] 場館開關讀取失敗:', e.message);
    return hit ? hit.enabled : true;
  }
  venueFlagCache.set(venueId, { enabled, at: now });
  return enabled;
}

module.exports = {
  requireIntegrationKey, logAccess, isVenueEnabled,
  __test__: { loadKeys, sameKey, venueFlagCache },
};
