/**
 * 對帳成功 → 寄 Email 給家長。
 *
 * ── 為什麼是「家庭 × 發票」而不是「每筆訂單」──
 * 一張發票常對應同一家庭的多筆子訂單（兄弟姊妹各一筆）。逐筆寄的話家長會收到
 * N 封內容幾乎一樣的信。checkouts.js 的 invoicePlans 本來就是以家庭分組，
 * 這裡沿用同一個粒度；legacy 的單筆入口就是 N=1 的退化情形。
 *
 * ── 為什麼要 outbox ──
 * 通知寫在 COMMIT 之後 + try/catch 的話有兩個洞：
 *   漏寄：COMMIT 成功但進程在寄信前掛掉 → 信永遠不會補，而且再打一次 API 會被
 *         「狀態非待對帳」擋成 409，人工也救不回來。
 *   重寄：沒有去重鍵，任何補救動作都可能讓家長收到第二封。
 * 所以 enqueue 在對帳交易「之內」（COMMIT 了就一定留得住），實際寄送在之外。
 *
 * ── enqueue 絕不能弄壞對帳 ──
 * 交易內任何一句 SQL 失敗都會讓整個交易 abort。萬一 mail_outbox 還沒建好、
 * 或欄位對不上，一次 INSERT 失敗就會把「已經收到錢的對帳」整筆回滾 ——
 * 那比不寄信嚴重得多。所以 enqueue 全程包在 SAVEPOINT 裡，出事只回滾到
 * SAVEPOINT，對帳照樣 COMMIT。
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../models/db');
const mailer = require('./mailer');
const templates = require('./emailTemplates');
const objectStore = require('./objectStorage');
const { venueOaDeepLink, OA_LOGIN_KEYWORD } = require('./lineRouting');

// 2026-08-12 起不再附使用說明海報（server/assets/parent_guide.jpg，約 280KB）。
// 它教的是「加入場館官方帳號 → 圖文選單『家教班』」，而信裡的登入按鈕現在
// 就直接開該館官方帳號、關鍵字也打好了 —— 海報講的正是按鈕已經做完的事。
// 素材檔本身留著（owner 只說信裡不要附，沒說要刪）。
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * 把 objectStorage 的三種回傳型別統一成 Buffer。
 * openUpload 依 driver 回 stream / buffer / file 三種，只處理其中一種的話
 * 換個環境（Replit bucket ↔ DB fallback ↔ 本機磁碟）就會安靜地拿不到附件。
 */
async function readUploadBuffer(url) {
  const found = await objectStore.openUpload(url);
  if (!found) return null;
  if (found.kind === 'buffer') return found.buffer;
  if (found.kind === 'file') return fs.promises.readFile(found.path);
  if (found.kind === 'stream') {
    const chunks = [];
    for await (const c of found.stream) chunks.push(c);
    return Buffer.concat(chunks);
  }
  return null;
}

/**
 * 組信件附件：只剩櫃檯上傳的發票照片。
 * 讀不到就只是少一個附件，不影響信件本身寄出。
 */
async function buildAttachments({ invoiceImageUrl, invoiceNumber }) {
  const out = { attachments: [], hasInvoice: false, notes: [] };

  if (invoiceImageUrl) {
    try {
      const buf = await readUploadBuffer(invoiceImageUrl);
      if (!buf) {
        out.notes.push('INVOICE_IMAGE_NOT_FOUND');
      } else if (buf.length > MAX_ATTACHMENT_BYTES) {
        out.notes.push('INVOICE_IMAGE_TOO_LARGE');
      } else {
        const ext = (String(invoiceImageUrl).match(/\.([a-zA-Z0-9]{1,5})(?:\?|$)/) || [, 'jpg'])[1];
        out.attachments.push({
          filename: `發票_${invoiceNumber || 'invoice'}.${ext}`,
          content: buf,
        });
        out.hasInvoice = true;
      }
    } catch (e) {
      out.notes.push('INVOICE_IMAGE_READ_FAILED');
      console.warn('[reconcileNotify] 讀發票圖失敗（信照寄）：' + e.message);
    }
  }

  return out;
}

const KIND = 'reconcile_success';

function normalizePhone(v) {
  return String(v || '').replace(/\D/g, '');
}

function liffUrl() {
  return String(process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '').trim();
}

