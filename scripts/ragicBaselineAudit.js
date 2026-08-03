'use strict';
/**
 * Ragic 同步穩定性 — Phase 0 唯讀基線稽核
 *
 * 唯讀保證（三重）：
 *   1. 每個查詢都包在 BEGIN; SET TRANSACTION READ ONLY; … COMMIT;
 *      —— Postgres 會直接拒絕任何 INSERT/UPDATE/DELETE/DDL，這是最強的機器保證。
 *   2. 只 require('pg')，不 import server/index.js、cron/index.js 或任何 service，
 *      因此不會啟動 server、註冊排程、跑 migration 或 demo seed。
 *      （server/models/db.js 經檢查僅建立 Pool、無副作用，但這裡仍自建連線以完全掌控。）
 *   3. 預設 --local-only：完全不連 Ragic。遠端核對需明確加 --remote-reconcile。
 *
 * 用法：
 *   node scripts/ragicBaselineAudit.js --local-only
 *   node scripts/ragicBaselineAudit.js --remote-reconcile --concurrency=1
 *   可選：--from=2026-07-28 --to=2026-08-03 --output-dir=reports/ragic-baseline --sample-limit=20
 *
 * 本 script 不修改任何資料、不取得 job lock、不動 outbox、不推進 watermark。
 */
const fs = require('fs');
const path = require('path');

const SCRIPT_VERSION = '0.1.0';

// ─────────────────────────────────────────────────────────────
// 遮罩（純函式，可單元測試）
// ─────────────────────────────────────────────────────────────
function maskEmail(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const at = s.indexOf('@');
  if (at < 0) return `${s.slice(0, 2)}***`;               // 非法格式也要遮
  const local = s.slice(0, at);
  const domain = s.slice(at);
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}${domain}`;
}

function maskPhone(v) {
  const s = String(v ?? '').replace(/\D/g, '');
  if (!s) return '';
  if (s.length <= 6) return `${s.slice(0, 2)}${'*'.repeat(Math.max(1, s.length - 2))}`;
  return `${s.slice(0, 2)}${'*'.repeat(s.length - 6)}${s.slice(-4)}`;
}

function maskLineUid(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length <= 9) return `${s.slice(0, 2)}…${s.slice(-2)}`;
  return `${s.slice(0, 5)}…${s.slice(-4)}`;
}

function maskIdNumber(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length <= 4) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 2)}${'*'.repeat(s.length - 5)}${s.slice(-3)}`;
}

function maskUuid(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

// ─────────────────────────────────────────────────────────────
// 分類（純函式，可單元測試）
// ─────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * 判斷一筆待同步家長/學員在「本地資料層面」缺什麼。
 * 刻意只回報 DB 能直接證明的事實；不宣稱這就是 Ragic 實際拒絕的原因
 * （逐筆真實原因只在 console，ragic_sync_log 僅保存 errors[0]）。
 */
function classifyPendingRow(row, kind = 'parent') {
  const reasons = [];
  const missingFields = [];
  const invalidFields = [];

  const emailRaw = row.email;
  if (emailRaw === null || emailRaw === undefined) { reasons.push('email_null'); missingFields.push('email'); }
  else if (String(emailRaw) === '') { reasons.push('email_empty_string'); missingFields.push('email'); }
  else if (String(emailRaw).trim() === '') { reasons.push('email_whitespace_only'); missingFields.push('email'); }
  else if (!EMAIL_RE.test(String(emailRaw).trim())) { reasons.push('email_format_invalid'); invalidFields.push('email'); }

  if (kind === 'parent') {
    if (!String(row.name ?? '').trim()) { reasons.push('missing_name'); missingFields.push('name'); }
    if (!String(row.gender ?? '').trim()) { reasons.push('missing_gender'); missingFields.push('gender'); }
    if (!String(row.primary_venue_id ?? '').trim()) { reasons.push('missing_venue'); missingFields.push('primary_venue_id'); }
  } else {
    if (!String(row.name ?? '').trim()) { reasons.push('missing_name'); missingFields.push('name'); }
    if (!String(row.id_number ?? '').trim()) { reasons.push('missing_id_number'); missingFields.push('id_number'); }
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    missingFields,
    invalidFields,
  };
}

/** 遠端核對結果分類（規格第五節 B）。remote 為 lookup 回傳陣列或錯誤標記。 */
function classifyRemoteReconcile({ remote, error, timedOut, localRagicRecordId }) {
  if (timedOut) return 'remote_lookup_timeout';
  if (error) return 'remote_lookup_error';
  const rows = Array.isArray(remote) ? remote : (remote ? [remote] : []);
  if (rows.length === 0) return 'remote_not_found';
  if (rows.length > 1) return 'remote_found_multiple';
  const remoteId = String(rows[0]?._ragicId ?? rows[0]?.ragicId ?? '').trim();
  if (localRagicRecordId && remoteId && String(localRagicRecordId) !== remoteId) return 'local_remote_conflict';
  return localRagicRecordId ? 'remote_found_single' : 'possible_already_applied';
}

/** 同一 aggregate（parent）多筆 pending → 最新以外視為疑似 superseded。 */
function markSuperseded(items, keyFn = (x) => x.canonical_parent_id) {
  const byKey = new Map();
  for (const it of items || []) {
    const k = keyFn(it);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(it);
  }
  const superseded = new Set();
  for (const [, list] of byKey) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    sorted.slice(1).forEach((x) => superseded.add(x.id));
  }
  return superseded;
}

