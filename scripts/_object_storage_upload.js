// 備援上傳器：當沒有 replit CLI 時改用 @replit/object-storage SDK。
// usage: node scripts/_object_storage_upload.js <key> <local-file>
const fs = require('fs');
const path = require('path');

(async () => {
  const [, , key, file] = process.argv;
  if (!key || !file) {
    console.error('usage: node _object_storage_upload.js <key> <file>');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error('[upload] file not found:', file);
    process.exit(2);
  }
  let Client;
  try {
    ({ Client } = require('@replit/object-storage'));
  } catch (_e) {
    console.error('[upload] @replit/object-storage 未安裝，跳過遠端上傳；本地檔保留：', file);
    return; // 不致命：腳本仍視為成功（檔案至少已產出）
  }
  const c = new Client({ bucketId: process.env.REPLIT_OBJECT_STORAGE_BUCKET });
  const buf = fs.readFileSync(file);
  const { ok, error } = await c.uploadFromBytes(key, buf);
  if (!ok) { console.error('[upload] failed:', error); process.exit(1); }
  console.log('[upload] ok ->', key, `(${buf.length} bytes)`);
})();
