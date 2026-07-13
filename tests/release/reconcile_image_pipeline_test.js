const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('../../server/node_modules/sharp');
const {
  processReceiptImage,
  detectImageFormat,
} = require('../../server/services/receiptImage');

const HEIC_FIXTURE_BASE64 = 'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAlhtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAANGlsb2MAAAAAREAAAgABAAAAAAJ8AAEAAAAAAAAAHgACAAAAAAKaAAEAAAAAAAAAGwAAADhpaW5mAAAAAAACAAAAFWluZmUCAAAAAAEAAGh2YzEAAAAAFWluZmUCAAAAAAIAAGh2YzEAAAABl2lwcnAAAAFwaXBjbwAAAHVodmNDAQQIAAAAAAAAAAAAHvAA/P38/AAADwMgAAEAF0ABDAH//wQIAAADAJm4AAADAAAeugJAIQABACpCAQEECAAAAwCZuAAAAwAAHqAggQRSluqumubgIaDAgAAAAwCAAAADAIQiAAEABkQBwXPAiQAAABRpc3BlAAAAAAAAAEAAAABAAAAAKGNsYXAAAAADAAAAAQAAAAIAAAAB////wwAAAAL////CAAAAAgAAABBwaXhpAAAAAAMMDAwAAAByaHZjQwEECAAAAAAAAAAAAB7wAPz8/PwAAA8DIAABABdAAQwB//8ECAAAAwCZ+AAAAwAAHroCQCEAAQAnQgEBBAgAAAMAmfgAAAMAAB7AggQRSluqumubAgAAAwACAAADAAIQIgABAAZEAcFzwIkAAAAOcGl4aQAAAAABDAAAACdhdXhDAAAAAHVybjptcGVnOmhldmM6MjAxNTphdXhpZDoxAAAAAB9pcG1hAAAAAAAAAAIAAQSBAgSDAAIFhQIGh4MAAAAaaXJlZgAAAAAAAAAOYXV4bAACAAEAAQAAAEFtZGF0AAAAGigBrxOA9rWngv/9Mbsq+WdMJZVyZuyoAAFxAAAAFygBrifn2U8M/8qw8XYJMFdf2OxKpz+g';

function memoryStore({ failAt = 0 } = {}) {
  const writes = [];
  return {
    writes,
    async saveBuffer(input) {
      writes.push(input);
      if (failAt && writes.length === failAt) throw new Error('simulated storage failure');
      const extension = input.mimeType === 'image/jpeg' ? 'jpg' : input.mimeType.split('/')[1];
      return { url: `/uploads/test/${writes.length}.${extension}` };
    },
  };
}

async function make(format, options = {}) {
  const pipeline = sharp({
    create: { width: options.width || 8, height: options.height || 5, channels: 4, background: '#ffffff' },
  });
  if (format === 'jpeg') return pipeline.jpeg().toBuffer();
  if (format === 'png') return pipeline.png().toBuffer();
  if (format === 'webp') return pipeline.webp().toBuffer();
  if (format === 'avif') return pipeline.avif().toBuffer();
  throw new Error(`unknown fixture format ${format}`);
}

async function assertReady(format, name, mime) {
  const store = memoryStore();
  const result = await processReceiptImage({
    buffer: await make(format),
    originalName: name,
    declaredMimeType: 'application/octet-stream',
  }, store);
  assert.strictEqual(result.conversion_status, 'ready');
  assert.strictEqual(result.actual_mime_type, mime);
  assert.strictEqual(result.normalized_mime_type, 'image/jpeg');
  assert.strictEqual(result.url, result.preview_url);
  assert.strictEqual(store.writes.length, 3, 'original, preview, thumbnail must be separate objects');
  assert.strictEqual(store.writes[0].mimeType, mime);
  assert.strictEqual(store.writes[1].mimeType, 'image/jpeg');
  const previewMeta = await sharp(store.writes[1].buffer).metadata();
  assert.strictEqual(previewMeta.format, 'jpeg');
  assert.strictEqual(previewMeta.exif, undefined, 'preview must not retain EXIF/GPS');
}

async function testFormats() {
  await assertReady('jpeg', 'phone.jfif', 'image/jpeg');
  await assertReady('png', 'proof.png', 'image/png');
  await assertReady('webp', 'proof.webp', 'image/webp');
  await assertReady('avif', 'proof.avif', 'image/avif');

  const heic = Buffer.from(HEIC_FIXTURE_BASE64, 'base64');
  for (const originalName of ['phone.heic', 'phone.heif']) {
    const store = memoryStore();
    const result = await processReceiptImage({ buffer: heic, originalName, declaredMimeType: '' }, store);
    assert.strictEqual(result.conversion_status, 'ready', `${originalName} must convert`);
    assert.strictEqual(result.normalized_mime_type, 'image/jpeg');
    assert.strictEqual((await sharp(store.writes[1].buffer).metadata()).format, 'jpeg');
  }
}

