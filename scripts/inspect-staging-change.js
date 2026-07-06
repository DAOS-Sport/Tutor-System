#!/usr/bin/env node
/**
 * A7（熊韋程卡在 pending 調查）診斷用唯讀腳本。
 *
 * 背景：使用者回報一筆員工（熊韋程）的 Ragic H01 同步 staging change 卡在
 * pending 狀態、無法核准。這支腳本本身不能在此開發環境查到正式環境的真實
 * 資料（沙盒無法連線正式 DB），只負責提供一個「之後可以直接對正式 DB 跑」
 * 的查詢工具——讓人工用 entity_id（員編）或姓名關鍵字，把 ragic_staging_changes
 * 裡卡住的那筆完整資料（payload / diff / status / fetched_at / reviewed_at /
 * reject_reason）印出來，判斷是「從未被核准過」（正常待審）還是「核准後仍卡在
 * pending」（真正的 bug，需要重放 apply 找出實際拋出的例外）。
 *
 * 純讀取（SELECT only），不修改任何資料。
 *
 * 用法：
 *   node scripts/inspect-staging-change.js 熊韋程
 *   node scripts/inspect-staging-change.js C0123
 *   node scripts/inspect-staging-change.js 熊韋程 --status=pending   # 限定狀態
 *   node scripts/inspect-staging-change.js 熊韋程 --json             # 純 JSON 輸出（供其他工具解析）
 */
const path = require('path');
// 環境變數已由 Replit Secrets 或外層 shell 注入；不依賴 dotenv（比照本 repo 其他 scripts）
const { pool } = require(path.join(__dirname, '..', 'server', 'models', 'db'));

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    const m = /^--([a-zA-Z_]+)=(.*)$/.exec(a);
    if (m) { flags[m[1]] = m[2]; continue; }
    if (a === '--json') { flags.json = true; continue; }
    positional.push(a);
  }
  return { query: positional.join(' ').trim(), flags };
}

async function main() {
  const { query, flags } = parseArgs(process.argv.slice(2));
  if (!query) {
    console.error('usage: node scripts/inspect-staging-change.js <entity_id 或姓名關鍵字> [--status=pending] [--json]');
    process.exit(2);
  }

  const where = [`(entity_id ILIKE $1 OR payload_json::text ILIKE $1 OR diff_json::text ILIKE $1)`];
  const vals = [`%${query}%`];
  if (flags.status) {
    vals.push(flags.status);
    where.push(`status = $${vals.length}`);
  }

  const sql = `
    SELECT s.id, s.form_code, s.entity_type, s.entity_id, s.change_type, s.status,
           s.payload_json, s.diff_json, s.fetched_at, s.reviewed_at, s.reviewed_by,
           s.reject_reason, u.name AS reviewer_name
      FROM ragic_staging_changes s
      LEFT JOIN admin_users u ON u.id = s.reviewed_by
     WHERE ${where.join(' AND ')}
     ORDER BY s.fetched_at DESC
     LIMIT 50`;
  const r = await pool.query(sql, vals);

  if (flags.json) {
    console.log(JSON.stringify(r.rows, null, 2));
  } else {
    if (!r.rowCount) {
      console.log(`找不到符合「${query}」的 ragic_staging_changes 記錄。`);
    } else {
      console.log(`找到 ${r.rowCount} 筆符合「${query}」的記錄：\n`);
      for (const row of r.rows) {
        console.log('─'.repeat(72));
        console.log(`id            : ${row.id}`);
        console.log(`form_code     : ${row.form_code}`);
        console.log(`entity_type   : ${row.entity_type}`);
        console.log(`entity_id     : ${row.entity_id}`);
        console.log(`change_type   : ${row.change_type}`);
        console.log(`status        : ${row.status}`);
        console.log(`fetched_at    : ${row.fetched_at ? row.fetched_at.toISOString() : ''}`);
        console.log(`reviewed_at   : ${row.reviewed_at ? row.reviewed_at.toISOString() : '(尚未審核)'}`);
        console.log(`reviewed_by   : ${row.reviewer_name || row.reviewed_by || ''}`);
        console.log(`reject_reason : ${row.reject_reason || ''}`);
        console.log(`payload_json  : ${JSON.stringify(row.payload_json, null, 2)}`);
        console.log(`diff_json     : ${JSON.stringify(row.diff_json, null, 2)}`);
      }
      console.log('─'.repeat(72));
      console.log(
        '\n判斷方式：\n'
        + '  - status=pending 且 reviewed_at 為空 → 從未被核准過（正常待審，非 bug）。\n'
        + '  - status=pending 但 reviewed_at 非空 → 曾經 approve 過又被 ROLLBACK 回 pending，\n'
        + '    代表 applyStagedChange 內部拋出例外——請查伺服器 log（[ragic-staging approve]\n'
        + '    failed to apply staged change，含 entity_id + 完整 stack）找出實際的\n'
        + '    SQL/約束失敗原因，或用上面印出的 payload_json 對照 _applyStaffChange /\n'
        + '    _applyCoachChange / _applyVenueChange（server/services/ragicAdmin.js）重放。'
      );
    }
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
