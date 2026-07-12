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

// 以檔案內容（magic bytes）辨識真實格式，回傳正規 MIME 或 null。
// 比瀏覽器提供的 file.type / 副檔名可靠：部分 Android／LINE webview 挑相機圖時
// file.type 會是空字串、送出時 multipart 便以 application/octet-stream 上傳。
function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 4) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROOF_MAX_BYTES },
  fileFilter(_req, file, cb) {
    const mime = (file.mimetype || '').toLowerCase();
    if (['image/jpeg', 'image/png'].includes(mime)) return cb(null, true);
    // MIME 缺漏 / 為 octet-stream（空 file.type 的 webview）先放行，交由 handler 以內容確認；
    // 其餘明確非 JPG/PNG 的類型（pdf、svg…）仍在此擋掉，維持早期拒絕的好體驗。
    if (!mime || mime === 'application/octet-stream') return cb(null, true);
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
    // 優先信任瀏覽器 MIME（image/jpeg|png）；缺漏／octet-stream 時改以檔案內容辨識，
    // 讓沒帶 file.type 的相機圖也能正確上傳，同時仍只接受真正的 JPG/PNG。
    let mimeType = (req.file.mimetype || '').toLowerCase();
    if (!['image/jpeg', 'image/png'].includes(mimeType)) {
      const sniffed = sniffImageMime(req.file.buffer);
      if (!sniffed) return res.status(400).json({ error: '只接受 JPG / PNG 圖片' });
      mimeType = sniffed;
    }
    const result = await saveBuffer({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType,
    });
    res.json({ url: result.url });
  } catch (err) {
    const status = Number(err.status) || 500;
    console.error('[uploads/payment-proof]', err.message);
    res.status(status).json({ error: err.message || '上傳失敗' });
  }
});

module.exports = router;
