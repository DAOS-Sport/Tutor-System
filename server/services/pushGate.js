/**
 * 推播安全閥 —— 所有 LINE 推播的唯一關卡。
 *
 * 背景：系統裡有 20 個 pushMessage 呼叫點、19 個模板，長期因為
 * LINE_MESSAGING_TOKENS 的 key 用館名、而程式用 venue_id 查表，全部失敗中
 * （notification_log 一筆紀錄都沒有）。一旦 key 修好，這些會「同時」開始送給
 * 真實家長；其中幾條還是 cron，而去重表是空的 —— 第一次跑成功時會把所有
 * 符合條件的對象一次認領並推送，等於對全體客戶群發。
 *
 * 因此每一則推播都必須先過這道閘，全部 fail-closed（設定讀不到或沒設＝關閉）：
 *   1. 總開關
 *   2. 分事件開關
 *   3. 時窗上限（防止積壓一次爆出去）
 *   4. 去重（同一事件 + 業務主鍵 + 收訊者只送一次）
 *   5. 演練模式（只寫紀錄不送出）
 *   6. 測試收訊者（強制改送指定 LINE ID）
 *
 * 設定沿用既有的 admin_settings。注意該表的 value 是 NUMERIC，既有布林設定
 * （如 ragic_sync_enabled_pull）都以 1/0 表示，這裡照同一慣例，不另立一套。
 * 測試收訊者是字串塞不進 numeric，改用環境變數 LINE_PUSH_TEST_UID。
 */
const { pool } = require('../models/db');

// 設定鍵與預設值。預設一律取「最保守」的那一邊 —— 沒設定就是不送。
const SETTING = {
  enabled: 'push_enabled',            // 1＝開。預設 0
  dryRun: 'push_dry_run',             // 1＝只記錄不送出。預設 1
  maxPerHour: 'push_max_per_hour',    // 每小時實際送出上限。預設 50
};
const DEFAULTS = { push_enabled: 0, push_dry_run: 1, push_max_per_hour: 50 };

// 沒有明確設成 1 的事件一律視為關閉。
const EVENT_KEY = (event) => 'push_event_' + event;

// numeric 欄位讀出來可能是字串 "1"，也可能是 undefined。只有 1 才算開。
const isOn = (v) => Number(v) === 1;

async function loadSettings(db = pool) {
  const out = { ...DEFAULTS };
  try {
    const r = await db.query(
      `SELECT key, value FROM admin_settings WHERE key LIKE 'push\\_%' ESCAPE '\\'`);
    r.rows.forEach((row) => { out[row.key] = Number(row.value); });
  } catch (e) {
    // 讀不到設定 → 維持 DEFAULTS（總開關 0）＝ 什麼都不送。
    console.warn('[pushGate] 讀取設定失敗，套用最保守預設：' + e.message);
  }
  return out;
}

/**
 * 判斷這一則要不要送。回 { allow, reason, dryRun, uid, redirected }。
 * uid 在測試模式下會被改寫 —— 呼叫端必須用回傳的 uid，不可用原本傳入的。
 */
async function decide({ event, uid, db = pool }) {
  const s = await loadSettings(db);

  if (!isOn(s[SETTING.enabled])) return { allow: false, reason: 'DISABLED_GLOBAL' };
  if (!isOn(s[EVENT_KEY(event)])) return { allow: false, reason: 'DISABLED_EVENT:' + event };
  if (!uid) return { allow: false, reason: 'NO_RECIPIENT_UID' };

  const cap = Number(s[SETTING.maxPerHour]);
  if (Number.isFinite(cap) && cap >= 0) {
    try {
      const c = await db.query(
        `SELECT COUNT(*)::int n FROM line_push_log
          WHERE status = 'sent' AND at >= NOW() - INTERVAL '1 hour'`);
      if (c.rows[0].n >= cap) return { allow: false, reason: 'RATE_LIMIT:' + c.rows[0].n + '/' + cap };
    } catch (e) {
      // 查不到用量就不敢放行 —— 上限存在的意義就是防爆量。
      return { allow: false, reason: 'RATE_CHECK_FAILED:' + e.message };
    }
  }

  const testUid = String(process.env.LINE_PUSH_TEST_UID || '').trim();
  return { allow: true, dryRun: isOn(s[SETTING.dryRun]), uid: testUid || uid, redirected: !!testUid };
}

/**
 * 佔位（claim）：先寫一列 sending，靠唯一索引擋掉重複。
 * 回 log id；已送過（撞唯一索引）回 null。
 * refId 為空時不做去重（仍會記錄），因為沒有業務主鍵可比。
 */
async function claim({ event, refId, uid, venueId, recipientKind, db = pool }) {
  const r = await db.query(
    `INSERT INTO line_push_log (event, venue_id, recipient_uid, recipient_kind, ref_id, status)
     VALUES ($1,$2,$3,$4,$5,'sending')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [event, venueId || null, uid, recipientKind || null, refId || null]);
  return r.rowCount ? r.rows[0].id : null;
}

async function finish({ id, status, reason, httpStatus, durationMs, db = pool }) {
  if (!id) return;
  try {
    await db.query(
      `UPDATE line_push_log SET status=$2, reason=$3, http_status=$4, duration_ms=$5 WHERE id=$1`,
      [id, status, reason || null, httpStatus || null, durationMs || null]);
  } catch (e) { console.warn('[pushGate] 更新紀錄失敗：' + e.message); }
}

// 被閘擋下來的也要留痕，否則「為什麼沒收到」永遠查不出來。
async function logSkipped({ event, refId, uid, venueId, recipientKind, reason, db = pool }) {
  try {
    await db.query(
      // 同一次略過重複記錄沒有任何價值，撞唯一索引是預期內的 —— 上面的 claim()
      // 本來就這樣寫。漏了這一行的後果只是每次重複請求都吐一行假錯誤到 log，
      // 讓真的寫入失敗淹在裡面。
      `INSERT INTO line_push_log (event, venue_id, recipient_uid, recipient_kind, ref_id, status, reason)
       VALUES ($1,$2,$3,$4,$5,'skipped',$6)
       ON CONFLICT DO NOTHING`,
      [event, venueId || null, uid || null, recipientKind || null, refId || null, reason]);
  } catch (e) { console.warn('[pushGate] 寫入略過紀錄失敗：' + e.message); }
}

/**
 * 目前的閘門狀態 —— 給公開的 /health 用。
 * 事件代號本身不是機密，而且「哪些事件開著」正是這裡最需要回答的問題。
 */
async function describe(db = pool) {
  const s = await loadSettings(db);
  const eventsOn = Object.keys(s)
    .filter((k) => k.startsWith('push_event_') && isOn(s[k]))
    .map((k) => k.slice('push_event_'.length))
    .sort();
  return {
    enabled: isOn(s[SETTING.enabled]),
    dryRun: isOn(s[SETTING.dryRun]),
    maxPerHour: Number(s[SETTING.maxPerHour]),
    eventsOn,
  };
}

module.exports = { SETTING, DEFAULTS, EVENT_KEY, loadSettings, decide, claim, finish, logSkipped, isOn, describe };