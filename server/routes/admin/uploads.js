/**
 * /api/admin/uploads — 後台媒體上傳（Task #39 發票照片）
 *
 *  POST /invoice   multipart/form-data, field: file
 *                  依 magic bytes 驗證常見手機圖片，≤ 5MB；保留原檔並回傳 JPEG preview
 *  POST /image     同上設定的通用圖片上傳（課程介紹封面等）
 *                  回傳 { url }
 */
const express = require('express');
const multer = require('multer');
const { requireAdminAuth } = require('../../middlewares/adminAuth');
const { saveBuffer } = require('../../services/objectStorage');
const { processReceiptImage } = require('../../services/receiptImage');

const router = express.Router();
const INVOICE_MAX_BYTES = 5 * 1024 * 1024;
const invoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: INVOICE_MAX_BYTES },
});
const genericImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: INVOICE_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('只接受 JPG / PNG 圖片'), { status: 400 }));
  },
});

function uploadSingle(upload) {
  return (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? '圖片大小不得超過 5MB' : (err.message || '上傳失敗');
    return res.status(400).json({ error: message, code: err.code || 'IMAGE_UPLOAD_REJECTED' });
  });
}

async function handleImageUpload(label, req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
    const result = await saveBuffer({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
    });
    res.json({ url: result.url });
  } catch (err) {
    const status = Number(err.status) || 500;
    console.error(`[admin/uploads/${label}]`, err.message);
    res.status(status).json({ error: err.message || '上傳失敗' });
  }
}

router.post('/invoice', requireAdminAuth, uploadSingle(invoiceUpload), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '請選擇檔案' });
    const result = await processReceiptImage({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      declaredMimeType: req.file.mimetype,
    });
    return res.status(result.conversion_status === 'pending' ? 202 : 200).json(result);
  } catch (err) {
    const status = Number(err.status) || 500;
    console.error('[admin/uploads/invoice]', err.code || 'IMAGE_UPLOAD_FAILED');
    return res.status(status).json({ error: err.message || '圖片上傳失敗', code: err.code || 'IMAGE_UPLOAD_FAILED' });
  }
});

// 通用後台圖片上傳（課程介紹封面等）
router.post('/image', requireAdminAuth, uploadSingle(genericImageUpload), (req, res) =>
  handleImageUpload('image', req, res));

module.exports = router;
