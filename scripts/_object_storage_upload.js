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
    // 從 server/node_modules 解析（依賴裝在 server/package.json）
    const resolved = require.resolve('@replit/object-storage', {
      paths: [path.resolve(__dirname, '..', 'server', 'node_modules'), path.resolve(__dirname, '..')],
    });
    ({ Client } = require(resolved));
  } catch (_e) {
    console.error('[upload] @replit/object-storage SDK 未安裝且找不到 replit CLI，無法上傳遠端。');
    console.error('[upload] 解法：在 server 目錄 `npm i @replit/object-storage` 或安裝 replit CLI 後重跑。');
    process.exit(3); // 與 backup_db.sh 對應的非 0 exit code，避免靜默失敗
  }
  const c = new Client({ bucketId: process.env.REPLIT_OBJECT_STORAGE_BUCKET });
  const buf = fs.readFileSync(file);
  const { ok, error } = await c.uploadFromBytes(key, buf);
  if (!ok) { console.error('[upload] failed:', error); process.exit(1); }
  console.log('[upload] ok ->', key, `(${buf.length} bytes)`);
})();
