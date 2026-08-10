# -*- coding: utf-8 -*-
"""解衝突：兩邊都對，各取該取的那一半。"""
import io, subprocess, sys

def read(p):
    with io.open(p, encoding='utf-8') as f:
        return f.read()

def write(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)

def rep(path, old, new, label):
    s = read(path)
    n = s.count(old)
    if n != 1:
        print('FAIL [%s] %s: expected 1, found %d' % (label, path, n)); sys.exit(1)
    write(path, s.replace(old, new, 1))
    print('OK   %s' % label)

def take_ours(path):
    r = subprocess.run(['git', 'checkout', '--ours', '--', path])
    if r.returncode: print('FAIL: checkout --ours %s' % path); sys.exit(1)
    s = read(path)
    if '<<<<<<<' in s or '>>>>>>>' in s:
        print('FAIL: %s 仍有衝突標記' % path); sys.exit(1)
    print('OK   %s 取本分支版本為底' % path)


# ═══════ CoachTodayPage：取我的（section 已改用共用元件），補上他們的 checkinLabel ═══════
P = 'client/liff/src/pages/CoachTodayPage.jsx'
take_ours(P)

rep(P,
    "import { courseTypeLabel, formatTWDate, formatTWTime } from '../utils/format';",
    "import { courseTypeLabel, formatTWDate, formatTWTime, checkinLabel } from '../utils/format';",
    'CoachTodayPage：補上 checkinLabel import（另一分支的修正，本分支漏掉）')

rep(P,
    "                    {s.checked_in ? (s.checked_in_at ? '已簽到 ' + formatTWTime(s.checked_in_at) : '已簽到') : '未簽到'}",
    "                    {s.checked_in ? checkinLabel(s.scheduled_at, s.checked_in_at) : '未簽到'}",
    'CoachTodayPage：簽到卡不再重複印時間')


# ═══════ sessions.js：取我的（整支重寫過），套用他們對 'active' 的判斷 ═══════
P = 'server/routes/sessions.js'
take_ours(P)

rep(P,
    "const COACH_ENROLLMENT_STATUSES = \"('pending_payment','confirmed','active')\";",
    "// 不含 'active'：正式庫那批 legacy 資料是 2026-05-03 同一秒的匯入批次，\n"
    "// 列在教練可見清單裡只會讓人以為它會出現。本分支新增的「教練姓名回退」\n"
    "// 反而讓這些 coach_id 為 NULL 的舊列更可能浮出來，所以更該擋掉。\n"
    "const COACH_ENROLLMENT_STATUSES = \"('pending_payment','confirmed')\";",
    "sessions.js：教練可見狀態不含 'active'")

rep(P,
    "    const counts = { pending_payment: 0, confirmed: 0, active: 0 };",
    "    const counts = { pending_payment: 0, confirmed: 0 };",
    "sessions.js：counts 同步移除 active")


# ═══════ 共用元件的 ENROLL_STAGES 同步 ═══════
rep('client/liff/src/components/coach/EnrollmentRow.jsx',
    "  { key: 'active', label: '上課中', rail: 'border-l-brand-teal bg-brand-teal/5', text: 'text-teal-700' },\n",
    "  // 'active' 不列：後端已不回傳這個狀態（legacy 匯入批次，見 sessions.js）。\n"
    "  // 萬一哪天真的出現，stageOf 會退回 paymentStatusLabel 給出「進行中」，不會顯示錯的階段。\n",
    'EnrollmentRow：移除永遠不會出現的 active 階段')

print('\n--- 確認沒有殘留衝突標記 ---')
r = subprocess.run(['git', 'diff', '--name-only', '--diff-filter=U'], stdout=subprocess.PIPE)
left = r.stdout.decode().strip()
print(left if left else '(無)')
sys.exit(1 if left else 0)
