'use strict';
/**
 * 健康回報 health-v1 的燈號規則（D:/工作內容/駿斯/tools/health-hub/contract）。
 * 全部是純函式：輸入 services/healthSignals.js 收集的訊號與現在時間，輸出報告。
 *
 * 紅＝要立刻修；黃＝之後修，看不到訊號也算黃；綠＝正常。
 * 門檻是 2026-10-22 的預設值，等使用者確認。
 */
const { formatTaipeiDateTime } = require('../utils/dateTime');

const SYSTEM_ID = 'daos-tutoring';
const LEVELS = ['green', 'yellow', 'red'];

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TAIPEI_OFFSET_MS = 8 * HOUR;

// 排定時間過了這麼久才判這一輪；之前看上一輪。補跑在啟動 1 分鐘後、之後每 5 分鐘。
const SLOT_GRACE_MS = 15 * MINUTE;
const SLOT_STUCK_MS = 2 * HOUR;
// 這支程序啟動超過這麼久，每分鐘／每 5 分鐘的排程就該清掉積壓。
const SWEEP_GRACE_MS = 15 * MINUTE;

/**
 * server/cron/index.js 裡用 slots.daily() 登記的每日排程。
 * tests/health_rules_test.js 逐條比對 cron/index.js，排程改了這裡沒跟著改就紅。
 */
const DAILY_JOBS = [
  { name: 'ragic_outbox_nightly', hhmm: '00:10', catchUp: 'any', label: '新註冊家長寫入 Ragic（每天 00:10）' },
  { name: 'ragic_backup', hhmm: '00:30', catchUp: 'any', label: '家長與學員寫回 Ragic（每天 00:30）' },
  { name: 'ragic_pull', hhmm: '02:30', catchUp: 'any', label: '從 Ragic 拉回家長與學員（每天 02:30）' },
  { name: 'ragic_staff_venues', hhmm: '03:30', catchUp: 'any', label: 'Ragic 員工與場館同步（每天 03:30）' },
  { name: 'expiry_reminder', hhmm: '09:00', catchUp: 'same_day', label: '堂數到期提醒（每天 09:00）' },
  { name: 'mgm_trial_today', hhmm: '09:30', catchUp: 'same_day', label: '推薦體驗課當日提醒（每天 09:30）' },
  { name: 'eval_threshold_alert', hhmm: '10:30', catchUp: 'same_day', label: '教練考核門檻警示（每天 10:30）' },
];
// cron 仍會呼叫，但 ragicAdmin.RETIRED_JOBS 一律跳過（2026-09-23 退役），不列管線。
const RETIRED_DAILY_JOBS = ['ragic_quarantine'];
const SAME_DAY_CATCH_UP_UNTIL = '20:00';

function worst(levels) {
  return levels.reduce((acc, l) => (LEVELS.indexOf(l) > LEVELS.indexOf(acc) ? l : acc), 'green');
}

const ms = (v) => (v == null ? NaN : new Date(v).getTime());
const iso = (v) => (v == null || Number.isNaN(ms(v)) ? null : new Date(v).toISOString());
const at = (v) => formatTaipeiDateTime(v);
const clip = (s, n = 100) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const isReadError = (v) => Boolean(v && typeof v === 'object' && 'readError' in v);

function taipeiParts(date) {
  const s = new Date(date.getTime() + TAIPEI_OFFSET_MS).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}
function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
/** 時段 key（與 cron/slots.js 相同格式：台北 YYYY-MM-DDTHH:MM）的實際時間。 */
function slotTime(slotKey) {
  return new Date(`${slotKey}:00+08:00`);
}
const slotLabel = (slotKey) => `${slotKey.slice(5, 7)}/${slotKey.slice(8, 10)} ${slotKey.slice(11)}`;

/** 要判斷的兩個時段：最近一個「排定時間＋寬限」已過的時段，與它前一天那個。 */
function slotsToJudge(hhmm, now) {
  const { date, time } = taipeiParts(new Date(now.getTime() - SLOT_GRACE_MS));
  const d = time >= hhmm ? date : shiftDate(date, -1);
  return { current: `${d}T${hhmm}`, previous: `${shiftDate(d, -1)}T${hhmm}` };
}

