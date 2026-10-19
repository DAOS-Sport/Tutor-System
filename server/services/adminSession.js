/**
 * 後台登入憑證的即時有效性（角色權限 A 期）。
 *
 * 在此之前，requireAdminAuth 只驗 JWT 簽章，不查資料庫。憑證效期 7 天，
 * 於是下面三件事都要等到憑證自然過期才會生效：
 *   - 員工離職被停用（admin_users.is_active = FALSE）
 *   - 身分被降級（例如系統管理員改成場館主管 —— 憑證上的 admin 會被
 *     rolePermissions 當成一個身分，7 天內仍是全開）
 *   - 負責場館被改掉（getScopedVenueIds 讀的是憑證上的 venue_ids）
 *
 * 這裡的做法：每次請求用憑證上的 sub 讀一次「這個人現在的樣子」，跟憑證比對。
 *   - 停用          → 拒絕
 *   - auth_version 不同（改密碼、被重設密碼）→ 拒絕
 *   - 身分或場館跟憑證不一樣 → 拒絕，請他重新登入拿一張正確的憑證
 *
 * 身分用 auth.js 的 _effectiveLoginUser 重算，跟登入時是同一個函式 ——
 * 兩邊各寫一套的話，同一個人會在登入後下一次請求就被踢出去。
 *
 * ── 快取 ──
 * 每個帳號的快照記在記憶體 30 秒；後台改員工、改密碼時會直接清掉，
 * 所以後台操作是立即生效，只有 Ragic 同步這種不經過這裡的寫入最多晚 30 秒。
 * 主機是單機 Reserved VM，記憶體快取就夠。日後開多台時，把 invalidate()
 * 換成 Redis pub/sub 廣播即可，呼叫端不用改。
 */
'use strict';

const { pool } = require('../models/db');
const { cleanVenueList, ADMIN_USER_VENUE_IDS_SELECT } = require('./coachVenueScope');

const TTL_MS = 30_000;
const IS_PROD = process.env.NODE_ENV === 'production';
const cache = new Map(); // userId → { at, snap }

/** 清掉某個帳號（或全部）的快照。後台改了員工資料之後呼叫。 */
function invalidate(userId) {
  if (userId === undefined || userId === null) cache.clear();
  else cache.delete(String(userId));
}

// 延遲載入：routes/admin/auth.js 本身 require 了 adminAuth middleware，
// 在檔案頂端 require 會形成循環、拿到半成品。
function effectiveLoginUser(row) {
  // eslint-disable-next-line global-require
  return require('../routes/admin/auth')._effectiveLoginUser(row);
}

async function _query(userId) {
  const r = await pool.query(
    `SELECT u.id, u.username, u.name, u.role, u.venue_id, u.is_active,
            COALESCE(u.auth_version, 1) AS auth_version,
            u.staff_id, s.role AS staff_role,
            s.is_counter, s.is_coach, s.is_lifeguard,
            COALESCE(ARRAY(SELECT r.role FROM admin_staff_roles r
                            WHERE r.staff_id = s.id), '{}') AS manual_roles,
            ${ADMIN_USER_VENUE_IDS_SELECT} AS venue_ids
       FROM admin_users u
       LEFT JOIN admin_staff s ON s.id = u.staff_id
      WHERE u.id = $1`,
    [String(userId)]
  );
  const row = r.rows[0];
  if (!row) return null;
  const login = effectiveLoginUser(row);
  return {
    active: row.is_active !== false,
    authVersion: Number(row.auth_version) || 1,
    role: login ? login.role : null,
    venueIds: cleanVenueList(row.venue_ids).sort(),
  };
}

/** 讀某個帳號現在的狀態（含快取）。查不到帳號回 null。 */
async function snapshot(userId) {
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.snap;
  const snap = await _query(key);
  cache.set(key, { at: Date.now(), snap });
  return snap;
}

function sameVenues(a, b) {
  const x = cleanVenueList(a).sort();
  const y = cleanVenueList(b).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * 比對憑證與資料庫。回 null＝通過；否則回 { code, error }。
 * 資料庫讀不到時會 throw —— 由呼叫端決定回 503，不能當成「憑證無效」，
 * 否則資料庫抖一下就把所有人登出。
 */
async function checkToken(payload) {
  const sub = payload && payload.sub;
  const bound = payload && payload.av !== undefined;
  if (!sub) {
    // 沒有 sub 的憑證不是登入流程發的（只有測試會這樣簽）。
    if (IS_PROD || bound) return { code: 'SESSION_INVALID', error: '登入狀態無效，請重新登入' };
    return null;
  }
  const snap = await snapshot(sub);
  if (!snap) {
    // 帳號已不存在。正式環境一律拒絕；開發與測試環境允許「舊式、未綁定版本」
    // 的憑證通過 —— 測試會用不存在的 sub 自己簽憑證，那些不是真的登入。
    if (IS_PROD || bound) return { code: 'SESSION_INVALID', error: '帳號不存在，請重新登入' };
    return null;
  }
  if (!snap.active) return { code: 'ACCOUNT_DISABLED', error: '此帳號已停用，請聯絡系統管理員' };
  // 沒有 av 的是這次改版前發的憑證，視為版本 1。上線當下不會把所有人踢出去。
  const av = bound ? Number(payload.av) : 1;
  if (av !== snap.authVersion) {
    return { code: 'SESSION_REVOKED', error: '密碼已變更，請重新登入' };
  }
  if (snap.role !== payload.role) {
    return { code: 'SESSION_STALE', error: '你的身分已被調整，請重新登入' };
  }
  const tokenVenues = payload.venue_ids || (payload.venue_id ? [payload.venue_id] : []);
  if (snap.role !== 'admin' && !sameVenues(tokenVenues, snap.venueIds)) {
    return { code: 'SESSION_STALE', error: '你的負責場館已被調整，請重新登入' };
  }
  return null;
}

module.exports = { checkToken, snapshot, invalidate, sameVenues, TTL_MS };