/**
 * 「點擊登入家教系統」按鈕要連去哪。
 *
 * 優先走該場館的 LINE 官方帳號深連結：家長點開就是該館的聊天室，
 * 訊息欄已帶好關鍵字，按送出即可拿到登入入口。該館沒有對應 OA
 * （目前 25 個場館裡只有 4 個有）時退回原本的 LIFF 連結 ——
 * 這顆按鈕在任何情況下都不能變成死連結。
 *
 * 舊的 outbox 列沒有 venueId（本欄位 2026-08-12 才加），
 * 補寄時自然落到 liff 那條，與改版前行為相同。
 */
function loginCta(venueId) {
  const oa = venueOaDeepLink(venueId, OA_LOGIN_KEYWORD);
  if (oa) return { loginUrl: oa, loginVia: 'oa', loginKeyword: OA_LOGIN_KEYWORD };
  return { loginUrl: liffUrl(), loginVia: 'liff', loginKeyword: OA_LOGIN_KEYWORD };
}

// 只留寄信會用到的欄位。payload 是要落進 JSONB 的，不要把整列 admin_enrollments
// （含付款證明路徑、發票圖路徑等）原封不動塞進去。
function slimOrder(o) {
  return {
    id: o.id,
    students: o.students,
    course_type: o.course_type,
    coach: o.coach,
    final_price: o.final_price,
    period_number: o.period_number,
    period_count: o.period_count,
    submitted_at: o.submitted_at,
    created_at: o.created_at,
  };
}

/**
 * 以家長電話反查 email。
 * 用正規化後的數字比對，不用字串相等 —— 兩個對帳入口原本一個用 `phone = $1`
 * 一個用 regexp_replace，前者會因為格式差異（空白、-、+886）查不到人。
 */
async function findParentEmail(db, rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  const r = await db.query(
    `SELECT email FROM parents
      WHERE regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = $1
        AND is_active = TRUE
        AND COALESCE(btrim(email), '') <> ''
      ORDER BY updated_at DESC LIMIT 1`,
    [phone]
  );
  return r.rows[0]?.email || null;
}

/**
 * 在對帳交易內排入一封信。永不 throw、永不讓交易 abort。
 * @returns {Promise<number|null>} outbox id（新排入才有；已存在或被跳過回 null）
 */
async function enqueueReconcileMail(client, args) {
  return (await enqueueReconcileMailDetailed(client, args)).id;
}

/**
 * 同上，但把「為什麼沒排入」講清楚（#12 假成功稽核，Codex review）：
 * 以前 null 同時代表「家長沒 Email」「已排過」「DB 出錯」，櫃台畫面會把
 * outbox 故障講成「家長沒有 Email」，讓人去改錯的資料。
 * @returns {Promise<{id: number|null, outcome: 'queued'|'duplicate'|'no_email'|'error'}>}
 */
