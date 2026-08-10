# -*- coding: utf-8 -*-
"""Email 模組（2/2）：reconcileNotify 服務 + 兩個對帳入口接線 + 測試。"""
import io, sys

def read(p):
    with io.open(p, encoding='utf-8') as f:
        return f.read()

def write(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)

log = []

def rep(path, old, new, label):
    s = read(path)
    n = s.count(old)
    if n != 1:
        print('FAIL [%s] %s: expected 1, found %d' % (label, path, n)); sys.exit(1)
    write(path, s.replace(old, new, 1))
    log.append('OK   %s' % label)

def slice_replace(path, a, b, new, label, must_contain=()):
    s = read(path)
    if s.count(a) != 1 or s.count(b) != 1:
        print('FAIL [%s] %s: anchors a=%d b=%d' % (label, path, s.count(a), s.count(b))); sys.exit(1)
    i, j = s.index(a), s.index(b)
    if j <= i:
        print('FAIL [%s] %s: b before a' % (label, path)); sys.exit(1)
    removed = s[i:j]
    for need in must_contain:
        if need not in removed:
            print('FAIL [%s] %s: removed chunk missing %r' % (label, path, need)); sys.exit(1)
    write(path, s[:i] + new + s[j:])
    log.append('OK   %s（換掉 %d 字元）' % (label, len(removed)))


# ═══════════════ server/services/reconcileNotify.js ═══════════════
SVC = r'''
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
'''.lstrip('\n')

write('server/services/reconcileNotify.js', SVC)
log.append('OK   新增 server/services/reconcileNotify.js')


# ═══════════════ checkouts.js（主線，97.5% 流量）═══════════════
P = 'server/routes/admin/checkouts.js'

rep(P,
    "    for (const { row, total } of rowsToOpen) {\n"
    "      await ensureGroupCoursePeriod(client, row, total);\n"
    "      const ids = (await ensureSoloCoursePeriod(client, row, total)) || [];\n"
    "      createdStudentIds.push(...ids);\n"
    "    }\n"
    "\n"
    "    await client.query('COMMIT');\n",
    "    for (const { row, total } of rowsToOpen) {\n"
    "      await ensureGroupCoursePeriod(client, row, total);\n"
    "      const ids = (await ensureSoloCoursePeriod(client, row, total)) || [];\n"
    "      createdStudentIds.push(...ids);\n"
    "    }\n"
    "\n"
    "    // 家長通知信排進 outbox —— 刻意在 COMMIT 之前：COMMIT 了就一定留得住，\n"
    "    // 之後進程掛掉還能補寄。enqueue 內部有 SAVEPOINT 保護，絕不會弄壞對帳。\n"
    "    for (const invoice of invoicePlans) {\n"
    "      const familyOrders = children.rows.filter((r0) => checkoutFamilyKey(r0) === invoice.familyKey);\n"
    "      if (!familyOrders.length) continue;\n"
    "      const venueRow = await client.query(`SELECT name FROM venues WHERE id = $1`, [familyOrders[0].venue_id]);\n"
    "      const mailId = await enqueueReconcileMail(client, {\n"
    "        // 去重鍵：同一張付款單的同一個家庭只會有一封。\n"
    "        refId: `${req.params.checkoutId}:${invoice.familyKey}`,\n"
    "        orders: familyOrders,\n"
    "        invoice,\n"
    "        venueName: venueRow.rows[0]?.name || familyOrders[0].venue_id,\n"
    "        parentPhone: invoice.family.parent_phone,\n"
    "        parentName: invoice.family.parent_name,\n"
    "      });\n"
    "      if (mailId) mailOutboxIds.push(mailId);\n"
    "    }\n"
    "\n"
    "    await client.query('COMMIT');\n",
    'checkouts.js：COMMIT 前排入通知信')

rep(P,
    "  const client = await pool.connect();\n  const createdStudentIds = [];\n",
    "  const client = await pool.connect();\n  const createdStudentIds = [];\n  const mailOutboxIds = [];\n",
    'checkouts.js：宣告 mailOutboxIds')

