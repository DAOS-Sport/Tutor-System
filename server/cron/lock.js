/**
 * 部署鎖死工單（launch-20260707 B 段）：Cron 單一執行權，DB 租約層 + run ledger。
 *
 * 四層鎖：平台層（Reserved VM / Autoscale+Scheduled Deployment，工單 A1，人工決策）
 * → 旗標層（cron/index.js 的 ENABLE_CRON 檢查）→ **這支檔案：DB 租約層** → 冪等層
 * （各 job 業務邏輯自身的 ON CONFLICT/claim-first 等既有機制，工單 B.5 逐一盤點）。
 *
 * 取鎖用單一原子 UPSERT（INSERT ... ON CONFLICT ... WHERE locked_until < now()），
 * 不用 pg_advisory_lock——advisory lock 綁定在單一 DB session/connection 上，
 * 連線池環境下同一個「邏輯執行」實際用哪個連線不可控，lock 可能在還沒執行完就
 * 被連線池收回而提早釋放，不可靠（工單 B.2 決策）。
 */
const crypto = require('crypto');
const os = require('os');
const { pool } = require('../models/db');

const BOOT_TS = Date.now();
const HOLDER_ID = `${os.hostname()}-${process.pid}-${BOOT_TS}`;

// 尚無成功執行歷史（全新 job，或 job_runs 剛建表）時的保底 TTL。
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MIN_TTL_MS = 10 * 1000; // 即使歷史耗時極短，也給至少 10 秒緩衝，防抖動誤判

function getHolderId() {
  return HOLDER_ID;
}

/** TTL = 該 job 歷史最長成功耗時的 3 倍（工單 B.2）。 */
async function computeTtlMs(jobName) {
  const r = await pool.query(
    `SELECT MAX(duration_ms) AS max_ms FROM job_runs WHERE job_name = $1 AND status = 'success'`,
    [jobName]
  );
  const maxMs = Number(r.rows[0]?.max_ms);
  if (!maxMs || !Number.isFinite(maxMs)) return DEFAULT_TTL_MS;
  return Math.max(maxMs * 3, MIN_TTL_MS);
}

/**
 * 原子取鎖。回傳 { acquired: true, runId } 或 { acquired: false, currentHolder }。
 * 取鎖成功會順便開一筆 job_runs（status='running'）；若這次是搶到一把「已過期」
 * 的鎖（代表前一個 holder 執行中途死掉、沒機會自己收尾），把它那筆 run 標
 * aborted（工單 PASS 判準第 3 項）。
 */
async function acquireJobLock(jobName, triggeredBy) {
  const ttlMs = await computeTtlMs(jobName);

  // 取鎖前先讀一次現況，只用來判斷「等一下搶到的是不是一把過期的鎖」，不參與
  // 取鎖本身的原子性判斷（那由下面的 UPSERT 的 WHERE 子句單獨負責）。這中間有
  // 極小的讀取窗口，但最壞情況只是把一筆「剛好也在同時完成」的 run 誤標
  // aborted——只影響記錄用的狀態欄位，不影響鎖本身的互斥保證。
  const before = await pool.query(
    `SELECT holder_id, run_id, locked_until FROM job_locks WHERE job_name = $1`,
    [jobName]
  );
  const staleRow = (before.rowCount && new Date(before.rows[0].locked_until) < new Date())
    ? before.rows[0] : null;

  const runId = crypto.randomUUID();
  const r = await pool.query(
    `INSERT INTO job_locks (job_name, holder_id, locked_until, run_id)
     VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval, $4)
     ON CONFLICT (job_name) DO UPDATE SET
       holder_id = EXCLUDED.holder_id,
       locked_until = EXCLUDED.locked_until,
       run_id = EXCLUDED.run_id
     WHERE job_locks.locked_until < NOW()
     RETURNING run_id`,
    [jobName, HOLDER_ID, ttlMs, runId]
  );

  if (!r.rowCount) {
    const cur = await pool.query(`SELECT holder_id FROM job_locks WHERE job_name = $1`, [jobName]);
    return { acquired: false, currentHolder: cur.rows[0]?.holder_id || 'unknown' };
  }

  if (staleRow && staleRow.run_id) {
    await pool.query(
      `UPDATE job_runs SET status = 'aborted', finished_at = NOW() WHERE id = $1 AND status = 'running'`,
      [staleRow.run_id]
    );
  }

  await pool.query(
    `INSERT INTO job_runs (id, job_name, holder_id, status, triggered_by)
     VALUES ($1, $2, $3, 'running', $4)`,
    [runId, jobName, HOLDER_ID, triggeredBy]
  );

  return { acquired: true, runId };
}

