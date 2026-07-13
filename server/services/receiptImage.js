const crypto = require('crypto');
const sharp = require('sharp');
const decodeHeic = require('heic-decode');
const { saveBuffer: defaultSaveBuffer } = require('./objectStorage');

const MAX_PIXELS = Number(process.env.RECEIPT_IMAGE_MAX_PIXELS) || 40_000_000;
const PREVIEW_MAX_EDGE = 2400;
const THUMBNAIL_MAX_EDGE = 360;

const FORMAT_INFO = Object.freeze({
  jpeg: { mimeType: 'image/jpeg', extension: '.jpg' },
  png: { mimeType: 'image/png', extension: '.png' },
  webp: { mimeType: 'image/webp', extension: '.webp' },
  heic: { mimeType: 'image/heic', extension: '.heic' },
  heif: { mimeType: 'image/heif', extension: '.heif' },
  avif: { mimeType: 'image/avif', extension: '.avif' },
});

function imageError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';

  // HEIC/HEIF/AVIF 都是 ISO-BMFF。除了 primary brand，也檢查相容 brand，
  // 但只讀 ftyp box 的前 64 bytes，避免把任意內文誤判成圖片。
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return null;
  const boxLength = Math.min(buffer.readUInt32BE(0) || buffer.length, buffer.length, 64);
  const brands = [];
  for (let offset = 8; offset + 4 <= boxLength; offset += 4) {
    if (offset === 12) continue; // minor version，不是 brand
    brands.push(buffer.toString('ascii', offset, offset + 4));
  }
  if (brands.some((brand) => brand === 'avif' || brand === 'avis')) return 'avif';
  if (brands.some((brand) => ['heic', 'heix', 'hevc', 'hevx'].includes(brand))) return 'heic';
  if (brands.some((brand) => ['mif1', 'msf1'].includes(brand))) return 'heif';
  return null;
}

function assertPixelLimit(width, height, pages = 1) {
  const pixels = Number(width || 0) * Number(height || 0) * Math.max(1, Number(pages || 1));
  if (!width || !height || !Number.isSafeInteger(pixels)) {
    throw imageError('IMAGE_DECODE_FAILED', '圖片內容無法解析');
  }
  if (pixels > MAX_PIXELS) {
    throw imageError('IMAGE_TOO_LARGE', '圖片像素尺寸過大，請縮小後重新上傳');
  }
}

async function decodeSource(buffer, format) {
  if (format === 'heic' || format === 'heif') {
    try {
      const decoded = await decodeHeic({ buffer });
      assertPixelLimit(decoded.width, decoded.height);
      return {
        input: Buffer.from(decoded.data),
        options: { raw: { width: decoded.width, height: decoded.height, channels: 4 } },
        width: decoded.width,
        height: decoded.height,
      };
    } catch (error) {
      if (error?.code === 'IMAGE_TOO_LARGE') throw error;
      throw imageError('IMAGE_DECODE_FAILED', 'HEIC／HEIF 圖片無法解析，請重新拍攝或另存為 JPG');
    }
  }

  try {
    const metadata = await sharp(buffer, { failOn: 'warning', limitInputPixels: MAX_PIXELS }).metadata();
    assertPixelLimit(metadata.width, metadata.height, metadata.pages);
    return { input: buffer, options: { failOn: 'warning', limitInputPixels: MAX_PIXELS }, ...metadata };
  } catch (error) {
    if (error?.code === 'IMAGE_TOO_LARGE') throw error;
    throw imageError('IMAGE_DECODE_FAILED', '圖片內容損壞或無法解析');
  }
}

function normalizedPipeline(source, maxEdge) {
  return sharp(source.input, source.options)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    // sharp 預設不複製 EXIF/IPTC/XMP；輸出的預覽檔不含 GPS 等原始 metadata。
    .jpeg({ quality: 88, mozjpeg: true });
}

async function processReceiptImage({ buffer, originalName = 'image', declaredMimeType = '' }, {
  saveBuffer = defaultSaveBuffer,
} = {}) {
  const format = detectImageFormat(buffer);
  if (!format || !FORMAT_INFO[format]) {
    throw imageError('IMAGE_FORMAT_UNSUPPORTED', '不支援此檔案；請上傳 JPG、PNG、WebP、HEIC、HEIF 或 AVIF 圖片');
  }

  // magic bytes 決定實際格式；瀏覽器 MIME 與副檔名僅保留作稽核，不參與信任判斷。
  const actual = FORMAT_INFO[format];
  const source = await decodeSource(buffer, format);
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  const original = await saveBuffer({
    buffer,
    originalName: `${originalName || 'image'}${String(originalName || '').includes('.') ? '' : actual.extension}`,
    mimeType: actual.mimeType,
  });

  try {
    const previewBuffer = await normalizedPipeline(source, PREVIEW_MAX_EDGE).toBuffer();
    const thumbnailBuffer = await normalizedPipeline(source, THUMBNAIL_MAX_EDGE).toBuffer();
    const preview = await saveBuffer({
      buffer: previewBuffer,
      originalName: 'preview.jpg',
      mimeType: 'image/jpeg',
    });
    const thumbnail = await saveBuffer({
      buffer: thumbnailBuffer,
      originalName: 'thumbnail.jpg',
      mimeType: 'image/jpeg',
    });
    const metadata = await sharp(previewBuffer).metadata();
    return {
      url: preview.url,
      original_url: original.url,
      preview_url: preview.url,
      thumbnail_url: thumbnail.url,
      actual_mime_type: actual.mimeType,
      declared_mime_type: String(declaredMimeType || '').toLowerCase() || null,
      normalized_mime_type: 'image/jpeg',
      conversion_status: 'ready',
      width: metadata.width,
      height: metadata.height,
      checksum,
    };
  } catch (error) {
    // 原檔已安全解碼並保存。預覽編碼或第二次 storage write 暫時失敗時，
    // 回傳可持久化的原檔 URL，讓既有對帳 submit 不被轉檔服務阻斷。
    return {
      url: original.url,
      original_url: original.url,
      preview_url: null,
      thumbnail_url: null,
      actual_mime_type: actual.mimeType,
      declared_mime_type: String(declaredMimeType || '').toLowerCase() || null,
      normalized_mime_type: null,
      conversion_status: 'pending',
      conversion_code: 'IMAGE_CONVERSION_PENDING',
      width: source.width,
      height: source.height,
      checksum,
    };
  }
}

module.exports = {
  processReceiptImage,
  detectImageFormat,
  MAX_PIXELS,
  __test__: { decodeSource, normalizedPipeline, assertPixelLimit },
};