module.exports = {
  SCRIPT_VERSION,
  maskEmail, maskPhone, maskLineUid, maskIdNumber, maskUuid,
  classifyPendingRow, classifyRemoteReconcile, markSuperseded,
};

// ─────────────────────────────────────────────────────────────
// 以下僅在直接執行時運作；被 require 時不produce任何副作用。
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  main().catch((err) => { console.error('[baseline] 失敗:', err.message); process.exit(1); });
}

function parseArgs(argv) {
  const o = { localOnly: true, remoteReconcile: false, concurrency: 1,
    from: '2026-07-28', to: '2026-08-03', outputDir: 'reports/ragic-baseline', sampleLimit: 20 };
  for (const a of argv.slice(2)) {
    if (a === '--local-only') o.localOnly = true;
    else if (a === '--remote-reconcile') { o.remoteReconcile = true; o.localOnly = false; }
    else if (a.startsWith('--concurrency=')) o.concurrency = Math.max(1, Number(a.split('=')[1]) || 1);
    else if (a.startsWith('--from=')) o.from = a.split('=')[1];
    else if (a.startsWith('--to=')) o.to = a.split('=')[1];
    else if (a.startsWith('--output-dir=')) o.outputDir = a.split('=')[1];
    else if (a.startsWith('--sample-limit=')) o.sampleLimit = Math.max(1, Number(a.split('=')[1]) || 20);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv);
  // pg 只裝在 server/node_modules（根目錄沒有）。先試標準解析，失敗再從 server 取，
  // 避免把 script 綁死在某個 cwd。仍然只 require driver，不碰任何 service。
  let Pool;
  try { ({ Pool } = require('pg')); }
  catch { ({ Pool } = require(path.join(__dirname, '..', 'server', 'node_modules', 'pg'))); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const meta = { queries: 0, ragicRequests: 0, incomplete: [], startedAt: new Date().toISOString() };

  /** 每次查詢都在唯讀交易內執行 —— DB 層強制保證，非約定。 */
  async function q(sql, params = []) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET TRANSACTION READ ONLY');
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      meta.queries += 1;
      return r.rows;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c.release(); }
  }

  const out = path.resolve(opts.outputDir);
  fs.mkdirSync(out, { recursive: true });
  const write = (name, data) => fs.writeFileSync(path.join(out, name),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2));

  // ── A. backup pending ──
  const pendParents = await q(
    `SELECT id, name, phone, email, gender, primary_venue_id, line_uid, ragic_record_id,
            last_synced_at, created_at
       FROM parents
      WHERE is_active AND line_uid IS NOT NULL AND line_uid <> ''
        AND line_uid NOT LIKE 'demo:%' AND line_uid NOT LIKE 'DEMOTEST_%'
        AND (ragic_record_id IS NULL OR last_synced_at IS NULL)
      ORDER BY updated_at ASC`);
  const pendStudents = await q(
    `SELECT s.id, s.name, s.id_number, s.ragic_record_id, s.last_synced_at, s.created_at,
            p.email, p.phone AS parent_phone, p.line_uid
       FROM students s JOIN parents p ON p.id = s.parent_id
      WHERE s.is_active AND p.is_active AND p.line_uid IS NOT NULL AND p.line_uid <> ''
        AND p.line_uid NOT LIKE 'demo:%' AND p.line_uid NOT LIKE 'DEMOTEST_%'
        AND (s.ragic_record_id IS NULL OR s.last_synced_at IS NULL)
      ORDER BY s.updated_at ASC`);

  const tally = (rows, kind) => {
    const byReason = {}; let blocked = 0;
    for (const r of rows) {
      const c = classifyPendingRow(r, kind);
      if (c.blocked) blocked += 1;
      for (const x of c.reasons) byReason[x] = (byReason[x] || 0) + 1;
    }
    return { total: rows.length, blocked, clean: rows.length - blocked, byReason };
  };
  const dupCount = (rows, f) => {
    const m = new Map();
    rows.forEach((r) => { const k = r[f]; if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m.values()].filter((n) => n > 1).length;
  };

  const backup = {
    parents: {
      ...tally(pendParents, 'parent'),
      ragic_record_id_null: pendParents.filter((r) => !r.ragic_record_id).length,
      last_synced_at_null: pendParents.filter((r) => !r.last_synced_at).length,
      both_null: pendParents.filter((r) => !r.ragic_record_id && !r.last_synced_at).length,
      oldest: pendParents[0]?.created_at ?? null,
      newest: pendParents[pendParents.length - 1]?.created_at ?? null,
      duplicate_line_uid_groups: dupCount(pendParents, 'line_uid'),
      duplicate_phone_groups: dupCount(pendParents, 'phone'),
    },
    students: {
      ...tally(pendStudents, 'student'),
      ragic_record_id_null: pendStudents.filter((r) => !r.ragic_record_id).length,
      last_synced_at_null: pendStudents.filter((r) => !r.last_synced_at).length,
    },
    caveat: 'byReason 僅表示本地資料品質；Ragic 逐筆實際拒絕原因只在 console，ragic_sync_log 僅保存 errors[0]。',
  };
  write('backup-pending.json', backup);
  write('backup-pending.csv',
    ['kind,id_masked,reasons,missing,invalid,email_masked,phone_masked']
      .concat(pendParents.slice(0, opts.sampleLimit).map((r) => {
        const c = classifyPendingRow(r, 'parent');
        return `parent,${maskUuid(r.id)},"${c.reasons.join('|')}","${c.missingFields.join('|')}","${c.invalidFields.join('|')}",${maskEmail(r.email)},${maskPhone(r.phone)}`;
      }))
      .concat(pendStudents.slice(0, opts.sampleLimit).map((r) => {
        const c = classifyPendingRow(r, 'student');
        return `student,${maskUuid(r.id)},"${c.reasons.join('|')}","${c.missingFields.join('|')}","${c.invalidFields.join('|')}",${maskEmail(r.email)},${maskPhone(r.parent_phone)}`;
      })).join('\n'));

  // ── B. outbox ──
  const obItems = await q(
    `SELECT o.id, o.operation, o.state, o.attempts, o.created_at, o.updated_at,
            o.last_error_code, o.source_record_id, o.target_record_id, o.claim_id,
            c.canonical_parent_id, p.line_uid, p.ragic_record_id AS local_ragic_record_id
       FROM ragic_sync_outbox o
       LEFT JOIN identity_claims c ON c.id = o.claim_id
       LEFT JOIN parents p ON p.id = c.canonical_parent_id
      ORDER BY o.created_at`);
  const supersededSet = markSuperseded(obItems);
  const group = (f) => obItems.reduce((a, r) => { const k = r[f] ?? 'null'; a[k] = (a[k] || 0) + 1; return a; }, {});
  const outbox = {
    total: obItems.length,
    by_state: group('state'),
    by_operation: group('operation'),
    by_attempts: group('attempts'),
    by_error_code: group('last_error_code'),
    oldest_pending: obItems.find((r) => r.state === 'pending')?.created_at ?? null,
    newest_pending: [...obItems].reverse().find((r) => r.state === 'pending')?.created_at ?? null,
    processing_over_lease: obItems.filter((r) => r.state === 'processing'
      && (Date.now() - new Date(r.updated_at).getTime()) > 15 * 60 * 1000).length,
    distinct_parents: new Set(obItems.map((r) => r.canonical_parent_id).filter(Boolean)).size,
    suspected_superseded: supersededSet.size,
    backoffice_tasks: (await q(`SELECT count(*)::int n FROM parent_identity_backoffice_tasks`))[0]?.n ?? 0,
  };
  write('outbox-summary.json', outbox);
  write('outbox-items-masked.csv',
    ['id_masked,operation,state,attempts,created_at,error_code,line_uid_masked,superseded']
      .concat(obItems.slice(0, opts.sampleLimit).map((r) =>
        `${maskUuid(r.id)},${r.operation},${r.state},${r.attempts},${new Date(r.created_at).toISOString()},${r.last_error_code || ''},${maskLineUid(r.line_uid)},${supersededSet.has(r.id)}`)).join('\n'));

  // ── C. lock / job history ──
  write('lock-status.json', {
    locks: (await q(`SELECT job_name, holder_id, run_id, locked_until,
                            (locked_until < NOW()) AS expired FROM job_locks`))
      .map((r) => ({ ...r, holder_id: maskUuid(r.holder_id), run_id: maskUuid(r.run_id) })),
    shared_lock_jobs: ['staff', 'venues', 'parents', 'students', 'backup', 'pull'],
    note: '六個 Ragic 工作共用同一把 ragic_sync 鎖（ragicAdmin.js RAGIC_LOCKED_JOBS）。',
  });
  write('job-history.json', {
    by_status: await q(`SELECT status, count(*)::int n, max(started_at) latest
                          FROM job_runs WHERE started_at >= $1 GROUP BY 1 ORDER BY 2 DESC`, [opts.from]),
    aborted: await q(`SELECT started_at, finished_at,
                             round(EXTRACT(epoch FROM finished_at-started_at))::int seconds
                        FROM job_runs WHERE status='aborted' AND started_at >= $1 ORDER BY started_at`, [opts.from]),
    duration: (await q(`SELECT min(duration_ms)::int min_ms, round(avg(duration_ms))::int avg_ms,
                               max(duration_ms)::int max_ms, count(*)::int n
                          FROM job_runs WHERE status='success' AND started_at >= $1`, [opts.from]))[0],
  });

  // ── D. H01 watermark ──
  write('h01-watermark.json', {
    watermark_rows: await q(`SELECT key, value, updated_at FROM admin_settings WHERE key ILIKE '%watermark%'`),
    recent_runs: await q(`SELECT created_at, job_name, form_code, status, synced_count, duration_ms
                            FROM ragic_sync_log WHERE form_code LIKE 'H01%' AND created_at >= $1
                           ORDER BY created_at DESC LIMIT 30`, [opts.from]),
    cron: { schedule: '*/10 * * * *', triggered_by: 'cron',
      incremental_condition: "triggeredBy === 'manual' && !!watermark",
      note: 'cron 觸發一律全量；增量僅在手動觸發且已有 watermark 時啟用。' },
  });

  // ── E. 錯誤表 ──
  write('error-tables-summary.json', {
    range: { from: opts.from, to: opts.to },
    ragic_sync_log: await q(`SELECT status, count(*)::int n FROM ragic_sync_log
                              WHERE created_at >= $1 GROUP BY 1 ORDER BY 2 DESC`, [opts.from]),
    samples: (await q(`SELECT created_at, job_name, form_code, status, left(COALESCE(error_message,''),200) msg
                         FROM ragic_sync_log WHERE created_at >= $1 AND status='error'
                        ORDER BY created_at DESC LIMIT $2`, [opts.from, opts.sampleLimit])),
    limitation: 'ragic_sync_log 僅保存 errors[0]；逐筆失敗原因只在 Replit console，DB 無法還原。',
  });

  // ── 遠端核對（僅在明確指定時）──
  if (opts.remoteReconcile) {
    meta.incomplete.push('remote-reconciliation：本輪未實作遠端呼叫，需先確認 Ragic 查詢端點無寫入副作用。');
    write('remote-reconciliation.json', { skipped: true, reason: meta.incomplete[meta.incomplete.length - 1] });
  } else {
    write('remote-reconciliation.json', { skipped: true, reason: 'local-only 模式，未連線 Ragic。' });
  }

  write('audit-metadata.json', {
    started_at: meta.startedAt, finished_at: new Date().toISOString(),
    script_version: SCRIPT_VERSION, options: opts,
    local_only: !opts.remoteReconcile, remote_reconcile: opts.remoteReconcile,
    db_queries: meta.queries, ragic_requests: meta.ragicRequests,
    completed: true, incomplete_sections: meta.incomplete,
    read_only_guarantee: '每個查詢皆於 BEGIN; SET TRANSACTION READ ONLY; … COMMIT; 內執行。',
  });

  write('baseline-summary.md', [
    '# Ragic 同步 Phase 0 唯讀基線', '',
    `產出時間：${meta.startedAt}`, `模式：${opts.remoteReconcile ? 'remote-reconcile' : 'local-only'}`,
    `DB 查詢數：${meta.queries}`, '',
    '## Backup pending',
    `- 家長 ${backup.parents.total}（本地資料有缺 ${backup.parents.blocked}）`,
    `- 學員 ${backup.students.total}（本地資料有缺 ${backup.students.blocked}）`, '',
    '## Outbox',
    `- 總計 ${outbox.total}，涉及 ${outbox.distinct_parents} 位家長`,
    `- 疑似 superseded ${outbox.suspected_superseded}`,
    `- 超過 lease 的 processing ${outbox.processing_over_lease}`, '',
    '## 限制', `- ${backup.caveat}`,
  ].join('\n'));

  console.log(`[baseline] 完成，輸出於 ${out}（DB 查詢 ${meta.queries} 次，全部唯讀）`);
  await pool.end();
}