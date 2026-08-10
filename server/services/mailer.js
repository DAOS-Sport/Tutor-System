/**
 * SMTP 寄信。
 *
 * ── 設計原則：永不 throw ──
 * 所有呼叫點都在對帳 COMMIT 之後。寄信失敗絕不能讓一筆已經完成的對帳看起來像
 * 失敗，也不能讓櫃檯以為要重按一次。所有錯誤一律收斂成回傳值。
 *
 * ── 沒設定 SMTP 就自動 dry-run ──
 * 只記錄不送出，也不報錯。這樣在還沒補上憑證的環境（本機、CI、正式環境補設定
 * 之前）整條流程照跑，不會因為缺一個環境變數就把對帳流程炸掉。
 * 反過來說也要小心：**dry-run 是「沒寄出」而不是「寄成功」**，回傳值分得很清楚，
 * 呼叫端與 outbox 都必須照實記錄，不可以把 dryRun 當成 sent。
 *
 * ── 測試收件人 ──
 * MAIL_TEST_RECIPIENT 有值時，所有信改寄到那一個位址（原收件人記在 subject 前綴
 * 與回傳值裡）。比照 LINE 推播的 LINE_PUSH_TEST_UID —— 在真的寄給家長之前，
 * 必須有一個能把全部流量收束到自己信箱的開關。
 *
 * 環境變數（最少只要設一個密碼就能運作）：
 *   SMTP_PASS 或 Tutor_gmail   Gmail 應用程式密碼（顯示時的空格會自動去掉）
 *   SMTP_HOST / SMTP_PORT      未設時預設 smtp.gmail.com:587
 *   SMTP_USER / SMTP_FROM      未設時預設 swim@dreamstake.com.tw
 *   SMTP_SECURE=1        強制 TLS（port 465 會自動視為 secure）
 *   MAIL_DRY_RUN=1       即使設定完整也不真的送出
 *   MAIL_TEST_RECIPIENT  所有信改寄這裡
 *   PARENT_GUIDE_IMAGE   使用說明海報路徑（預設 server/assets/parent_guide.png）
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEND_TIMEOUT_MS = 15000;

/**
 * 密碼的來源名稱，依序取第一個有值的。
 *
 * `Tutor_gmail` 是這個專案在 Replit Secrets 裡既有的命名（Gmail 應用程式密碼）。
 * 要求為了程式再開一組 SMTP_* 只是把設定成本轉嫁出去，而且多一份設定就多一個
 * 「兩邊不一致」的地方 —— 實際上就發生過：Secrets 裡只有 Tutor_gmail，
 * 程式卻只讀 SMTP_PASS，結果是「設定看起來有、mail.configured 卻是 false」。
 * 環境變數名稱在 Linux 上區分大小寫，所以三種寫法都認。
 */
const PASS_KEYS = ['SMTP_PASS', 'Tutor_gmail', 'TUTOR_GMAIL', 'tutor_gmail'];

// 寄件位址不是機密（它出現在每一封信的寄件人欄位），放預設值可以讓
// 「只設一個密碼」就能運作。要換帳號時設 SMTP_USER 即可覆寫。
const DEFAULT_SENDER = 'swim@dreamstake.com.tw';