async function finishJobRun(runId, status, durationMs, errorMessage, resultSummary) {
  await pool.query(
    `UPDATE job_runs SET status = $2, finished_at = NOW(), duration_ms = $3,
       error_message = $4, result_summary = $5::jsonb
     WHERE id = $1`,
    [runId, status, durationMs, errorMessage || null, resultSummary != null ? JSON.stringify(resultSummary) : null]
  );
  // 完工立刻讓鎖過期（不是等 TTL 慢慢到期）——TTL 是「holder 異常死亡」的保底回收
  // 時間，正常完工不該讓下一輪排程或手動觸發平白多等。用 run_id 當條件，避免
  // 把「別人後來又搶到的新鎖」誤釋放掉。
  await pool.query(
    `UPDATE job_locks SET locked_until = NOW()
      WHERE job_name = (SELECT job_name FROM job_runs WHERE id = $1) AND run_id = $1`,
    [runId]
  );
}

async function recordSkippedLock(jobName, triggeredBy, currentHolder) {
  await pool.query(
    `INSERT INTO job_runs (job_name, holder_id, status, triggered_by, finished_at, error_message)
     VALUES ($1, $2, 'skipped_lock', $3, NOW(), $4)`,
    [jobName, HOLDER_ID, triggeredBy, `held by ${currentHolder}`]
  );
}

/**
 * 統一入口：cron.schedule 的 callback 與 POST /api/internal/jobs/:name/run 手動
 * 觸發端點都走這支，確保同一把租約、同一條 run ledger（工單 B.3）。
 *
 * 刻意不 re-throw：呼叫端（cron callback 或手動端點）拿到的是
 * { status, result|error, runId|currentHolder } 這種一致的結構，不需要各自再包一層
 * try/catch——原本每個 job 自己的「外層」try/catch（純粹為了防止拋出去讓 node-cron
 * 整個進程掛掉）已經沒有存在必要，故隨這次改動一併移除；job 內部「單筆記錄失敗
 * 不影響其他筆」的 per-record try/catch 不受影響、原樣保留。
 */
async function runWithLock(jobName, fn, { triggeredBy = 'cron' } = {}) {
  const lock = await acquireJobLock(jobName, triggeredBy);
  if (!lock.acquired) {
    console.log(`[cron-lock] skipped_lock job=${jobName} holder=${HOLDER_ID} current_holder=${lock.currentHolder}`);
    await recordSkippedLock(jobName, triggeredBy, lock.currentHolder);
    return { status: 'skipped_lock', currentHolder: lock.currentHolder };
  }
  console.log(`[cron-lock] acquired job=${jobName} holder=${HOLDER_ID} run_id=${lock.runId} triggered_by=${triggeredBy}`);
  const startedAt = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    await finishJobRun(lock.runId, 'success', durationMs, null, result != null ? result : null);
    console.log(`[cron-lock] success job=${jobName} holder=${HOLDER_ID} run_id=${lock.runId} duration_ms=${durationMs}`);
    return { status: 'success', result, runId: lock.runId };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    await finishJobRun(lock.runId, 'error', durationMs, err.message, null);
    console.warn(`[cron-lock] error job=${jobName} holder=${HOLDER_ID} run_id=${lock.runId} message=${err.message}`);
    return { status: 'error', error: err.message, runId: lock.runId };
  }
}

module.exports = {
  getHolderId,
  computeTtlMs,
  acquireJobLock,
  finishJobRun,
  runWithLock,
};
