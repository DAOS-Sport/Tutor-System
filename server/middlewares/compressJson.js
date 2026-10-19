'use strict';
// 大型 API JSON 回應壓縮（內建 zlib，不加 compression 套件）。
//
// 後台桌機版的報名清單一次載入全部（刻意設計），正式庫破千筆時單次回應約 1 MB 純文字；
// JSON 重複欄位多，br 壓縮後約剩 1/10。只處理 res.json() 且超過門檻的回應：
// 小回應壓縮的 CPU 成本不划算，串流／檔案下載本來就不走 res.json()。
// 狀態碼、其他標頭、ETag／304 行為都沿用 Express 的 res.send()。
const zlib = require('zlib');
const { pickEncoding } = require('./staticFrontend');

const THRESHOLD_BYTES = 64 * 1024;

function compress(buf, encoding) {
  return new Promise((resolve, reject) => {
    const done = (err, out) => (err ? reject(err) : resolve(out));
    // 動態內容每次都要壓：br 用品質 4（速度優先），在 libuv 執行緒池做，不卡住事件迴圈。
    if (encoding === 'br') {
      zlib.brotliCompress(buf, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
      }, done);
    } else {
      zlib.gzip(buf, { level: 6 }, done);
    }
  });
}

function compressLargeJson({ threshold = THRESHOLD_BYTES } = {}) {
  return (req, res, next) => {
    const encoding = req.method === 'HEAD' ? null : pickEncoding(req.headers['accept-encoding']);
    const original = res.json.bind(res);
    res.json = (body) => {
      const text = JSON.stringify(body);
      if (text === undefined || Buffer.byteLength(text) < threshold || res.getHeader('Content-Encoding')) {
        return original(body);
      }
      // 大回應不論這次有沒有壓縮都要帶 Vary，否則快取可能把未壓縮版回給支援壓縮的客戶端。
      res.vary('Accept-Encoding');
      if (!encoding) return original(body);
      compress(Buffer.from(text), encoding).then((buf) => {
        if (res.headersSent) return;
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Content-Encoding', encoding);
        res.send(buf);
      }, (err) => {
        console.warn('[compressJson] 壓縮失敗，改送未壓縮：' + err.message);
        if (!res.headersSent) original(body);
      });
      return res;
    };
    return next();
  };
}

module.exports = { compressLargeJson, THRESHOLD_BYTES };
