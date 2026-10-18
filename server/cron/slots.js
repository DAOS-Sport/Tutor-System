/**
 * 每日排程「時段認領＋補跑」（2026-10-14，GitHub Tutor-System #10）。
 *
 * 正式站是 autoscale 部署，排程寫在網站程式內：沒有流量、縮到 0 台時排程不會跑
 * （00:30 的 Ragic 備份 10/1、10/11 整天沒跑）；同時多台時每台都會跑
 * （10/5、10/6、10/12 同一時段跑了 2–3 次）。cron/lock.js 的租約只保證「同一時間
 * 只有一個在跑」，不保證「每個時段只跑一次」，也不會補跑。
 *
 * 做法（不新增資料表）：
 *   - 每個每日排程的每個時段（例：ragic_backup＠2026-10-14T00:30）對應一個確定性的
 *     job_runs.id。執行前先 INSERT 認領，主鍵衝突＝別台已認領 → 直接跳過。
 *   - 每 5 分鐘＋服務啟動後 1 分鐘檢查一次「最近一個應執行時段」，沒人認領就補跑
 *     （triggered_by='catchup'）。推播類排程只補當天、且最晚補到 20:00，不在隔天清晨或
 *     深夜推通知給家長。
 *   - 補跑依登記順序；前一支的時段還在別台執行中，就停下這一輪、下個 5 分鐘再接著，
 *     跨 instance 也保住夜間 Ragic 鏈「回寫佇列 → 備份 → 拉回」的先後。
 *   - 排程回傳 { retry: true }（例如 Ragic 鎖被別的工作占用、這次沒有真的跑）記成
 *     retry，下一輪會重新認領；卡在 running 超過 2 小時（執行中那台當掉）也可接手。
 *   - 第一次看到某支排程（上線當下）只記一筆 seeded 當起點、不執行，避免一上線就把
 *     所有每日排程在白天補跑一輪。
 *
 * 每分鐘／每 5 分鐘／每小時的排程不走這裡：漏一輪下一輪就補上，重複也由各自的
 * 業務層去重（notification_log、ON CONFLICT），維持原樣。
 */
const crypto = require('crypto');
const { pool } = require('../models/db');
const { getHolderId, finishJobRun } = require('./lock');

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000; // 台灣不實施日光節約時間，固定 UTC+8
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_RECLAIM_AFTER_MS = 2 * 60 * 60 * 1000;
const CATCHUP_GRACE_MS = 3 * 60 * 1000; // 預定時間後 3 分鐘內留給正常排程，不搶
const CATCHUP_STARTUP_DELAY_MS = 60 * 1000;

const JOB_PREFIX = 'slot:';
const registry = [];
let catchUpRunning = false;

