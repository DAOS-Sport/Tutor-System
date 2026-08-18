/**
 * 上傳錯誤轉譯（2026-08-18）
 *
 * multer 的 MulterError 沒有 .status，會一路掉到 index.js 的全域錯誤處理，
 * 被當成未預期例外 → 500 + 英文 "File too large"。
 * 實測（修前，POST /coaches/:id/avatar 傳 6MB）：500 {"error":"File too large"}
 * 使用者只看到「上傳失敗」，日誌則多一筆 [unhandled] 把真正的 500 淹掉。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}
function strip(src) {
  return src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const { singleUpload, CODE_MESSAGE } = require(path.join(ROOT, 'server/middlewares/uploadError'));

check('每個 multer 上傳端點都要包錯誤轉譯（白名單式）', () => {
  const files = ['coaches.js', 'chat.js', 'learn.js', 'uploads.js', 'admin/uploads.js']
    .map((f) => ({ f, src: strip(fs.readFileSync(path.join(ROOT, 'server/routes', f), 'utf8')) }))
    .filter((x) => /multer/.test(x.src));
  assert.ok(files.length >= 5, '只掃到 ' + files.length + ' 個 multer 檔案 —— 掃描失效');

  // 裸露的 .single() 直接當 middleware＝沒有轉譯。允許的只有兩種：
  //   1) 包在 singleUpload() 裡（共用 helper）
  //   2) 自己用 callback 形式接住 err（uploads.js / admin/uploads.js 的既有寫法）
  const bad = [];
  for (const { f, src } of files) {
    for (const m of src.matchAll(/(\w+)\.single\((['"])\w+\2\)/g)) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const before = src.slice(Math.max(0, m.index - 30), m.index);
      const wrapped = /singleUpload\(/.test(before) || /^\s*\(\s*req\s*,\s*res\s*,/.test(after);
      if (!wrapped) bad.push(f + ' → ' + m[0]);
    }
  }
  assert.deepStrictEqual(bad, [],
    '這些 .single() 沒有錯誤轉譯，檔案過大會回 500＋英文訊息：\n         ' + bad.join('\n         '));
});

check('檔案過大回 413，不是 500', () => {
  const src = strip(fs.readFileSync(path.join(ROOT, 'server/middlewares/uploadError.js'), 'utf8'));
  assert.ok(/LIMIT_FILE_SIZE'\s*\?\s*413/.test(src), '檔案過大不是 413');
  assert.ok(!/status\(500\)/.test(src), '轉譯層不該回 500 —— 那是「未預期」才用的');
});

check('訊息是中文，且帶得出上限', () => {
  assert.strictEqual(CODE_MESSAGE.LIMIT_FILE_SIZE(5), '檔案大小不得超過 5MB');
  // 訊息主體要中文，但「file」是欄位名（前端 FormData 的 key），照原樣寫才有用。
  // 第一版斷言「不准出現 4 個以上英文字母」直接把它誤判成英文訊息。
  const unexpected = CODE_MESSAGE.LIMIT_UNEXPECTED_FILE();
  assert.ok(/[一-鿿]/.test(unexpected), '訊息沒有中文');
  assert.ok(/file/.test(unexpected), '沒有指出正確的欄位名，前端不知道要改什麼');
  // 每個 multer 錯誤碼都要有對應訊息，否則會退回英文原文。
  for (const code of ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE',
    'LIMIT_PART_COUNT', 'LIMIT_FIELD_KEY', 'LIMIT_FIELD_VALUE', 'LIMIT_FIELD_COUNT']) {
    assert.ok(typeof CODE_MESSAGE[code] === 'function', code + ' 沒有對應訊息');
  }
});

check('fileFilter 自己丟的錯不被覆蓋（它本來就對）', () => {
  const src = strip(fs.readFileSync(path.join(ROOT, 'server/middlewares/uploadError.js'), 'utf8'));
  assert.ok(/Number\(err\.status\) \|\| 400/.test(src),
    '沒有沿用 err.status —— fileFilter 帶的 400 會被蓋掉');
});

check('轉譯層行為（直接呼叫，不必起伺服器）', () => {
  const fake = { single: () => (req, res, cb) => cb(Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' })) };
  const mw = singleUpload(fake, 5 * 1024 * 1024);
  let out = null;
  mw({}, { status(s) { out = { s }; return { json(b) { out.b = b; } }; } }, () => { out = 'next'; });
  assert.strictEqual(out.s, 413, '檔案過大應回 413，實際 ' + out.s);
  assert.strictEqual(out.b.error, '檔案大小不得超過 5MB');
  assert.strictEqual(out.b.code, 'LIMIT_FILE_SIZE');

  // 沒錯誤時必須放行。
  const ok = { single: () => (req, res, cb) => cb(null) };
  let passed = false;
  singleUpload(ok, 1)({}, {}, () => { passed = true; });
  assert.ok(passed, '沒有錯誤時沒有呼叫 next()');
});

if (failures) { console.error('\nupload_error_test: ' + failures + ' failed'); process.exit(1); }
console.log('upload_error_test: all passed');
