/**
 * multer 錯誤轉譯 —— 包住 upload.single()，把 multer 自己丟的錯轉成合理的 4xx JSON。
 *
 * 為什麼需要：multer 的 MulterError 沒有 .status，會一路掉到 index.js 的全域
 * 錯誤處理，被當成未預期例外 → 回 500 且訊息是英文的 "File too large"。
 * 實測（2026-08-18，/coaches/:id/avatar 傳 6MB）：
 *     500 {"error":"File too large"}
 * 使用者看到的是「上傳失敗」但不知道是檔案太大；伺服器日誌則多一筆 [unhandled]，
 * 把真正的 500 淹掉。
 *
 * 注意 fileFilter 自己丟的錯不受影響 —— 那些有帶 .status，本來就會正確回 400。
 */
const CODE_MESSAGE = {
  LIMIT_FILE_SIZE: (mb) => `檔案大小不得超過 ${mb}MB`,
  LIMIT_FILE_COUNT: () => '一次只能上傳一個檔案',
  LIMIT_UNEXPECTED_FILE: () => '欄位名稱不正確（應為 file）',
  LIMIT_PART_COUNT: () => '表單欄位過多',
  LIMIT_FIELD_KEY: () => '表單欄位名稱過長',
  LIMIT_FIELD_VALUE: () => '表單欄位內容過長',
  LIMIT_FIELD_COUNT: () => '表單欄位過多',
};

/**
 * @param {import('multer').Multer} upload  已設定好的 multer 實例
 * @param {number} maxBytes                 該端點的大小上限（用於錯誤訊息）
 * @param {string} field                    欄位名，預設 'file'
 */
function singleUpload(upload, maxBytes, field = 'file') {
  const mb = Math.round((Number(maxBytes) || 0) / 1024 / 1024);
  return (req, res, next) => upload.single(field)(req, res, (err) => {
    if (!err) return next();
    const make = CODE_MESSAGE[err.code];
    // 413 才是「內容過大」的語意；其餘的參數錯誤是 400。
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : (Number(err.status) || 400);
    const message = make ? make(mb) : (err.message || '上傳失敗');
    return res.status(status).json({ error: message, code: err.code || 'UPLOAD_FAILED' });
  });
}

module.exports = { singleUpload, CODE_MESSAGE };
