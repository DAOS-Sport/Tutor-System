/**
 * /api/uploads — 家長 / LIFF 端媒體上傳（U3 匯款／轉帳證明）
 *
 *  POST /payment-proof   multipart/form-data, field: file
 *                        只接受 image/jpeg / image/png，≤ 5MB
 *                        回傳 { url }（/uploads/YYYY-MM/xxxxx.jpg）
 *
 * 與 /api/admin/uploads（後台發票，admin-only）刻意分開：本路由需家長登入
 * （requireParent），供 LIFF 報名流程上傳付款證明使用。
 */
const express = require('express');
const multer = require('multer');
const { requireParent } = require('../middlewares/parentAuth');
const { saveBuffer } = require('../services/objectStorage');

const router = express.Router();
const PROOF_MAX_BYTES = 5 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROOF_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('只接受 JPG / PNG 圖片'), { status: 400 }));
  },
});

// 包一層讓 multer 的錯誤（檔案過大 / 非 JPG-PNG）回 JSON 400，而非預設 HTML 500。
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '圖片大小不得超過 5MB' : (err.message || '上傳失敗');
    return res.status(400).json({ error: msg });
  });
}

router.post('/payment-proof', requireParent, uploadSingle, async (req, res) => {
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
    console.error('[uploads/payment-proof]', err.message);
    res.status(status).json({ error: err.message || '上傳失敗' });
  }
});

module.exports = router;
