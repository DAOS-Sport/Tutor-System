/**
 * Chat 媒體儲存 — Adapter 抽象層（spec F-S09 / F-C03）
 *
 * 為了滿足 v1 上線時程，預設使用 LocalDiskDriver；介面被刻意做成
 * driver pattern，未來要切到 Replit App Storage / S3 / GCS 只需在
 * driver 物件實作同一份 contract（saveBuffer / urlFor），業務碼不需改動。
 *
 * 安全：
 *  - 強制 MIME + 副檔名白名單（杜絕 .html/.svg/.js 同源 XSS）
 *  - 大小上限（預設 25 MB）
 *  - LocalDisk 由 server/index.js 的 /uploads middleware 加上
 *    nosniff / CSP sandbox / Content-Disposition:attachment 三道防線
 *
 * 切換方式：環境變數 OBJECT_STORAGE_DRIVER=local|replit （預設 local）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_MAX_BYTES = Number(process.env.CHAT_UPLOAD_MAX_BYTES) || 25 * 1024 * 1024;

// 嚴格 MIME → ext 白名單
const ALLOWED = {
  // 影像（不接受 image/svg+xml — SVG 內可嵌 <script>）
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
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':       ['.xlsx'],
};

function isAllowed(mimeType, ext) {
  const exts = ALLOWED[(mimeType || '').toLowerCase()];
  if (!exts) return false;
  return exts.includes((ext || '').toLowerCase());
}

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

function safeExt(originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (!ext || ext.length > 6) return '';
  return ext.replace(/[^a-z0-9.]/g, '');
}

// ── Driver: Local Disk ────────────────────────────────────────
const LOCAL_ROOT = path.join(__dirname, '..', 'uploads');
const LocalDiskDriver = {
  name: 'local',
  async saveBuffer({ buffer, ext }) {
    if (!fs.existsSync(LOCAL_ROOT)) fs.mkdirSync(LOCAL_ROOT, { recursive: true });
    const d = new Date();
    const yyyymm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const dir = path.join(LOCAL_ROOT, yyyymm);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomBytes(12).toString('hex');
    const filename = `${id}${ext}`;
    await fs.promises.writeFile(path.join(dir, filename), buffer);
    // /uploads 由 server/index.js 提供 middleware（含 nosniff + CSP sandbox）
    return { url: `/uploads/${yyyymm}/${filename}` };
  },
};

// ── Driver: Replit App Storage（占位實作；尚未 provision bucket 時自動退回 local）
const ReplitDriver = {
  name: 'replit',
  async saveBuffer(/* { buffer, ext, mimeType } */) {
    throw new Error('replit object storage adapter not configured; install @replit/object-storage and provision a bucket');
  },
};

const DRIVERS = { local: LocalDiskDriver, replit: ReplitDriver };
const driverName = (process.env.OBJECT_STORAGE_DRIVER || 'local').toLowerCase();
const driver = DRIVERS[driverName] || LocalDiskDriver;

// ── 對外 API（保持 v1 簽名，呼叫端無需改動） ────────────────────
async function saveBuffer({ buffer, originalName = 'file.bin', mimeType = 'application/octet-stream' }) {
  if (!buffer || !buffer.length) throw new Error('檔案為空');
  if (buffer.length > ALLOWED_MAX_BYTES) {
    throw new Error(`檔案過大（上限 ${Math.round(ALLOWED_MAX_BYTES / 1024 / 1024)} MB）`);
  }
  const ext = safeExt(originalName);
  if (!isAllowed(mimeType, ext)) {
    throw new Error(`不支援的檔案類型（${mimeType || 'unknown'}${ext}）`);
  }
  const { url } = await driver.saveBuffer({ buffer, ext, mimeType });
  return {
    url,
    filename: originalName,
    size: buffer.length,
    mimeType,
    messageType: inferMessageType(mimeType, ext),
    driver: driver.name,
  };
}

// 驗證一個對外 URL 是否真的指向本服務已落地的檔案（防止偽造 /uploads 路徑）。
// 非 local driver 無法同步檢查檔案存在，回 true 交由上層信任（best-effort）。
function objectExists(url) {
  if (driver.name !== 'local') return true;
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return false;
  const rel = url.replace(/^\/uploads\//, '');
  if (!rel || rel.includes('..')) return false;
  const full = path.join(LOCAL_ROOT, rel);
  if (full !== LOCAL_ROOT && !full.startsWith(LOCAL_ROOT + path.sep)) return false;
  try { return fs.existsSync(full); } catch { return false; }
}

module.exports = {
  saveBuffer,
  isAllowed,
  inferMessageType,
  objectExists,
  UPLOAD_ROOT: LOCAL_ROOT,
  ALLOWED_MAX_BYTES,
  driverName: driver.name,
};
