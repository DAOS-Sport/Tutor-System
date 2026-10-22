'use strict';
// health-v1 格式檢查（與 tools/health-hub 的 contract.rs 同一套規則），給健康 API 的測試共用。
const LEVELS = ['green', 'yellow', 'red'];
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function contractProblems(report) {
  const problems = [];
  const isTime = (v) => typeof v === 'string' && RFC3339.test(v) && !Number.isNaN(Date.parse(v));
  if (!report || typeof report !== 'object') return ['不是物件'];
  if (typeof report.system !== 'string' || !report.system) problems.push('system 不是非空字串');
  if (typeof report.build !== 'string') problems.push('build 不是字串');
  if (!isTime(report.checkedAt)) problems.push('checkedAt 不是帶時區的 RFC 3339');
  if (!LEVELS.includes(report.overall)) problems.push('overall 不是三種燈號之一');
  if (!Array.isArray(report.pipelines) || !report.pipelines.length) return problems.concat('pipelines 是空的');
  const seen = new Set();
  report.pipelines.forEach((p, i) => {
    const at = `pipelines[${i}]`;
    if (typeof p.id !== 'string' || !p.id.trim()) problems.push(`${at}.id 是空的`);
    else if (seen.has(p.id)) problems.push(`${at}.id 重複：${p.id}`);
    seen.add(p.id);
    if (typeof p.name !== 'string' || !p.name) problems.push(`${at}.name 是空的`);
    if (!LEVELS.includes(p.level)) problems.push(`${at}.level 不是三種燈號之一：${p.level}`);
    if (typeof p.reason !== 'string' || !p.reason) problems.push(`${at}.reason 是空的`);
    for (const k of ['lastSuccessAt', 'lastFailureAt']) {
      if (p[k] !== undefined && p[k] !== null && !isTime(p[k])) problems.push(`${at}.${k} 不是 RFC 3339 或 null：${p[k]}`);
    }
    if (p.source !== undefined && p.source !== null && typeof p.source !== 'string') problems.push(`${at}.source 不是字串或 null`);
  });
  const worst = report.pipelines.reduce((a, p) => (LEVELS.indexOf(p.level) > LEVELS.indexOf(a) ? p.level : a), 'green');
  if (report.overall !== worst) problems.push(`overall=${report.overall}，但最嚴重的管線是 ${worst}`);
  return problems;
}

module.exports = { contractProblems, LEVELS };