function firstEnv(keys) {
  for (const k of keys) {
    const v = String(process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

function config() {
  // Gmail 顯示應用程式密碼時是四段有空格的，直接複製貼上會帶著空格 ——
  // 那樣認證一定失敗，而錯誤訊息只會說 BadCredentials，看不出是空格的問題。
  const pass = firstEnv(PASS_KEYS).replace(/\s+/g, '');
  // 密碼來自 Gmail 應用程式密碼時，主機與埠必然是 Gmail 的，不需要再要求另外設。
  const host = String(process.env.SMTP_HOST || '').trim() || (pass ? 'smtp.gmail.com' : '');
  const user = String(process.env.SMTP_USER || '').trim()
    || String(process.env.SMTP_FROM || '').trim()
    || (pass ? DEFAULT_SENDER : '');
  const port = Number(process.env.SMTP_PORT || 587);
  return {
    host,
    port,
    user,
    pass,
    from: String(process.env.SMTP_FROM || '').trim() || user,
    secure: String(process.env.SMTP_SECURE || '').trim() === '1' || port === 465,
    dryRun: String(process.env.MAIL_DRY_RUN || '').trim() === '1',
    testRecipient: String(process.env.MAIL_TEST_RECIPIENT || '').trim(),
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.host && c.user && c.pass && c.from);
}

let _transport = null;
let _transportKey = '';

function getTransport() {
  const c = config();
  // 憑證換了要重建 transport；用設定內容當 key，避免改了 secret 卻還用舊連線。
  const key = [c.host, c.port, c.user, c.secure].join('|');
  if (_transport && _transportKey === key) return _transport;
  // 延遲 require：沒裝 nodemailer 或沒設定 SMTP 的環境不該因為載入這個模組就爆。
  const nodemailer = require('nodemailer');
  _transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });
  _transportKey = key;
  return _transport;
}

/**
 * @returns {Promise<{sent:boolean, dryRun:boolean, status:string, reason:string|null,
 *                    to:string, messageId:string|null}>}
 *   status ∈ sent | dry_run | skipped | failed
 *   絕不 throw。
 */
async function sendMail({ to, subject, html, text, attachments }) {
  const c = config();
  const original = String(to || '').trim();
  const result = { sent: false, dryRun: false, status: 'failed', reason: null, to: original, messageId: null };

  if (!original || !EMAIL_RE.test(original)) {
    return Object.assign(result, { status: 'skipped', reason: 'INVALID_RECIPIENT' });
  }
  if (!String(subject || '').trim()) {
    return Object.assign(result, { status: 'skipped', reason: 'EMPTY_SUBJECT' });
  }

  let target = original;
  let subj = subject;
  if (c.testRecipient) {
    target = c.testRecipient;
    subj = `[原收件人 ${original}] ${subject}`;
    result.to = target;
  }

  if (!isConfigured()) {
    return Object.assign(result, { status: 'dry_run', dryRun: true, reason: 'SMTP_NOT_CONFIGURED' });
  }
  if (c.dryRun) {
    return Object.assign(result, { status: 'dry_run', dryRun: true, reason: 'MAIL_DRY_RUN' });
  }

  try {
    const info = await getTransport().sendMail({
      from: c.from,
      to: target,
      subject: subj,
      text: text || undefined,
      html: html || undefined,
      attachments: (attachments && attachments.length) ? attachments : undefined,
    });
    return Object.assign(result, { sent: true, status: 'sent', messageId: info?.messageId || null });
  } catch (err) {
    return Object.assign(result, { status: 'failed', reason: String(err?.message || err).slice(0, 300) });
  }
}

/**
 * 可對外揭露的設定摘要 —— **只回布林，絕不回主機、帳號或位址**。
 *
 * 存在的理由：dry-run 是刻意設計成「不報錯」的（寄信失敗不能讓已收到錢的對帳
 * 看起來像失敗），代價是「沒設定 SMTP」這件事從外面完全看不見 —— 對帳照樣成功、
 * 畫面照樣正常，只是信永遠不會到。這個摘要把那個沉默狀態變成看得見的。
 */
function describe() {
  const c = config();
  return {
    configured: isConfigured(),
    dryRun: c.dryRun,
    testRecipientSet: Boolean(c.testRecipient),
  };
}

/** 供 /healthz 或人工檢查用；不寄信。 */
async function verify() {
  if (!isConfigured()) return { ok: false, reason: 'SMTP_NOT_CONFIGURED' };
  try {
    await getTransport().verify();
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 300) };
  }
}

module.exports = { sendMail, isConfigured, verify, config, describe, EMAIL_RE, __test__: { getTransport } };
