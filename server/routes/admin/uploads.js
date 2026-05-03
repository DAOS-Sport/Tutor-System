/**
 * /api/admin/uploads — 後台媒體上傳（Task #39 發票照片）
 *
 *  POST /invoice   multipart/form-data, field: file
 *                  只接受 image/jpeg / image/png，≤ 5MB
 *                  回傳 { url }（/uploads/YYYY-MM/xxxxx.jpg）
 */
const express = require('express');
const multer = require('multer');
const { requireAdminAuth } = require('../../middlewares/adminAuth');
const { saveBuffer } = require('../../services/objectStorage');

const router = express.Router();
const INVOICE_MAX_BYTES = 5 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: INVOICE_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('只接受 JPG / PNG 圖片'), { status: 400 }));
  },
});

router.post('/invoice', requireAdminAuth, upload.single('file'), async (req, res) => {
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
    console.error('[admin/uploads/invoice]', err.message);
    res.status(status).json({ error: err.message || '上傳失敗' });
  }
});

module.exports = router;
