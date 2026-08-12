// 唯讀診斷：只回報「拿不拿得到 token」，絕不印出 token 內容，不打 LINE、不發訊息。
//
// 2026-08-12 改寫。原本這支會逐一掃 admin_venues 的每個場館去要 token，
// 而 25 個場館裡只有 4 個曾經設過 —— 掃一輪就吐 21 行 ERROR，把真問題淹掉。
// 各館各自 token 的機制已移除，全站只有一個推播管道，所以這裡也只需要檢查那一個。
const line = require('../services/line');
const { STAFF_CHANNEL } = require('../services/lineRouting');

(async () => {
  console.log('=== LINE 推播管道 ===');
  console.log('  管道：' + STAFF_CHANNEL + '（全站唯一；各館各自 token 已於 2026-08-12 移除）');
  try {
    const t = line._getTokenForDiagnostics();
    console.log('  token：拿得到 ✓（長度 ' + t.length + '）');
  } catch (e) {
    console.log('  token：** ' + e.message + ' **');
    console.log('  → 所有 LINE 推播都會失敗。請設 LINE_MESSAGING_TOKEN_' + STAFF_CHANNEL
      + '，或在 LINE_MESSAGING_TOKENS 內加上 "' + STAFF_CHANNEL + '"。');
  }
  // 只列名稱不列值：知道「設了哪些」就足以判斷是不是打錯 key。
  const envNames = Object.keys(process.env).filter((k) => k.startsWith('LINE_MESSAGING_TOKEN')).sort();
  console.log('\n=== 目前設定的變數（只列名稱）===');
  envNames.forEach((k) => console.log('  ' + k));
  let jsonKeys = [];
  try { jsonKeys = Object.keys(JSON.parse(process.env.LINE_MESSAGING_TOKENS || '{}')); } catch (_) { jsonKeys = ['** JSON 格式錯誤 **']; }
  console.log('  LINE_MESSAGING_TOKENS 內的 key：' + (jsonKeys.length ? jsonKeys.join(', ') : '（空）'));
  console.log('\n  （非 ' + STAFF_CHANNEL + ' 的 key 目前不會被使用，留著不影響推播。）');
  process.exit(0);
})().catch((e) => { console.log('失敗：' + e.message); process.exit(1); });
