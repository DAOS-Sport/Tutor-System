const SAFE_DATA_IMAGE_RE = /^data:image\/(?:jpeg|png|webp|avif);base64,/i;

export function normalizeImageUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/\.svg(?:[?#]|$)/i.test(url)) return '';
  if (/^https:\/\//i.test(url) || /^blob:/i.test(url) || SAFE_DATA_IMAGE_RE.test(url)) return url;
  if (/^(?:javascript|vbscript|file):/i.test(url) || /^data:/i.test(url) || /^http:\/\//i.test(url)) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return url;
  return `/${url.replace(/^\.\//, '')}`;
}

function isBlobLike(value) {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

export function resolveImagePreviewSource(value) {
  if (!value) return { kind: 'empty', url: '', name: '' };
  if (isBlobLike(value)) {
    return { kind: 'local', url: '', blob: value, name: value.name || '本機圖片' };
  }
  if (typeof value === 'object') {
    const candidate = value.preview_url || value.previewUrl || value.thumbnail_url
      || value.thumbnailUrl || value.url || value.original_url || value.originalUrl;
    return {
      kind: 'remote',
      url: normalizeImageUrl(candidate),
      name: value.original_file_name || value.fileName || value.name || '',
      status: value.conversion_status || value.status || null,
    };
  }
  return { kind: 'remote', url: normalizeImageUrl(value), name: '' };
}

export function createLocalPreview(blob, {
  createObjectURL = (value) => URL.createObjectURL(value),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
} = {}) {
  if (!isBlobLike(blob)) return { url: '', revoke() {} };
  const url = createObjectURL(blob);
  let revoked = false;
  return {
    url,
    revoke() {
      if (revoked) return;
      revoked = true;
      revokeObjectURL(url);
    },
  };
}

export const RECEIPT_IMAGE_ACCEPT = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif',
  '.jpg', '.jpeg', '.jfif', '.png', '.webp', '.heic', '.heif', '.avif',
].join(',');

export function isSupportedImageCandidate(file) {
  if (!file) return false;
  const mime = String(file.type || '').toLowerCase();
  const extension = String(file.name || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
  if (mime === 'image/svg+xml' || extension === '.svg') return false;
  if (!mime || mime === 'application/octet-stream') return true;
  return ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif'].includes(mime);
}
