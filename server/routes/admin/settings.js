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
