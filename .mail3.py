# -*- coding: utf-8 -*-
"""Email 模組（2/2 續）：mail2 在 checkouts 的第 3 個編輯中止，這裡接續。
結束錨點改成「起點之後的第一個出現」，因為 res.json(readCheckout) 在檔內有兩處。"""
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
    """b 從 a 之後開始找 —— 結束錨點只要求「在起點之後唯一的第一個」。"""
    s = read(path)
    if s.count(a) != 1:
        print('FAIL [%s] %s: 起點錨點出現 %d 次' % (label, path, s.count(a))); sys.exit(1)
    i = s.index(a)
    j = s.find(b, i)
    if j < 0:
        print('FAIL [%s] %s: 起點之後找不到結束錨點' % (label, path)); sys.exit(1)
    removed = s[i:j]
    for need in must_contain:
        if need not in removed:
            print('FAIL [%s] %s: 待換掉的區塊少了 %r' % (label, path, need)); sys.exit(1)
    write(path, s[:i] + new + s[j:])
    log.append('OK   %s（換掉 %d 字元）' % (label, len(removed)))


# 前置狀態檢查：mail2 已完成的兩個編輯必須在，未完成的必須不在。
c = read('server/routes/admin/checkouts.js')
if 'mailOutboxIds' not in c:
    print('FAIL: checkouts.js 沒有 mailOutboxIds —— mail2 的前兩個編輯沒套用，狀態不符預期'); sys.exit(1)
if 'enqueueReconcileMail' not in c:
    print('FAIL: checkouts.js 沒有 enqueueReconcileMail 呼叫 —— 狀態不符預期'); sys.exit(1)
if "require('../../services/reconcileNotify')" in c:
    print('FAIL: checkouts.js 已 import reconcileNotify —— 本腳本重複執行了'); sys.exit(1)
print('OK   前置狀態符合預期（mail2 停在 checkouts 第 3 個編輯）')


# ═══════════════ checkouts.js 續 ═══════════════
P = 'server/routes/admin/checkouts.js'

slice_replace(P,
    "    const line = require('../../services/line');\n    for (const invoice of invoicePlans) {",
    "    res.json(await readCheckout(pool, req.params.checkoutId));",
    "    // 家長端改走 Email（Owner 決定：家長不用 LINE）。\n"
    "    // 寄信失敗絕不能影響對帳 —— 已經 COMMIT 了。deliverOutbox 內部不會 throw，\n"
    "    // 沒寄成的留在 outbox 等 sweepPendingMail 補。\n"
    "    await deliverOutbox(mailOutboxIds);\n"
    "\n",
    'checkouts.js：家長 LINE 發票推播 → Email',
    must_contain=("line.pushMessage", "invoiceIssued", "PUBLIC_BASE_URL"))

rep(P,
    "const { checkoutFamilyKey",
    "const { enqueueReconcileMail, deliverOutbox } = require('../../services/reconcileNotify');\nconst { checkoutFamilyKey",
    'checkouts.js：import reconcileNotify')


# ═══════════════ enrollments.js ═══════════════
P = 'server/routes/admin/enrollments.js'

rep(P,
    "    const reconcileCreatedStudentIds = (await ensureSoloCoursePeriod(client, cur.rows[0], total)) || [];\n"
    "\n"
    "    await client.query('COMMIT');\n",
    "    const reconcileCreatedStudentIds = (await ensureSoloCoursePeriod(client, cur.rows[0], total)) || [];\n"
    "\n"
    "    // 家長通知信排進 outbox（COMMIT 前，理由同 checkouts.js）。\n"
    "    // 這支是 legacy 單筆入口，等同 checkout 版 N=1 的退化情形。\n"
    "    const venueNameRow = await client.query(`SELECT name FROM admin_venues WHERE id = $1`, [cur.rows[0].venue_id]);\n"
    "    const mailOutboxId = await enqueueReconcileMail(client, {\n"
    "      refId: String(id),\n"
    "      orders: [cur.rows[0]],\n"
    "      invoice: { invoiceNumber, amount: cur.rows[0].final_price },\n"
    "      venueName: venueNameRow.rows[0]?.name || cur.rows[0].venue_id,\n"
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
if 'SMTP_HOST' in s:
    print('FAIL: .env.example 已有 SMTP_HOST'); sys.exit(1)
s = s.rstrip('\n') + '''

# ── 家長通知信（對帳成功）──────────────────────────────────────────────
# 沒設定時 mailer 自動進 dry-run：只在 mail_outbox 記一筆 status=dry_run，
# 不送出也不報錯。補上設定後即開始真的寄。
# Gmail 需使用「應用程式密碼」而非帳號密碼（且該帳號要先開啟兩步驟驗證）。
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_account@gmail.com
SMTP_PASS=your_app_password
SMTP_FROM=your_account@gmail.com
# SMTP_SECURE=1        # port 465 會自動視為 secure；587 走 STARTTLS 不用設
# MAIL_DRY_RUN=1       # 設定完整但暫時不想真的寄
# MAIL_TEST_RECIPIENT=you@example.com   # 所有信改寄這裡（上線前的安全閥）
'''
write('.env.example', s)
log.append('OK   .env.example 新增 SMTP 區段')

print('\n'.join(log))
print('\nDONE mail3')