async function enqueueReconcileMailDetailed(client, { refId, orders, invoice, venueId, venueName, parentPhone, parentName }) {
  try {
    await client.query('SAVEPOINT mail_enqueue');
  } catch (e) {
    console.warn('[reconcileNotify] SAVEPOINT 失敗，略過排信：' + e.message);
    return { id: null, outcome: 'error' };
  }
  try {
    const list = (orders || []).filter(Boolean).map(slimOrder);
    const payload = {
      parentName: parentName || null,
      // venueName 是給人看的（信裡的館別），venueId 是給機器用的（對場館 OA）。
      // 兩個都要存：實際寄送在交易之外，補寄時得能重算同一條登入連結。
      venueId: venueId || (orders || []).find((o) => o && o.venue_id)?.venue_id || null,
      venueName: venueName || null,
      invoiceNumber: invoice?.invoiceNumber || invoice?.invoice_number || null,
      // 發票照片路徑要存進 payload：實際寄送在交易之外，補寄時也要拿得到。
      invoiceImageUrl: invoice?.invoiceImageUrl || invoice?.invoice_image_url || null,
      totalAmount: invoice?.amount ?? null,
      issuedAt: new Date().toISOString(),
      orders: list,
    };
    const email = await findParentEmail(client, parentPhone);
    const built = templates.reconcileSuccess({
      parentName: payload.parentName,
      venueName: payload.venueName,
      orders: list,
      invoiceNumber: payload.invoiceNumber,
      totalAmount: payload.totalAmount,
      ...loginCta(payload.venueId),
      issuedAt: payload.issuedAt,
    });

    // 查無 email 也要留一列。不留的話這筆就從帳上消失了，之後沒人知道
    // 「這家長其實沒收到通知」——實測有 7.5% 的已對帳訂單用電話查不到 parent。
    const status = email ? 'pending' : 'skipped';
    const reason = email ? null : 'NO_PARENT_EMAIL';
    const r = await client.query(
      `INSERT INTO mail_outbox (kind, ref_id, recipient, subject, payload, status, reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [KIND, String(refId), email || '', built.subject, JSON.stringify(payload), status, reason]
    );
    await client.query('RELEASE SAVEPOINT mail_enqueue');
    if (!r.rows[0]) return { id: null, outcome: 'duplicate' };
    if (status !== 'pending') return { id: null, outcome: 'no_email' };
    return { id: r.rows[0].id, outcome: 'queued' };
  } catch (e) {
    // 只回滾到 SAVEPOINT：對帳本身完全不受影響。
    try { await client.query('ROLLBACK TO SAVEPOINT mail_enqueue'); } catch (_) { /* 交易已死，外層會處理 */ }
    try { await client.query('RELEASE SAVEPOINT mail_enqueue'); } catch (_) { /* 同上 */ }
    console.warn('[reconcileNotify] 排信失敗（對帳不受影響）：' + e.message);
    return { id: null, outcome: 'error' };
  }
}

/** 依 outbox 一列組信並交給 mailer；回 mailer 的結果（附件缺漏記在 reason）。 */
async function sendOutboxRow(rowData) {
  const p = rowData.payload || {};
  const att = await buildAttachments({ invoiceImageUrl: p.invoiceImageUrl, invoiceNumber: p.invoiceNumber });
  const built = templates.reconcileSuccess({
    parentName: p.parentName,
    venueName: p.venueName,
    orders: p.orders || [],
    invoiceNumber: p.invoiceNumber,
    totalAmount: p.totalAmount,
    ...loginCta(p.venueId),
    issuedAt: p.issuedAt,
    hasInvoiceAttachment: att.hasInvoice,
  });
  const res = await mailer.sendMail({
    to: rowData.recipient,
    subject: built.subject,
    html: built.html,
    text: built.text,
    attachments: att.attachments,
  });
  // 附件缺漏要記下來，否則「信寄出了但沒發票」會查無原因。
  if (att.notes.length) res.reason = [res.reason, att.notes.join(',')].filter(Boolean).join(' | ');
  return res;
}

/** 依 outbox id 實際寄出。永不 throw —— 呼叫點都在 COMMIT 之後。 */
async function deliverOutbox(ids) {
  const list = (ids || []).filter((x) => x != null);
  if (!list.length) return { sent: 0, dryRun: 0, failed: 0 };
  // 補寄開著時，即時寄送也走「先認領再寄、失敗留給補寄」：避免與補寄同時寄同一封，
  // 也讓 SMTP 暫時失敗的信有機會被補寄。沒開時維持原本行為（失敗即記為 failed）。
  if (require('./reconcileMailSweep').isEnabled()) return deliverClaimed(list);
  const out = { sent: 0, dryRun: 0, failed: 0 };
  for (const id of list) {
    try {
      const r = await pool.query(
        `SELECT id, recipient, payload, status FROM mail_outbox WHERE id = $1 AND status = 'pending'`,
        [id]
      );
      const rowData = r.rows[0];
      if (!rowData) continue;
      const res = await sendOutboxRow(rowData);
      // dry_run 是「沒寄出」，狀態照實記錄，不可以寫成 sent。
      await pool.query(
        `UPDATE mail_outbox
            SET status = $2, reason = $3, attempts = attempts + 1,
                sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END,
                updated_at = NOW()
          WHERE id = $1`,
        [id, res.status, res.reason]
      );
      if (res.status === 'sent') out.sent += 1;
      else if (res.status === 'dry_run') out.dryRun += 1;
      else out.failed += 1;
    } catch (e) {
      out.failed += 1;
      console.warn('[reconcileNotify] 寄送失敗 outbox#' + id + '：' + e.message);
    }
  }
  return out;
}

// 補寄的重試上限：SMTP 一直拒收（例如信箱不存在）時不要每 5 分鐘無限重寄。
const SWEEP_MAX_ATTEMPTS = 5;
// 認領後超過這段時間還停在 sending，視為那台機器寄到一半掛掉，可以重新認領。
const SWEEP_LEASE_MINUTES = 15;

// 寄送結果 → 下一個狀態。失敗退回 pending 等補寄，連續失敗到上限才 failed。
function nextStatusAfterSend(res, attemptsBefore) {
  if (res.status !== 'failed') return res.status;
  return attemptsBefore + 1 >= SWEEP_MAX_ATTEMPTS ? 'failed' : 'pending';
}

// 寄出已認領（status=sending）的一列並回寫結果；回傳寫回的狀態。
async function sendClaimedRow(db, row) {
  let res;
  try {
    res = await sendOutboxRow(row);
  } catch (e) {
    res = { status: 'failed', reason: String(e.message || e).slice(0, 300) };
  }
  const next = nextStatusAfterSend(res, row.attempts);
  try {
    await db.query(
      `UPDATE mail_outbox
          SET status = $2, reason = $3, attempts = attempts + 1,
              sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END,
              updated_at = NOW()
        WHERE id = $1 AND status = 'sending'`,
      [row.id, next, res.reason || null]
    );
  } catch (e) {
    // 寫不回結果時列會停在 sending，租約到期後重新認領（可能重寄一次，不會漏寄）。
    console.warn('[reconcileNotify] 回寫寄送結果失敗 outbox#' + row.id + '：' + e.message);
  }
  return next;
}

function tally(out, next) {
  if (next === 'sent') out.sent += 1;
  else if (next === 'dry_run') out.dryRun += 1;
  else if (next === 'pending') out.retry += 1;
  else if (next === 'failed') out.failed += 1;
  else out.skipped += 1;
}

// 補寄開著時的即時寄送：逐筆認領（pending → sending）再寄。回傳格式與 deliverOutbox 相同，
// 失敗（含留給補寄的）都算在 failed，呼叫端的提示照舊。
async function deliverClaimed(list) {
  const out = { sent: 0, dryRun: 0, failed: 0 };
  for (const id of list) {
    try {
      const r = await pool.query(
        `UPDATE mail_outbox SET status = 'sending', updated_at = NOW()
          WHERE id = $1 AND status = 'pending'
          RETURNING id, recipient, payload, attempts`,
        [id]
      );
      if (!r.rowCount) continue;
      const next = await sendClaimedRow(pool, r.rows[0]);
      if (next === 'sent') out.sent += 1;
      else if (next === 'dry_run') out.dryRun += 1;
      else out.failed += 1;
    } catch (e) {
      out.failed += 1;
      console.warn('[reconcileNotify] 寄送失敗 outbox#' + id + '：' + e.message);
    }
  }
  return out;
}

/**
 * 補寄：撿出還卡在 pending 的（進程在寄信前掛掉、SMTP 暫時不通、或即時寄送失敗）。
 *
 * 先認領再寄：同一個 UPDATE 用 FOR UPDATE SKIP LOCKED 把列從 pending 改成 sending，
 * 多台機器同時跑也只有一台拿得到同一封。寄送失敗退回 pending（次數 +1）等下一輪，
 * 不會被標成 sent；連續失敗到上限才標 failed，交給櫃檯人工通知。
 * 只補建立超過 olderThanMinutes 的列，給對帳當下的即時寄送先處理。
 * 認領查詢失敗時直接丟出，讓 runWithLock 在 job_runs 記成 error，而不是假裝成功。
 * 排程由 services/reconcileMailSweep.js 註冊（feature flag，預設關閉）。
 */
async function sweepPendingMail({ limit = 20, olderThanMinutes = 5, db = pool } = {}) {
  const out = { sent: 0, dryRun: 0, failed: 0, retry: 0, skipped: 0 };
  const claimed = await db.query(
    `UPDATE mail_outbox
        SET status = 'sending', updated_at = NOW()
      WHERE id IN (
        SELECT id FROM mail_outbox
         WHERE (status = 'pending' AND created_at < NOW() - ($2 || ' minutes')::interval)
            OR (status = 'sending' AND updated_at < NOW() - ($3 || ' minutes')::interval)
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, recipient, payload, attempts`,
    [limit, String(olderThanMinutes), String(SWEEP_LEASE_MINUTES)]
  );
  for (const row of claimed.rows) tally(out, await sendClaimedRow(db, row));
  return out;
}

module.exports = {
  KIND,
  enqueueReconcileMail,
  enqueueReconcileMailDetailed,
  deliverOutbox,
  sweepPendingMail,
  SWEEP_MAX_ATTEMPTS,
  SWEEP_LEASE_MINUTES,
  buildAttachments,
  __test__: { normalizePhone, slimOrder, liffUrl, readUploadBuffer, loginCta },
};