async function testOrientation() {
  const input = await sharp({ create: { width: 4, height: 7, channels: 3, background: '#abcdef' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const store = memoryStore();
  const result = await processReceiptImage({ buffer: input, originalName: 'portrait.jpg' }, store);
  assert.strictEqual(result.width, 7);
  assert.strictEqual(result.height, 4);
  const previewMeta = await sharp(store.writes[1].buffer).metadata();
  assert.strictEqual(previewMeta.orientation, undefined);
}

async function testMagicAndFailureSafety() {
  const fake = Buffer.from('not an image, despite a .jpg filename');
  await assert.rejects(
    processReceiptImage({ buffer: fake, originalName: 'fake.jpg', declaredMimeType: 'image/jpeg' }, memoryStore()),
    (error) => error.code === 'IMAGE_FORMAT_UNSUPPORTED',
  );
  await assert.rejects(
    processReceiptImage({ buffer: Buffer.from('<svg><script>alert(1)</script></svg>'), originalName: 'invoice.svg', declaredMimeType: 'image/svg+xml' }, memoryStore()),
    (error) => error.code === 'IMAGE_FORMAT_UNSUPPORTED',
  );

  const store = memoryStore({ failAt: 2 });
  const pending = await processReceiptImage({ buffer: await make('avif'), originalName: 'proof.avif' }, store);
  assert.strictEqual(pending.conversion_status, 'pending');
  assert.strictEqual(pending.conversion_code, 'IMAGE_CONVERSION_PENDING');
  assert.ok(pending.original_url, 'validated original must remain available');
  assert.strictEqual(pending.url, pending.original_url, 'existing reconcile payload still receives a URL');
}

async function testPreviewResolverAndUiContract() {
  const moduleUrl = `file://${path.resolve(__dirname, '../../client/admin/src/utils/imagePreview.mjs')}`;
  const preview = await import(moduleUrl);
  assert.strictEqual(preview.normalizeImageUrl('https://cdn.example.test/a.jpg'), 'https://cdn.example.test/a.jpg');
  assert.strictEqual(preview.normalizeImageUrl('/uploads/2026-07/a.jpg'), '/uploads/2026-07/a.jpg');
  assert.strictEqual(preview.normalizeImageUrl('uploads/2026-07/a.jpg'), '/uploads/2026-07/a.jpg');
  assert.strictEqual(preview.normalizeImageUrl('javascript:alert(1)'), '');
  assert.strictEqual(preview.normalizeImageUrl('https://cdn.example.test/invoice.svg'), '');
  assert.strictEqual(preview.resolveImagePreviewSource({ preview_url: '/uploads/preview.jpg', original_url: '/uploads/original.heic' }).url, '/uploads/preview.jpg');

  const blob = new Blob(['local image'], { type: 'image/jpeg' });
  let revoked = 0;
  const local = preview.createLocalPreview(blob, {
    createObjectURL: () => 'blob:test-local',
    revokeObjectURL: (url) => { assert.strictEqual(url, 'blob:test-local'); revoked += 1; },
  });
  assert.strictEqual(local.url, 'blob:test-local');
  local.revoke();
  local.revoke();
  assert.strictEqual(revoked, 1, 'object URL must be revoked exactly once');

  const componentSource = fs.readFileSync(path.resolve(__dirname, '../../client/admin/src/components/ImageLightbox.jsx'), 'utf8');
  assert.ok(componentSource.includes('圖片載入失敗，可重新上傳'));
  assert.ok(componentSource.includes('object-contain'));
  assert.ok(componentSource.includes('return () => local.revoke()'), 'modal close/unmount must release local preview URL');
  const reconcileSource = fs.readFileSync(path.resolve(__dirname, '../../client/admin/src/pages/ReconcilePage.jsx'), 'utf8');
  assert.ok(reconcileSource.includes('uploaded.preview_url || uploaded.url'));
  assert.ok(reconcileSource.includes('checkoutsApi.reconcile(checkout.checkout_id'), 'existing F-M02 submit remains in place');
}

function testHeifBrandDetection() {
  const synthetic = Buffer.alloc(24);
  synthetic.writeUInt32BE(24, 0);
  synthetic.write('ftyp', 4, 'ascii');
  synthetic.write('mif1', 8, 'ascii');
  synthetic.writeUInt32BE(0, 12);
  synthetic.write('mif1', 16, 'ascii');
  assert.strictEqual(detectImageFormat(synthetic), 'heif');
}

(async () => {
  await testFormats();
  await testOrientation();
  await testMagicAndFailureSafety();
  await testPreviewResolverAndUiContract();
  testHeifBrandDetection();
  console.log('reconcile_image_pipeline_test: PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