/** 台北日期（YYYY-MM-DD）與時分（HH:MM）。 */
function taipeiParts(now = new Date()) {
  const iso = new Date(now.getTime() + TAIPEI_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 某個 HH:MM 每日排程「最近一個已到時間」的時段（台北）。 */
function latestDueSlot(hhmm, now = new Date()) {
  const { date, time } = taipeiParts(now);
  const slotDate = time >= hhmm ? date : shiftDate(date, -1);
  return { slotKey: `${slotDate}T${hhmm}`, date: slotDate };
}

/** 時段的實際時間（毫秒）。 */
function slotTimeMs(slotKey) {
  return Date.parse(`${slotKey}:00+08:00`);
}

/** 時段 → 確定性 UUID（v5 格式），同一 job＋時段永遠得到同一個 job_runs.id。 */
function slotRunId(jobName, slotKey) {
  const h = crypto.createHash('sha256').update(`job-slot|${jobName}|${slotKey}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 認領時段；成功回傳 run id，已被認領（且不可接手）回傳 null。 */
async function claimSlot(jobName, slotKey, triggeredBy, { status = 'running' } = {}) {
  const r = await pool.query(
    `INSERT INTO job_runs (id, job_name, holder_id, status, triggered_by, result_summary)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       holder_id = EXCLUDED.holder_id, status = EXCLUDED.status, triggered_by = EXCLUDED.triggered_by,
       started_at = NOW(), finished_at = NULL, duration_ms = NULL, error_message = NULL,
       result_summary = EXCLUDED.result_summary
     WHERE job_runs.status = 'retry'
        OR (job_runs.status = 'running' AND job_runs.started_at < NOW() - ($7 || ' milliseconds')::interval)
     RETURNING id`,
    [slotRunId(jobName, slotKey), JOB_PREFIX + jobName, getHolderId(), status, triggeredBy,
      JSON.stringify({ slot: slotKey }), SLOT_RECLAIM_AFTER_MS]
  );
  return r.rowCount ? r.rows[0].id : null;
}

/** 認領時段後執行；同一時段在所有 instance 之間只會真的跑一次。 */
async function runSlot(jobName, slotKey, fn, { triggeredBy = 'cron' } = {}) {
  const runId = await claimSlot(jobName, slotKey, triggeredBy);
  if (!runId) return { status: 'skipped_slot' };
  console.log(`[cron-slot] claimed job=${jobName} slot=${slotKey} holder=${getHolderId()} triggered_by=${triggeredBy}`);
  const startedAt = Date.now();
  try {
    const result = await fn();
    const status = result && result.retry ? 'retry' : 'success';
    await finishJobRun(runId, status, Date.now() - startedAt, null, { slot: slotKey, result: result ?? null });
    console.log(`[cron-slot] ${status} job=${jobName} slot=${slotKey} duration_ms=${Date.now() - startedAt}`);
    return { status, result, runId };
  } catch (err) {
    await finishJobRun(runId, 'error', Date.now() - startedAt, err.message, { slot: slotKey });
    console.warn(`[cron-slot] error job=${jobName} slot=${slotKey} message=${err.message}`);
    return { status: 'error', error: err.message, runId };
  }
}

/**
 * 登記一支每日排程，回傳交給 scheduleTaipei 的 callback。
 * catchUp：'any'（錯過隨時可補，Ragic 類）或 'same_day'（只補當天，推播類）；
 * catchUpUntil：當天最晚補到幾點（台北，same_day 預設 20:00）。
 */
function daily(name, hhmm, fn, { catchUp = 'any', catchUpUntil = catchUp === 'same_day' ? '20:00' : null } = {}) {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new Error(`invalid daily slot time: ${hhmm}`);
  registry.push({ name, hhmm, fn, catchUp, catchUpUntil });
  return () => runSlot(name, `${taipeiParts().date}T${hhmm}`, fn, { triggeredBy: 'cron' });
}

/** 補跑檢查：依登記順序逐支處理（夜間 Ragic 鏈的先後順序因此保持）。 */
async function runMissedDailySlots(jobs = registry, now = new Date()) {
  if (catchUpRunning) return { status: 'busy' };
  catchUpRunning = true;
  const outcomes = [];
  try {
    const { date: today, time: nowTime } = taipeiParts(now);
    for (const job of jobs) {
      const { slotKey, date } = latestDueSlot(job.hhmm, now);
      if (now.getTime() - slotTimeMs(slotKey) < CATCHUP_GRACE_MS) continue;
      if (job.catchUp === 'same_day' && date !== today) continue;
      if (job.catchUpUntil && nowTime > job.catchUpUntil) continue;
      try {
        const seen = await pool.query(`SELECT 1 FROM job_runs WHERE job_name = $1 LIMIT 1`, [JOB_PREFIX + job.name]);
        if (!seen.rowCount) {
          // 上線當下：記起點、不執行（之後錯過的時段才補）。
          await claimSlot(job.name, slotKey, 'seed', { status: 'seeded' });
          outcomes.push({ job: job.name, slot: slotKey, status: 'seeded' });
          continue;
        }
        const r = await runSlot(job.name, slotKey, job.fn, { triggeredBy: 'catchup' });
        if (r.status === 'skipped_slot') {
          const cur = await pool.query(`SELECT status FROM job_runs WHERE id = $1`, [slotRunId(job.name, slotKey)]);
          if (cur.rows[0]?.status === 'running') {
            // 別台正在跑這一支：後面的先不要動，下一輪再接著補，維持先後順序。
            outcomes.push({ job: job.name, slot: slotKey, status: 'waiting' });
            break;
          }
          continue;
        }
        outcomes.push({ job: job.name, slot: slotKey, status: r.status });
      } catch (err) {
        console.warn(`[cron-slot] catch-up check failed job=${job.name} message=${err.message}`);
      }
    }
  } finally {
    catchUpRunning = false;
  }
  return { status: 'done', outcomes };
}

/** 服務啟動後稍等再檢查一次（schema 與連線就緒、避開部署瞬間）。 */
function scheduleStartupCatchUp(delayMs = CATCHUP_STARTUP_DELAY_MS) {
  const t = setTimeout(() => {
    runMissedDailySlots().catch((err) => console.warn('[cron-slot] startup catch-up failed:', err.message));
  }, delayMs);
  if (t && typeof t.unref === 'function') t.unref();
}

module.exports = {
  daily,
  runSlot,
  claimSlot,
  runMissedDailySlots,
  scheduleStartupCatchUp,
  latestDueSlot,
  slotRunId,
  slotTimeMs,
  taipeiParts,
  JOB_PREFIX,
  _registry: registry,
};
