/**
 * 全域系統設定 (F-A01)
 *  GET    /api/admin/settings      → { key: number, ... }
 *  PATCH  /api/admin/settings      → 部分更新，回傳合併後的整包
 *
 * mock.js settings shape（7 keys）：
 *   sessions_per_period, validity_days, expiry_notice_days,
 *   refund_fee_rate, transfer_fee, default_session_minutes, multi_confirm_minutes
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');

const router = express.Router();

const ALLOWED_KEYS = [
  'sessions_per_period', 'validity_days', 'expiry_notice_days',
  'refund_fee_rate', 'transfer_fee', 'default_session_minutes', 'multi_confirm_minutes',
  // 推播安全閥（services/pushGate.js）。原本只能直接下 SQL 改 —— 那既容易打錯，
  // 也讓「開推播」變成需要資料庫權限的動作。值一律 0/1（push_max_per_hour 除外）。
  //
  // ⚠️ push_dry_run 預設是 1。只開 push_enabled 而忘了把 dry_run 關掉的話，
  // 閘門會放行但不送出 —— 看起來一切正常，實際上一則都沒發。這是最容易誤判的組合。
  'push_enabled', 'push_dry_run', 'push_max_per_hour',
  'push_event_checkin_confirmed_coach',
];

async function readAll() {
  const r = await pool.query(`SELECT key, value FROM admin_settings`);
  const out = {};
  for (const row of r.rows) out[row.key] = Number(row.value);
  return out;
}

// 系統設定僅 admin 可讀（含手續費率、轉讓費等規則性數字）。內部 API（例如
// enrollments router 計算退款）以服務內部 helper 直接讀 DB，不經這條路由。
router.get('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    res.json(await readAll());
  } catch (err) {
    console.error('[admin/settings]', err);
    res.status(500).json({ error: 'load settings failed' });
  }
});

router.patch('/', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const patch = req.body || {};
    for (const [k, v] of Object.entries(patch)) {
      if (!ALLOWED_KEYS.includes(k)) continue;
      const n = Number(v);
      if (Number.isNaN(n)) {
        return res.status(400).json({ error: `「${k}」必須為數字` });
      }
      await pool.query(
        `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [k, n]
      );
    }
    res.json(await readAll());
  } catch (err) {
    console.error('[admin/settings PATCH]', err);
    res.status(500).json({ error: 'update settings failed' });
  }
});

module.exports = router;
