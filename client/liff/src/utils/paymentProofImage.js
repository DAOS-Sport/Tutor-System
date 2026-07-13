export const PAYMENT_PROOF_ACCEPT = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif',
  '.jpg', '.jpeg', '.jfif', '.png', '.webp', '.heic', '.heif', '.avif',
].join(',');

export function isPaymentProofCandidate(file) {
  if (!file) return false;
  const mime = String(file.type || '').toLowerCase();
  const extension = String(file.name || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
  if (mime === 'image/svg+xml' || extension === '.svg') return false;
  // Android/LINE webview 偶爾不帶 file.type；實際安全裁決仍由後端 magic bytes + decoder 完成。
  if (!mime || mime === 'application/octet-stream') return true;
  return ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif'].includes(mime);
}