const result = (level, reason, extra = {}) => ({ level, reason, ...extra });
const unreadable = (e) => result('red', `讀取狀態失敗：${clip(e.readError)}`);

function summarize(res) {
  if (!res || typeof res !== 'object') return '';
  const parts = Object.entries(res)
    .filter(([, v]) => typeof v === 'number' || (typeof v === 'string' && v))
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? `（${parts.join('、')}）` : '';
}

/** 一般的每日排程：跑完了，再看回傳的結果有沒有報錯。 */
function defaultJobOutcome(res, row) {
  const done = `${at(row.finished_at)} 完成`;
  if (res && res.skipped) return result('green', `${done}，這一輪略過（${clip(res.skipped, 40)}）`);
  if (res && res.error) return result('yellow', `${done}，但回報錯誤：${clip(res.error)}`);
  const failedParts = res ? Object.entries(res).filter(([, v]) => typeof v === 'string' && /^err\(/.test(v)) : [];
  if (failedParts.length) {
    return result('yellow', `${done}，但有子項失敗：${failedParts.map(([k, v]) => `${k}=${clip(v, 60)}`).join('、')}`);
  }
  return result('green', `${done}${summarize(res)}`);
}

/**
 * 家長與學員寫回 Ragic：每晚都有一批資料不全的學員被 Ragic 拒收（使用者 2026-10-15 決定維持原狀），
 * 所以舊的永久失敗不改燈號；整批失敗、暫時性失敗、或 7 天內新出現的失敗才算。
 */
function backupOutcome(res, row, failures) {
  const synced = Number(res?.synced || 0);
  if (!res?.error) return result('green', `${at(row.finished_at)} 完成，寫回 ${synced} 筆，沒有失敗`);
  if (!failures || isReadError(failures)) {
    return result('yellow', `${at(row.finished_at)} 完成但回報錯誤，讀不到逐筆失敗紀錄：${clip(failures?.readError || '沒有資料')}`);
  }
  const { failedIds, newIds, notPermanent } = failures;
  if (!failedIds) return result('red', `${at(row.finished_at)} 整批寫回失敗（沒有逐筆失敗紀錄）：${clip(res.error)}`);
  const head = `${at(row.finished_at)} 寫回 ${synced} 筆；${failedIds} 筆被 Ragic 拒收`;
  if (notPermanent) return result('yellow', `${head}，其中 ${notPermanent} 筆是暫時性或未分類的錯誤`);
  if (newIds) return result('yellow', `${head}，其中 ${newIds} 筆是 7 天內新出現的`);
  return result('green', `${head}，都是 7 天前就有的資料不全（已知，維持原狀）`);
}

const JOB_OUTCOMES = { ragic_backup: backupOutcome };

/**
 * 每日排程（job_runs 的 slot:<name> 列，cron/slots.js 寫入）。
 * signal：{ current, previous, lastSuccessAt, lastFailureAt, failures? }，current／previous 是該時段那一列或 null。
 */
function evaluateDailyJob(job, signal, { now, schedulerActive }) {
  if (isReadError(signal)) return unreadable(signal);
  const keys = slotsToJudge(job.hhmm, now);
  const times = { lastSuccessAt: iso(signal.lastSuccessAt), lastFailureAt: iso(signal.lastFailureAt) };
  const r = (level, reason) => result(level, reason, times);
  if (!schedulerActive) return r('yellow', '無法觀測：這個環境不跑排程（PREVIEW_SAFE_MODE=1）');

  const row = signal.current && signal.current.status !== 'seeded' ? signal.current : null;
  if (!row) {
    const prev = signal.previous && signal.previous.status !== 'seeded' ? signal.previous : null;
    if (!prev && !signal.lastSuccessAt) return r('yellow', '無法觀測：還沒有執行紀錄（剛上線或從未執行）');
    const missed = `${slotLabel(keys.current)} 這一輪還沒執行`;
    if (prev && prev.status === 'success') {
      const pastWindow = job.catchUp === 'same_day'
        && (taipeiParts(now).date !== keys.current.slice(0, 10) || taipeiParts(now).time > SAME_DAY_CATCH_UP_UNTIL);
      return r('yellow', pastWindow
        ? `${missed}，已過當天補跑時限（${SAME_DAY_CATCH_UP_UNTIL}），這一輪不會補`
        : `${missed}（服務可能在休眠，醒來後 5 分鐘內會補跑）`);
    }
    const last = signal.lastSuccessAt ? `，最後一次成功是 ${at(signal.lastSuccessAt)}` : '，從來沒有成功過';
    return r('red', `${slotLabel(keys.previous)}、${slotLabel(keys.current)} 兩輪都沒有成功執行${last}`);
  }

  switch (row.status) {
    case 'running':
      if (now.getTime() - ms(row.started_at) > SLOT_STUCK_MS) {
        return r('red', `${slotLabel(keys.current)} 這一輪從 ${at(row.started_at)} 開始，超過 2 小時還沒結束`);
      }
      return r('green', `執行中（${at(row.started_at)} 開始）`);
    case 'retry':
      return r('yellow', `${slotLabel(keys.current)} 這一輪沒拿到 Ragic 同步鎖，等補跑`);
    case 'error':
      return r('red', `${slotLabel(keys.current)} 這一輪執行失敗：${clip(row.error_message || '未知錯誤')}`);
    case 'success': {
      const res = row.result_summary ? row.result_summary.result : null;
      const outcome = (JOB_OUTCOMES[job.name] || defaultJobOutcome)(res, row, signal.failures);
      return { ...outcome, ...times };
    }
    default:
      return r('yellow', `${slotLabel(keys.current)} 這一輪狀態不明（${clip(row.status, 30)}）`);
  }
}

function evaluateDatabase(signal) {
  if (isReadError(signal)) return result('red', `連不上資料庫：${clip(signal.readError)}`);
  if (signal.latencyMs < 500) return result('green', '查詢正常（< 500 ms）');
  if (signal.latencyMs < 2000) return result('yellow', '查詢偏慢（500 ms 到 2 秒）');
  return result('red', '查詢超過 2 秒');
}

/** 新註冊家長的 LINE UID 寫回 Ragic（ragic_sync_outbox，每晚 00:10 批次處理）。 */
function evaluateRagicOutbox(signal, { now }) {
  if (isReadError(signal)) return unreadable(signal);
  const times = { lastSuccessAt: iso(signal.lastSyncedAt), lastFailureAt: null };
  const nightly = slotTime(slotsToJudge('00:10', now).current).getTime();
  const open = signal.open || [];
  const overdue = open.filter((o) => ['pending', 'retryable'].includes(o.state) && ms(o.next_retry_at) < nightly);
  const oldest = Math.min(...overdue.map((o) => ms(o.next_retry_at)));
  const blocked = open.filter((o) => String(o.state).startsWith('blocked'));
  const retryable = open.filter((o) => o.state === 'retryable' && ms(o.next_retry_at) >= nightly);
  const waiting = open.filter((o) => o.state === 'pending' && ms(o.next_retry_at) >= nightly).length;
  if (overdue.length && oldest < nightly - DAY) {
    return result('red', `${overdue.length} 筆跨過兩次夜間批次還沒處理（最早 ${at(oldest)} 就該處理）`, times);
  }
  const notes = [];
  if (overdue.length) notes.push(`${overdue.length} 筆在上次夜間批次之前就該處理，還在排隊`);
  if (retryable.length) notes.push(`${retryable.length} 筆寫入失敗，等下次夜間批次重試`);
  if (blocked.length) {
    const byState = {};
    blocked.forEach((b) => { byState[b.state] = (byState[b.state] || 0) + 1; });
    notes.push(`${blocked.length} 筆卡住待櫃檯處理（${Object.entries(byState).map(([k, n]) => `${k} ${n}`).join('、')}）`);
  }
  if (notes.length) return result('yellow', notes.join('；'), times);
  return result('green', `佇列沒有積壓${waiting ? `（${waiting} 筆等下次 00:10 批次）` : ''}`, times);
}

/** Ragic 即時通知：收件（ragic_webhook_attempts）＋處理佇列（ragic_webhook_inbox，每分鐘重試）。 */
function evaluateRagicWebhook(signal, { now, processStartedAt, isProduction }) {
  if (isReadError(signal)) return unreadable(signal);
  const times = { lastSuccessAt: iso(signal.lastCompletedAt), lastFailureAt: null };
  if (isProduction && !signal.secretConfigured) {
    return result('red', '沒有設定 RAGIC_WEBHOOK_SECRET，Ragic 送來的通知全部會被拒絕', times);
  }
  const a = signal.attempts24h || {};
  const ok = a.ok || 0;
  const rejected = (a.unauthorized || 0) + (a.unavailable || 0) + (a.invalid_payload || 0);
  if (ok === 0 && rejected >= 3) {
    return result('red', `24 小時內 ${rejected} 次通知全部失敗（401 ${a.unauthorized || 0}、503 ${a.unavailable || 0}、格式錯誤 ${a.invalid_payload || 0}）`, times);
  }
  const open = signal.open || [];
  const due = open.filter((o) => ['pending', 'retryable'].includes(o.state) && ms(o.next_retry_at) <= now.getTime());
  const stuckSince = Math.max(Math.min(...due.map((o) => ms(o.next_retry_at))), ms(processStartedAt));
  if (due.length && now.getTime() - stuckSince > SWEEP_GRACE_MS) {
    return result('red', `${due.length} 筆通知已到重試時間超過 15 分鐘沒有處理（每分鐘的重試排程沒在跑）`, times);
  }
  const notes = [];
  if (due.length) notes.push(`${due.length} 筆等重試`);
  const blocked = open.filter((o) => o.state === 'blocked').length;
  if (blocked) notes.push(`${blocked} 筆重試 8 次仍失敗，要到後台 Ragic 狀態頁手動重試`);
  if (a.unavailable) notes.push(`24 小時內 ${a.unavailable} 次回 503（暫時無法處理）`);
  if (notes.length) return result('yellow', notes.join('；'), times);
  if (!signal.lastAttemptAt || now.getTime() - ms(signal.lastAttemptAt) > 7 * DAY) {
    return result('yellow', '無法觀測：7 天內沒收到 Ragic 通知', times);
  }
  return result('green', `24 小時內收到 ${ok} 次通知，佇列沒有積壓`, times);
}

/** Z01 LINE UID 欄位驗證（每 5 分鐘打一次 Ragic def=1）；沒通過時 UID 寫回 Ragic 會暫停。 */
function evaluateZ01Schema(signal, { now }) {
  if (isReadError(signal)) return unreadable(signal);
  if (!signal.configured) return result('green', '沒有設定 Ragic Z01，不檢查');
  const times = { lastSuccessAt: iso(signal.lastVerifiedAt), lastFailureAt: null };
  const latest = signal.latest;
  if (!latest) return result('yellow', '無法觀測：還沒有驗證紀錄', times);
  const age = now.getTime() - ms(latest.fetched_at);
  if (age > 26 * HOUR) return result('yellow', `無法觀測：最後一次驗證是 ${at(latest.fetched_at)}`, times);
  if (latest.verified) return result('green', `最近一次驗證通過（${at(latest.fetched_at)}）`, times);
  const failed = { ...times, lastFailureAt: iso(latest.fetched_at) };
  const code = clip(latest.failure_code || '未知原因', 60);
  if (!signal.lastVerifiedAt || now.getTime() - ms(signal.lastVerifiedAt) > 26 * HOUR) {
    return result('red', `超過 26 小時沒有通過 Z01 欄位驗證（${code}），LINE UID 寫回 Ragic 暫停中`, failed);
  }
  return result('yellow', `最近一次驗證沒通過（${code}），26 小時內有通過`, failed);
}

/** LINE 推播（line_push_log 記下每一則推播的結局，services/pushGate.js 寫入）。 */
function evaluateLinePush(signal) {
  if (isReadError(signal)) return unreadable(signal);
  const times = { lastSuccessAt: iso(signal.lastSentAt), lastFailureAt: iso(signal.lastFailedAt) };
  const c = signal.last24h || {};
  if (!signal.gate.enabled) return result('green', '推播總開關關閉（不送任何推播）', times);
  if (!signal.tokens.staffChannel) return result('red', '找不到 LINE 推播 token，所有推播都會失敗', times);
  if (signal.tokens.monthlyQuotaBlockedUntil || c.quota) {
    return result('red', `本月 LINE 推播額度已用完${c.quota ? `，24 小時內 ${c.quota} 則沒送出` : ''}`, times);
  }
  if (c.noToken) return result('red', `24 小時內 ${c.noToken} 則因缺 token 沒送出`, times);
  const attempts = (c.sent || 0) + (c.failed || 0);
  const ratio = attempts ? (c.failed || 0) / attempts : 0;
  const counts = `24 小時內送出 ${c.sent || 0} 則、失敗 ${c.failed || 0} 則`;
  if (attempts >= 5 && ratio >= 0.5) return result('red', `${counts}（失敗過半）`, times);
  const notes = [];
  if ((c.failed || 0) >= 3 && ratio >= 0.1) notes.push(`${counts}（失敗比例 ${Math.round(ratio * 100)}%）`);
  if (c.rateLimited) notes.push(`${c.rateLimited} 則超過每小時上限被擋下`);
  if (signal.gate.dryRun) notes.push('演練模式：推播只記錄不送出');
  if (signal.testUidSet) notes.push('LINE_PUSH_TEST_UID 有設，所有推播改送測試帳號');
  if (notes.length) return result('yellow', notes.join('；'), times);
  return result('green', counts, times);
}

/** 對帳通知信（mail_outbox）。 */
function evaluateMail(signal) {
  if (isReadError(signal)) return unreadable(signal);
  const times = { lastSuccessAt: iso(signal.lastSentAt), lastFailureAt: iso(signal.lastFailedAt) };
  const c = signal.last24h || {};
  if (!signal.configured) return result('red', 'SMTP 沒有設定，對帳通知信不會寄出', times);
  if ((c.failed || 0) >= 3 && !c.sent) return result('red', `24 小時內 ${c.failed} 封全部寄送失敗`, times);
  const notes = [];
  if (c.failed) notes.push(`24 小時內 ${c.failed} 封寄送失敗`);
  if (signal.stalePending) {
    notes.push(`${signal.stalePending} 封卡在待寄超過 30 分鐘${signal.sweepEnabled ? '' : '（補寄排程 RECONCILE_MAIL_SWEEP 沒開，不會自動補寄）'}`);
  }
  if (signal.dryRun) notes.push('MAIL_DRY_RUN=1：信只記錄不寄出');
  if (signal.testRecipientSet) notes.push('MAIL_TEST_RECIPIENT 有設，所有信改寄測試信箱');
  if (notes.length) return result('yellow', notes.join('；'), times);
  return result('green', `24 小時內寄出 ${c.sent || 0} 封`, times);
}

/** 課程需求排程生效（每 5 分鐘套用到期的 pending_changes）：看積壓，不看排程有沒有跑。 */
function evaluateCourseTypeSchedule(signal, { now, processStartedAt, schedulerActive }) {
  if (isReadError(signal)) return unreadable(signal);
  if (!signal.overdue) return result('green', '沒有到期未套用的排程');
  if (!schedulerActive) return result('yellow', `${signal.overdue} 筆到期未套用；這個環境不跑排程`);
  const since = Math.max(ms(signal.oldestDueAt), ms(processStartedAt));
  if (now.getTime() - since > SWEEP_GRACE_MS) {
    return result('red', `${signal.overdue} 筆課程需求排程已到生效時間（最早 ${at(signal.oldestDueAt)}），超過 15 分鐘還沒套用`);
  }
  return result('yellow', `${signal.overdue} 筆剛到生效時間，等每 5 分鐘的排程套用`);
}

/** 進行中課期的聊天室（每 5 分鐘補建）：看積壓。 */
function evaluateChatRooms(signal, { now, processStartedAt, schedulerActive }) {
  if (isReadError(signal)) return unreadable(signal);
  if (!signal.missing) return result('green', '進行中的課期都有聊天室');
  if (!schedulerActive) return result('yellow', `${signal.missing} 個進行中課期沒有聊天室；這個環境不跑排程`);
  if (now.getTime() - ms(processStartedAt) > SWEEP_GRACE_MS) {
    return result('yellow', `${signal.missing} 個進行中課期沒有聊天室（每 5 分鐘的補建沒補上）`);
  }
  return result('green', `服務剛啟動，${signal.missing} 個課期等補建聊天室`);
}

function evaluateStorage(signal) {
  if (signal.driver === 'replit') return result('green', '上傳檔案存在 Replit bucket');
  if (signal.driver === 'db') return result('yellow', 'bucket 沒接上，上傳檔案改存資料庫（資料庫會慢慢變大）');
  return result('yellow', `上傳檔案存在 ${clip(signal.driver, 20)}（本機磁碟只適合開發，換機器檔案就不見）`);
}

/** 管線清單。順序就是報告裡的順序。 */
const PIPELINES = [
  { id: 'database', name: '資料庫', source: 'select 1', signal: 'database', evaluate: evaluateDatabase },
  ...DAILY_JOBS.map((job) => ({
    id: `job.${job.name}`,
    name: job.label,
    source: `job_runs（slot:${job.name}）`,
    signal: (s) => (isReadError(s.dailyJobs) ? s.dailyJobs : s.dailyJobs[job.name]),
    evaluate: (sig, ctx) => evaluateDailyJob(job, sig, ctx),
  })),
  { id: 'ragic.outbox', name: '新家長 LINE UID 寫回 Ragic 佇列', source: 'ragic_sync_outbox', signal: 'ragicOutbox', evaluate: evaluateRagicOutbox },
  { id: 'ragic.webhook', name: 'Ragic 即時通知', source: 'ragic_webhook_attempts＋ragic_webhook_inbox', signal: 'ragicWebhook', evaluate: evaluateRagicWebhook },
  { id: 'ragic.z01-schema', name: 'Ragic Z01 欄位驗證', source: 'ragic_z01_uid_schema_verifications', signal: 'z01Schema', evaluate: evaluateZ01Schema },
  { id: 'line.push', name: 'LINE 推播', source: 'line_push_log', signal: 'linePush', evaluate: evaluateLinePush },
  { id: 'mail.reconcile', name: '對帳通知信', source: 'mail_outbox', signal: 'mail', evaluate: evaluateMail },
  { id: 'course-type.schedule', name: '課程需求排程生效', source: '課程需求設定的 pending_changes', signal: 'courseTypeSchedule', evaluate: evaluateCourseTypeSchedule },
  { id: 'chat.rooms', name: '課期聊天室補建', source: 'course_periods＋chat_rooms', signal: 'chatRooms', evaluate: evaluateChatRooms },
  { id: 'storage.uploads', name: '上傳檔案儲存', source: 'objectStorage driver', signal: 'storage', evaluate: evaluateStorage },
];

/**
 * signals：{ now, build, processStartedAt, schedulerActive, isProduction, ...各管線訊號 }。
 * 訊號讀不到時是 { readError }，只有那一條變紅。
 */
function assembleReport(signals) {
  const ctx = {
    now: signals.now,
    processStartedAt: signals.processStartedAt,
    schedulerActive: signals.schedulerActive,
    isProduction: signals.isProduction,
  };
  const pipelines = PIPELINES.map((p) => {
    const sig = typeof p.signal === 'function' ? p.signal(signals) : signals[p.signal];
    const r = sig === undefined ? result('yellow', '無法觀測：沒有收集到訊號') : p.evaluate(sig, ctx);
    return {
      id: p.id,
      name: p.name,
      level: r.level,
      reason: r.reason,
      lastSuccessAt: r.lastSuccessAt ?? null,
      lastFailureAt: r.lastFailureAt ?? null,
      source: p.source,
    };
  });
  return {
    system: SYSTEM_ID,
    build: signals.build || 'unknown',
    checkedAt: signals.now.toISOString(),
    overall: worst(pipelines.map((p) => p.level)),
    pipelines,
  };
}

module.exports = {
  SYSTEM_ID,
  LEVELS,
  DAILY_JOBS,
  RETIRED_DAILY_JOBS,
  PIPELINES,
  worst,
  slotsToJudge,
  slotTime,
  assembleReport,
  evaluateDailyJob,
  evaluateDatabase,
  evaluateRagicOutbox,
  evaluateRagicWebhook,
  evaluateZ01Schema,
  evaluateLinePush,
  evaluateMail,
  evaluateCourseTypeSchedule,
  evaluateChatRooms,
  evaluateStorage,
};
