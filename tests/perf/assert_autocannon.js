#!/usr/bin/env node
'use strict';
// 讀 autocannon --json（stdin），任何非 2xx、連線錯誤、逾時或零成功請求都判失敗。
// autocannon 本身遇到 500 或連不上仍 exit 0，不能拿它的 exit code 當成功。
// autocannon 不輸出 P95，這裡如實列 P90 / P97.5，不自行換算。

function judge(result) {
  const ok2xx = result['2xx'] || 0;
  const problems = [];
  if (result.non2xx) problems.push(`non-2xx=${result.non2xx}`);
  if (result.errors) problems.push(`errors=${result.errors}`);
  if (result.timeouts) problems.push(`timeouts=${result.timeouts}`);
  if (ok2xx === 0) problems.push('2xx=0');
  const l = result.latency || {};
  const summary = `2xx=${ok2xx} p50=${l.p50}ms p90=${l.p90}ms p97.5=${l.p97_5}ms p99=${l.p99}ms`;
  return { pass: problems.length === 0, summary, problems };
}

module.exports = { judge };

if (require.main === module) {
  const name = process.argv[2] || '';
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      console.error(`FAIL ${name} autocannon 沒有輸出可解析的 JSON`);
      process.exit(1);
    }
    const { pass, summary, problems } = judge(result);
    if (pass) {
      console.log(`PASS ${name} ${summary}`);
    } else {
      console.error(`FAIL ${name} ${problems.join(' ')} | ${summary}`);
      process.exit(1);
    }
  });
}
