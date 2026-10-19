'use strict';
// 兩個前端每一頁都會載入 favicon。原本直接用 1254×1254、992 KB 的品牌原圖，
// 等於每個新分頁多下載將近 1 MB。這裡鎖住：圖示檔要存在，而且每個不超過 32 KB。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAX_BYTES = 32 * 1024;

for (const app of ['admin', 'liff']) {
  const html = fs.readFileSync(path.join(ROOT, `client/${app}/index.html`), 'utf8');
  const icons = [...html.matchAll(/<link[^>]+rel="(?:icon|apple-touch-icon)"[^>]*>/g)].map((m) => m[0].match(/href="([^"]+)"/)[1]);
  assert.ok(icons.length >= 1, `${app} 沒有 favicon`);
  for (const href of icons) {
    assert.match(href, /^\/brand\//, `${app} 的圖示應放在 /brand/（由 server 以靜態檔提供）`);
    const file = path.join(ROOT, 'server/public', href);
    assert.ok(fs.existsSync(file), `${app} 引用的 ${href} 不存在`);
    const size = fs.statSync(file).size;
    assert.ok(size <= MAX_BYTES, `${app} 的 ${href} 有 ${size} bytes，超過 ${MAX_BYTES}`);
  }
}
console.log('PASS 兩個前端的 favicon 都存在且不超過 32 KB');
