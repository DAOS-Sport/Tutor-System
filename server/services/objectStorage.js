/**
 * 多媒體儲存抽象層
 * - 預設：本機 server/uploads/<yyyy-mm>/<uuid>.<ext>，Express 以 /uploads 靜態提供
 * - 進階（Phase 7+）：可改接 Replit Object Storage / S3，只需替換 saveBuffer / publicUrl 兩個函式
 *
 * 對外介面：
 *   saveBuffer({ buffer, originalName, mimeType }) → { url, filename, size, mimeType }
 *
 * 設計考量：
 * - 檔案以 yyyy-mm 分桶避免單一目錄過大
 * - 檔名統一改 uuid，保留原副檔名以利瀏覽器辨識；原始檔名另存於資料庫 media_filename 欄
 * - 防呆：拒收 0 byte / 超過 ALLOWED_MAX_BYTES 的檔案
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const ALLOWED_MAX_BYTES = Number(process.env.CHAT_UPLOAD_MAX_BYTES) || 25 * 1024 * 1024; // 25 MB

// 安全：嚴格 MIME + 副檔名白名單，杜絕 .html/.svg/.js 等可在同源執行的內容（避免 stored XSS）
const ALLOWED = {
  // 影像 — 不接受 image/svg+xml（SVG 內可嵌 <script>）
  'image/jpeg':      ['.jpg', '.jpeg'],
  'image/png':       ['.png'],
  'image/gif':       ['.gif'],
  'image/webp':      ['.webp'],
  'image/heic':      ['.heic'],
  'image/heif':      ['.heif'],
  // 影片
  'video/mp4':       ['.mp4', '.m4v'],
  'video/quicktime': ['.mov'],
  'video/webm':      ['.webm'],
  // 音訊
  'audio/mpeg':      ['.mp3'],
  'audio/wav':       ['.wav'],
  'audio/x-wav':     ['.wav'],
  'audio/mp4':       ['.m4a'],
  'audio/aac':       ['.aac'],
  'audio/ogg':       ['.ogg'],
  'audio/amr':       ['.amr'],
  'audio/webm':      ['.webm'],
  // 文件
  'application/pdf':  ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':       ['.xlsx'],
};

function isAllowed(mimeType, ext) {
  const exts = ALLOWED[(mimeType || '').toLowerCase()];
  if (!exts) return false;
  return exts.includes((ext || '').toLowerCase());
}

// 副檔名 → 推斷 message_type（給聊天訊息用）
function inferMessageType(mimeType, ext) {
  const m = (mimeType || '').toLowerCase();
  const e = (ext || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'voice';
  if (['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif'].includes(e)) return 'image';
  if (['.mp4','.mov','.webm','.m4v'].includes(e)) return 'video';
  if (['.mp3','.wav','.m4a','.ogg','.aac','.amr'].includes(e)) return 'voice';
  return 'file';
}

function ensureRoot() {
  if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

function bucketDir() {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(UPLOAD_ROOT, yyyymm);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return { dir, yyyymm };
}

function safeExt(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  // 限制 5 char，避免奇怪輸入
  if (!ext || ext.length > 6) return '';
  return ext.replace(/[^a-z0-9.]/g, '');
}

async function saveBuffer({ buffer, originalName = 'file.bin', mimeType = 'application/octet-stream' }) {
  if (!buffer || !buffer.length) throw new Error('檔案為空');
  if (buffer.length > ALLOWED_MAX_BYTES) {
    throw new Error(`檔案過大（上限 ${Math.round(ALLOWED_MAX_BYTES / 1024 / 1024)} MB）`);
  }
  const ext = safeExt(originalName);
  if (!isAllowed(mimeType, ext)) {
    throw new Error(`不支援的檔案類型（${mimeType || 'unknown'}${ext}）`);
  }
  ensureRoot();
  const { dir, yyyymm } = bucketDir();
  const id = crypto.randomBytes(12).toString('hex');
  const filename = `${id}${ext}`;
  const filePath = path.join(dir, filename);
  await fs.promises.writeFile(filePath, buffer);
  return {
    url: `/uploads/${yyyymm}/${filename}`,
    filename: originalName,
    size: buffer.length,
    mimeType,
    messageType: inferMessageType(mimeType, ext),
  };
}

module.exports = {
  saveBuffer,
  isAllowed,
  UPLOAD_ROOT,
  ALLOWED_MAX_BYTES,
  inferMessageType,
};
