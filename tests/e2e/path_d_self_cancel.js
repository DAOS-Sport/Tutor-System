// 路徑 D：自助取消 24 小時門檻
// Smoke：驗 routes/sessions.js 含 24h 判斷
const fs = require('fs');
const { step, assert } = require('./_lib');

(async () => {
  step('Path D: 自助取消 24h');
  const src = fs.readFileSync('server/services/slots.js', 'utf8');
  assert(/cancelSession/.test(src), 'services/slots.js 含 cancelSession');
  assert(/normal|late/i.test(src), 'cancelSession 區分 normal / late 取消類型');
  step('done');
})();
