/**
 * /api/uploads — 家長 / LIFF 端媒體上傳（U3 匯款／轉帳證明）
 *
 *  POST /payment-proof   multipart/form-data, field: file
 *                        依 magic bytes 驗證常見手機圖片，≤ 5MB；保留原檔並回傳 JPEG preview
 *
 * 與 /api/admin/uploads（後台發票，admin-only）刻意分開：本路由需家長登入
 * （requireParent），供 LIFF 報名流程上傳付款證明使用。
 */
const express = require('express');
const multer = require('multer');
const { requireParent } = require('../middlewares/parentAuth');
const { processReceiptImage } = require('../services/receiptImage');
const { pool } = require('../models/db');

const router = express.Router();
const PROOF_MAX_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROOF_MAX_BYTES },
});

// 包一層讓 multer 的錯誤（例如檔案過大）回 JSON 400，而非預設 HTML 500。
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '圖片大小不得超過 5MB' : (err.message || '上傳失敗');
    return res.status(400).json({ error: msg });
  });
}

async function resolveOwnedTarget(req) {
  const targetType = String(req.body?.target_type || '').trim();
  const targetId = String(req.body?.target_id || '').trim();
  if (!targetType && !targetId) return { targetType: 'unassigned', targetId: null };
  if (!['checkout', 'enrollment', 'group_order'].includes(targetType) || !targetId) {
    const error = new Error('圖片歸屬資料格式錯誤');
    error.code = 'PAYMENT_PROOF_TARGET_INVALID';
    error.status = 400;
    throw error;
  }

  let owned = false;
  if (targetType === 'checkout') {
    const result = await pool.query(
      `SELECT 1 FROM checkout_sessions cs
        WHERE cs.checkout_id::text = $1
          AND (
            cs.parent_id = $2
            OR EXISTS (
              SELECT 1 FROM admin_enrollments ae
               WHERE ae.checkout_id = cs.checkout_id
                 AND (ae.parent_phone = $3 OR $3 = ANY(COALESCE(ae.extra_parent_phones, '{}')))
            )
          )`,
      [targetId, req.parent.id, req.parent.phone],
    );
    owned = result.rowCount > 0;
  } else if (targetType === 'enrollment') {
    const result = await pool.query(
      `SELECT 1 FROM admin_enrollments
        WHERE id = $1
          AND (parent_phone = $2 OR $2 = ANY(COALESCE(extra_parent_phones, '{}')))`,
      [targetId, req.parent.phone],
    );
    owned = result.rowCount > 0;
  } else {
    const result = await pool.query(
      `SELECT 1 FROM group_order_members
        WHERE group_order_id::text = $1 AND parent_id = $2`,
      [targetId, req.parent.id],
    );
    owned = result.rowCount > 0;
  }

  if (!owned) {
    const error = new Error('無權將圖片附加到此付款資料');
    error.code = 'PAYMENT_PROOF_TARGET_FORBIDDEN';
    error.status = 403;
    throw error;
  }
  return { targetType, targetId };
}

router.post('/payment-proof', requireParent, uploadSingle, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
    const target = await resolveOwnedTarget(req);
    const result = await processReceiptImage({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      declaredMimeType: req.file.mimetype,
    });
    const saved = await pool.query(
      `INSERT INTO payment_proof_uploads
         (parent_id, target_type, target_id, original_url, preview_url, thumbnail_url,
          checksum, actual_mime_type, conversion_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (original_url) DO UPDATE SET original_url = EXCLUDED.original_url
       RETURNING id`,
      [
        req.parent.id, target.targetType, target.targetId, result.original_url || result.url,
        result.preview_url || result.url, result.thumbnail_url || null, result.checksum,
        result.actual_mime_type || null, result.conversion_status || 'ready',
      ],
    );
    res.status(result.conversion_status === 'pending' ? 202 : 200).json({
      ...result,
      upload_id: saved.rows[0]?.id || null,
      target_type: target.targetType,
      target_id: target.targetId,
    });
  } catch (err) {
    const status = Number(err.status) || 500;
    console.error('[uploads/payment-proof]', err.code || 'IMAGE_UPLOAD_FAILED');
    res.status(status).json({ error: err.message || '上傳失敗', code: err.code || 'IMAGE_UPLOAD_FAILED' });
  }
});

module.exports = router;
module.exports.__test__ = { resolveOwnedTarget };
