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
const { pool } = require('../models/db');
const mailer = require('./mailer');
const templates = require('./emailTemplates');

const KIND = 'reconcile_success';

function normalizePhone(v) {
  return String(v || '').replace(/\D/g, '');
}

function liffUrl() {
  return String(process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '').trim();
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
async function enqueueReconcileMail(client, { refId, orders, invoice, venueName, parentPhone, parentName }) {
  try {
    await client.query('SAVEPOINT mail_enqueue');
  } catch (e) {
    console.warn('[reconcileNotify] SAVEPOINT 失敗，略過排信：' + e.message);
    return null;
  }
  try {
    const list = (orders || []).filter(Boolean).map(slimOrder);
    const payload = {
      parentName: parentName || null,
      venueName: venueName || null,
      invoiceNumber: invoice?.invoiceNumber || invoice?.invoice_number || null,
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
      liffUrl: liffUrl(),
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
    return status === 'pending' ? (r.rows[0]?.id || null) : null;
  } catch (e) {
    // 只回滾到 SAVEPOINT：對帳本身完全不受影響。
    try { await client.query('ROLLBACK TO SAVEPOINT mail_enqueue'); } catch (_) { /* 交易已死，外層會處理 */ }
    try { await client.query('RELEASE SAVEPOINT mail_enqueue'); } catch (_) { /* 同上 */ }
    console.warn('[reconcileNotify] 排信失敗（對帳不受影響）：' + e.message);
    return null;
  }
}

/** 依 outbox id 實際寄出。永不 throw —— 呼叫點都在 COMMIT 之後。 */
async function deliverOutbox(ids) {
  const list = (ids || []).filter((x) => x != null);
  if (!list.length) return { sent: 0, dryRun: 0, failed: 0 };
  const out = { sent: 0, dryRun: 0, failed: 0 };
  for (const id of list) {
    try {
      const r = await pool.query(
        `SELECT id, recipient, payload, status FROM mail_outbox WHERE id = $1 AND status = 'pending'`,
        [id]
      );
      const rowData = r.rows[0];
      if (!rowData) continue;
      const p = rowData.payload || {};
      const built = templates.reconcileSuccess({
        parentName: p.parentName,
        venueName: p.venueName,
        orders: p.orders || [],
        invoiceNumber: p.invoiceNumber,
        totalAmount: p.totalAmount,
        liffUrl: liffUrl(),
        issuedAt: p.issuedAt,
      });
      const res = await mailer.sendMail({
        to: rowData.recipient,
        subject: built.subject,
        html: built.html,
        text: built.text,
      });
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

/**
 * 補寄：撿出還卡在 pending 的（進程在寄信前掛掉、或當時 SMTP 暫時不通）。
 * 可接到 cron，也可以人工呼叫。
 */
async function sweepPendingMail({ limit = 20, olderThanMinutes = 5 } = {}) {
  try {
    const r = await pool.query(
      `SELECT id FROM mail_outbox
        WHERE status = 'pending' AND created_at < NOW() - ($2 || ' minutes')::interval
        ORDER BY created_at
        LIMIT $1`,
      [limit, String(olderThanMinutes)]
    );
    return await deliverOutbox(r.rows.map((x) => x.id));
  } catch (e) {
    console.warn('[reconcileNotify] sweep 失敗：' + e.message);
    return { sent: 0, dryRun: 0, failed: 0 };
  }
}

module.exports = {
  KIND,
  enqueueReconcileMail,
  deliverOutbox,
  sweepPendingMail,
  __test__: { normalizePhone, slimOrder, liffUrl },
};
