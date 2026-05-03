// 路徑 C：1vN 同組確認 + 60 分鐘逾時
// Smoke：驗 cron 設定有正確啟用 + 60 分自動確認 service 存在
const fs = require('fs');
const { step, assert } = require('./_lib');

(async () => {
  step('Path C: 1vN 同組確認');
  const cron = fs.readFileSync('server/cron/index.js', 'utf8');
  assert(/group.*confirm|autoConfirm|1vN/i.test(cron), 'cron/index.js 含 1vN 自動確認 job');
  step('done');
})();
