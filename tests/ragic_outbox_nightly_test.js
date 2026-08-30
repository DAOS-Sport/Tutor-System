/**
 * Ragic 回寫改成夜間批次（2026-08-30 使用者決策）。
 *
 * 決策內容：Ragic 對這套系統只是備份，白天不必為了它整天打外部 API；
 * 日間呼叫還會跟 00:30 全量備份、01:30 拉回搶同一把 ragic_sync 鎖。
 *
 * 這支測試盯兩件容易被改回去、又不會有人立刻發現的事：
 *   1. 排程真的是夜間、而且排在 00:30 備份之前（順序錯了，01:30 拉回會拿到殘缺資料）
 *   2. 夜間那一次要把佇列排空，不能只做 20 筆
 *      —— 一天一次卻只做 20 筆，累積量永遠追不上（正式站曾積到 295 筆）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server/cron/index.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

/** 取出包住 processRagicSyncOutbox 的那個 scheduleTaipei 區塊。 */
function outboxBlock() {
  const i = code.indexOf('processRagicSyncOutbox(');
  assert.ok(i > 0, '找不到 outbox 排程');
  const start = code.lastIndexOf('scheduleTaipei(', i);
  assert.ok(start >= 0, '找不到 outbox 的 scheduleTaipei');
  return { start, block: code.slice(start, i + 600) };
}

t('回寫排在夜間，不是每 5 分鐘', () => {
  const { block } = outboxBlock();
  const m = block.match(/scheduleTaipei\(\s*'([^']+)'/);
  assert.ok(m, '讀不出 cron 運算式');
  const expr = m[1];
  assert.ok(!/^\*\/\d+/.test(expr),
    'cron 是 ' + expr + ' —— 又變回高頻輪詢了。白天不該為了備份用途整天打 Ragic');
  const [min, hour] = expr.split(/\s+/);
  assert.ok(/^\d+$/.test(hour) && Number(hour) <= 4,
    '應該排在凌晨，目前 hour=' + hour);
  const at = Number(hour) * 60 + Number(min);
  assert.ok(at < 30, '必須早於 00:30 的全量備份（目前 ' + hour + ':' + min + '）——'
    + '順序反了的話，01:30 的拉回會拿到還沒補上 UID 的殘缺資料');
});

t('夜間那一次要把佇列排空，不是只做一批', () => {
  const { block } = outboxBlock();
  assert.ok(/for\s*\(/.test(block),
    '沒有迴圈：一天只跑一次卻只處理 limit 筆，累積量永遠追不上'
    + '（正式站曾經積到 295 筆）');
  assert.ok(/round\s*<\s*\d+/.test(block) || /<\s*\d+;\s*round/.test(block),
    '迴圈沒有上限：單筆壞資料就會變成無窮迴圈');
});

t('旗標關閉時不跑（外部寫入必須是 opt-in）', () => {
  const { block } = outboxBlock();
  assert.ok(/STABILITY_FLAGS\.RAGIC_PARENT_OUTBOX/.test(block),
    '少了 RAGIC_PARENT_OUTBOX 判斷 —— 對外部系統的寫入不可以預設開啟');
});

console.log('\n' + n + ' 個測試全數通過');

