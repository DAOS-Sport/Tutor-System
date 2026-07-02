/**
 * /api/venues — 場館列表（LIFF 家長端）
 *   GET /            列出啟用中場館
 *   GET /:id         單一場館（含銀行帳戶供報名轉帳頁顯示）
 *
 * 資料源：coreSchema 的 venues 表（由 Ragic H05 同步或 admin 後台維護）。
 * 匯款帳戶（bank_institution_name / bank_branch_name / account_holder / account_number）
 * 以 admin_venues（F-A03 場館設定，各館各自維護、不受 Ragic 同步覆蓋）為準；
 * 該館尚未在 F-A03 設定時才退回 venues 表既有值，避免顯示空白
 * （Task: 報名匯款帳戶需對應到匯款館別，而非全館統一同一組帳號）。
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
    address: row.full_address || '',
    bank_institution_name: row.bank_institution_name || '',
    bank_branch_name: row.bank_branch_name || '',
    account_holder: row.account_holder || '',
    account_number: row.account_number || '',
  };
}

router.get('/', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT v.id, v.name, v.full_address,
              COALESCE(NULLIF(av.bank_institution_name, ''), v.bank_institution_name) AS bank_institution_name,
              COALESCE(NULLIF(av.bank_branch_name, ''), v.bank_branch_name) AS bank_branch_name,
              COALESCE(NULLIF(av.account_holder, ''), v.account_holder) AS account_holder,
              COALESCE(NULLIF(av.account_number, ''), v.account_number) AS account_number
         FROM venues v
         LEFT JOIN admin_venues av ON av.id = v.id
        WHERE v.is_active = TRUE
        ORDER BY v.id`
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
      `SELECT v.id, v.name, v.full_address,
              COALESCE(NULLIF(av.bank_institution_name, ''), v.bank_institution_name) AS bank_institution_name,
              COALESCE(NULLIF(av.bank_branch_name, ''), v.bank_branch_name) AS bank_branch_name,
              COALESCE(NULLIF(av.account_holder, ''), v.account_holder) AS account_holder,
              COALESCE(NULLIF(av.account_number, ''), v.account_number) AS account_number
         FROM venues v
         LEFT JOIN admin_venues av ON av.id = v.id
        WHERE v.id = $1`,
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