slice_replace(P,
    "    const line = require('../../services/line');\n    for (const invoice of invoicePlans) {",
    "    res.json(await readCheckout(pool, req.params.checkoutId));",
    "    // 家長端改走 Email（Owner 決定：家長不用 LINE）。\n"
    "    // 寄信失敗絕不能影響對帳 —— 已經 COMMIT 了，deliverOutbox 內部不會 throw，\n"
    "    // 沒寄成的會留在 outbox 等 sweepPendingMail 補。\n"
    "    await deliverOutbox(mailOutboxIds);\n"
    "\n",
    'checkouts.js：家長 LINE 發票推播 → Email',
    must_contain=("line.pushMessage", "invoiceIssued", "PUBLIC_BASE_URL"))

rep(P,
    "const { checkoutFamilyKey",
    "const { enqueueReconcileMail, deliverOutbox } = require('../../services/reconcileNotify');\nconst { checkoutFamilyKey",
    'checkouts.js：import reconcileNotify')


# ═══════════════ enrollments.js（legacy 單筆入口）═══════════════
P = 'server/routes/admin/enrollments.js'

rep(P,
    "    const reconcileCreatedStudentIds = (await ensureSoloCoursePeriod(client, cur.rows[0], total)) || [];\n"
    "\n"
    "    await client.query('COMMIT');\n",
    "    const reconcileCreatedStudentIds = (await ensureSoloCoursePeriod(client, cur.rows[0], total)) || [];\n"
    "\n"
    "    // 家長通知信排進 outbox（COMMIT 前，理由同 checkouts.js）。\n"
    "    // 這支是 legacy 單筆入口，等同 checkout 版 N=1 的退化情形。\n"
    "    const mailOutboxId = await enqueueReconcileMail(client, {\n"
    "      refId: String(id),\n"
    "      orders: [cur.rows[0]],\n"
    "      invoice: { invoiceNumber, amount: cur.rows[0].final_price },\n"
    "      venueName: (await client.query(`SELECT name FROM admin_venues WHERE id = $1`, [cur.rows[0].venue_id])).rows[0]?.name\n"
    "        || cur.rows[0].venue_id,\n"
    "      parentPhone: cur.rows[0].parent_phone,\n"
    "      parentName: cur.rows[0].parent_name,\n"
    "    });\n"
    "\n"
    "    await client.query('COMMIT');\n",
    'enrollments.js：COMMIT 前排入通知信')

slice_replace(P,
    "    // Task #39：推播 LINE Flex 發票通知給家長（含課程資訊）",
    "    res.json(await readEnrollment(id));",
    "    // 家長端改走 Email（Owner 決定：家長不用 LINE）。\n"
    "    await deliverOutbox([mailOutboxId]);\n"
    "\n",
    'enrollments.js：家長 LINE 發票推播 → Email',
    must_contain=("line.pushMessage", "invoiceIssued", "PUBLIC_BASE_URL"))

rep(P,
    "const ragicWriteback = require",
    "const { enqueueReconcileMail, deliverOutbox } = require('../../services/reconcileNotify');\nconst ragicWriteback = require",
    'enrollments.js：import reconcileNotify')


# ═══════════════ .env.example ═══════════════
s = read('.env.example')
if 'SMTP_HOST' not in s:
    s = s.rstrip('\n') + '''

# ── 家長通知信（對帳成功）──────────────────────────────────────────────
# 沒設定時 mailer 自動進 dry-run：只在 mail_outbox 記一筆 status=dry_run，
# 不送出也不報錯。補上設定後即開始真的寄。
# Gmail 需使用「應用程式密碼」而非帳號密碼（且帳號要開啟兩步驟驗證）。
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_account@gmail.com
SMTP_PASS=your_app_password
SMTP_FROM=夢想體育學院 <your_account@gmail.com>
# SMTP_SECURE=1        # port 465 會自動視為 secure，587 走 STARTTLS 不用設
# MAIL_DRY_RUN=1       # 設定完整但暫時不想真的寄
# MAIL_TEST_RECIPIENT=you@example.com   # 所有信改寄這裡（上線前的安全閥）
'''
    write('.env.example', s)
    log.append('OK   .env.example 新增 SMTP 區段')
else:
    print('FAIL: .env.example 已有 SMTP_HOST，錨點可能重複執行'); sys.exit(1)

print('\n'.join(log))
print('\nDONE mail2')
