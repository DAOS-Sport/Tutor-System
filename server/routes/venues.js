/**
 * /api/venues — 場館列表（LIFF 家長端）
 *   GET /            列出啟用中場館
 *   GET /:id         單一場館（含銀行帳戶供報名轉帳頁顯示）
 *
 * 資料源：coreSchema 的 venues 表（由 Ragic H05 同步或 admin 後台維護）。
 * Response shape 對齊 client/liff/src/api/mock.js 中的 VENUES：
 *   { id, code, name, address, bank_institution_name, bank_branch_name,
 *     account_holder, account_number }
 * 其中 DB 欄位 full_address → 對外 alias 為 address；code 直接用 id（兩者皆為場館短碼）。
 */
const express = require('express');
const { pool } = require('../models/db');

const router = express.Router();

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.id,
    name: row.name,
    full_name: row.full_name || null,
    address: row.full_address || null,
    bank_institution_name: row.bank_institution_name || null,
    bank_branch_name: row.bank_branch_name || null,
    account_holder: row.account_holder || null,
    account_number: row.account_number || null,
  };
}

router.get('/', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, full_name, full_address,
              bank_institution_name, bank_branch_name, account_holder, account_number
         FROM venues
        WHERE is_active = TRUE
        ORDER BY id`
    );
    res.json(r.rows.map(toApi));
  } catch (err) {
    console.error('[venues.list]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, full_name, full_address,
              bank_institution_name, bank_branch_name, account_holder, account_number
         FROM venues
        WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: '找不到場館' });
    res.json(toApi(r.rows[0]));
  } catch (err) {
    console.error('[venues.detail]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
