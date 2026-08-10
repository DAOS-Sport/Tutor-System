# -*- coding: utf-8 -*-
"""教練通知彙整為「一堂課一則」。"""
import io, os, sys

def read(p):
    with io.open(p, encoding='utf-8') as f:
        return f.read()

def write(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)

def rep(path, old, new, label=None):
    if label is None:
        label = os.path.basename(path) + '：' + old.strip().splitlines()[0][:40]
    s = read(path)
    n = s.count(old)
    if n != 1:
        print('FAIL [%s] %s: expected 1, found %d' % (label, path, n)); sys.exit(1)
    write(path, s.replace(old, new, 1))
    print('OK   %s' % label)


# ═══════ 1. 樣板：學員改成清單 ═══════
P = 'server/services/line.js'

rep(P,
    "function checkinConfirmedToCoach({ parentName, studentName, courseType, venueName, checkedInAt, source }) {",
    "function checkinConfirmedToCoach({ parentName, studentNames, courseType, venueName, checkedInAt, source }) {")

rep(P,
    "  const from = source === 'staff' ? '櫃台補登' : '家長自助簽到';\n"
    "  // 教練要一眼看出「哪位家長、什麼課、誰要上」，所以主標是家長，其餘放在下方欄位。\n"
    "  const who = parentName || studentName || '家長';",
    "  const from = source === 'staff' ? '櫃台補登' : '家長自助簽到';\n"
    "  // 共班一次寫入整班，所以學員是清單而不是單一個。\n"
    "  const names = (Array.isArray(studentNames) ? studentNames : [studentNames])\n"
    "    .map((x) => String(x || '').trim()).filter(Boolean);\n"
    "  // 教練要一眼看出「哪位家長、什麼課、誰要上」，所以主標是家長，其餘放在下方欄位。\n"
    "  const who = parentName || names[0] || '家長';")

rep(P,
    "              ...(studentName && studentName !== who ? [kv('學員', studentName)] : []),",
    "              // 學員清單。人數多時附上數量 —— 教練要核對「是不是全班都到了」。\n"
    "              ...(names.length && !(names.length === 1 && names[0] === who)\n"
    "                ? [kv(names.length > 1 ? `學員（${names.length} 位）` : '學員', names.join('、'))]\n"
    "                : []),")

rep(P,
    "    type: 'flex', altText: `${who} 已簽到`,\n    contents: {\n      type: 'bubble',\n      header: {\n        type: 'box', layout: 'vertical', backgroundColor: BRAND.primary,",
    "    type: 'flex', altText: `${who} 已簽到`,\n    contents: {\n      type: 'bubble',\n      header: {\n        type: 'box', layout: 'vertical', backgroundColor: BRAND.primary,")


# ═══════ 2. checkinNotify：彙整成一則 ═══════
P = 'server/services/checkinNotify.js'

rep(P,
    "function normalizePhone",
    """/**
 * 把該堂課的多筆簽到列彙整成「給教練的一則」。回 null＝這堂不該通知教練。
 *
 * ── 為什麼要彙整 ──
 * 共班簽到是一次原子寫入整班（checkins.js 的 SHARED_CHECKIN_USAGE_V2 分支直接
 * SELECT 整個 roster 做 INSERT），櫃檯手動扣課也是。逐列推播的話，一堂 1對3 的課
 * 教練手機會連響三次，內容幾乎一樣。dreams400 是全場館共用、每月只有 3,000 則額度 ——
 * 這樣燒法撐不住，而且通知一多就沒人看，真正要當下反應的那則會被淹掉。
 *
 * 抽成純函式是為了能單獨測：彙整邏輯（誰入選、家長怎麼標、學員怎麼併）
 * 不需要資料庫也不需要 LINE 就能驗。
 */
function buildCoachSummary(rows) {
  // 'coach' 來源僅存在於歷史列（代簽已於 2026-08-10 移除）。見檔頭收訊者規則。
  const usable = (rows || []).filter((r) => r && r.coach_uid && r.checked_in_source !== 'coach');
  if (!usable.length) return null;
  const first = usable[0];

  const uniq = (xs) => Array.from(new Set(xs.map((x) => String(x || '').trim()).filter(Boolean)));
  const students = uniq(usable.map((r) => r.student_name));
  const parents = uniq(usable.map((r) => r.parent_name));

  // 共班可能跨家庭。硬挑第一位家長當代表會讓其他家庭的教練看到不相干的名字，
  // 所以多於一位時改標數量。
  const parentLabel = parents.length === 1 ? parents[0]
    : (parents.length > 1 ? `${parents.length} 位家長` : null);

  // 批次是原子寫入，時間本來就幾乎相同；取最早的，語意是「這堂課的簽到時間」。
  const times = usable.map((r) => new Date(r.checked_in_at)).filter((d) => !Number.isNaN(d.getTime()));
  const checkedInAt = times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;

  return {
    coachUid: first.coach_uid,
    parentLabel,
    studentNames: students,
    courseType: first.course_type ? '1 對 ' + first.course_type : null,
    venueName: first.venue_name || first.venue_id || null,
    checkedInAt: checkedInAt ? checkedInAt.toISOString() : null,
    source: first.checked_in_source,
  };
}

function normalizePhone""")

rep(P,
    "  for (const r of rows) {\n"
    "    const when = r.checked_in_at instanceof Date ? r.checked_in_at.toISOString() : String(r.checked_in_at);\n"
    "\n"
    "    // ── 教練 ──（教練自己簽的就不用通知他自己）\n"
    "    // 'coach' 僅存在於歷史列（代簽已於 2026-08-10 移除）。這不是死碼 ——\n"
    "    // 見檔頭「收訊者規則」：舊課的歷史 coach 列會混在同一批被撈出來。\n"
    "    if (r.coach_uid && r.checked_in_source !== 'coach') {\n"
    "      const ch = await resolveChannel({ kind: 'coach' }, '教練');\n"
    "      if (!ch) { out.skipped += 1; }\n"
    "      else {\n"
    "        try {\n"
    "          const res = await line.pushMessage(\n"
    "            r.coach_uid,\n"
    "            line.templates.checkinConfirmedToCoach({\n"
    "              parentName: r.parent_name,\n"
    "              studentName: r.student_name,\n"
    "              courseType: r.course_type ? '1 對 ' + r.course_type : null,\n"
    "              venueName: r.venue_name || r.venue_id,\n"
    "              checkedInAt: when,\n"
    "              source: r.checked_in_source,\n"
    "            }),\n"
    "            ch,\n"
    "            { event: EVENT_COACH, refId: 'c:' + r.checkin_id, recipientKind: 'coach' });\n"
    "          if (res && res.sent) out.coach += 1;\n"
    "        } catch (e) { out.failed += 1; console.warn('[checkinNotify] 教練推播失敗：' + e.message); }\n"
    "      }\n"
    "    }\n",
    "  // ── 教練：一堂課一則 ──\n"
    "  // refId 用 sessionId 而不是 checkin_id，讓去重索引把「一堂課」收斂成一則。\n"
    "  // 逐列推的話共班會一次發 N 則；而且手動扣課那支是在 roster 迴圈裡呼叫，\n"
    "  // 沒有這層收斂會變成 N×N 次嘗試（去重擋掉大部分，但仍會送出 N 則）。\n"
    "  const summary = buildCoachSummary(rows);\n"
    "  if (summary) {\n"
    "    const ch = await resolveChannel({ kind: 'coach' }, '教練');\n"
    "    if (!ch) { out.skipped += 1; }\n"
    "    else {\n"
    "      try {\n"
    "        const res = await line.pushMessage(\n"
    "          summary.coachUid,\n"
    "          line.templates.checkinConfirmedToCoach({\n"
    "            parentName: summary.parentLabel,\n"
    "            studentNames: summary.studentNames,\n"
    "            courseType: summary.courseType,\n"
    "            venueName: summary.venueName,\n"
    "            checkedInAt: summary.checkedInAt,\n"
    "            source: summary.source,\n"
    "          }),\n"
    "          ch,\n"
    "          { event: EVENT_COACH, refId: 'cs:' + sessionId, recipientKind: 'coach' });\n"
    "        if (res && res.sent) out.coach += 1;\n"
    "      } catch (e) { out.failed += 1; console.warn('[checkinNotify] 教練推播失敗：' + e.message); }\n"
    "    }\n"
    "  }\n"
    "\n"
    "  for (const r of rows) {\n"
    "    const when = r.checked_in_at instanceof Date ? r.checked_in_at.toISOString() : String(r.checked_in_at);\n"
    "\n",
    'checkinNotify：教練通知移出逐列迴圈，一堂課一則')

s = read(P)
if 'buildCoachSummary' not in s:
    print('FAIL: buildCoachSummary 沒插入'); sys.exit(1)
# 匯出供測試
old_exp = "module.exports = { notifyCheckin, notifyCheckinSafely"
if s.count(old_exp) != 1:
    print('FAIL: checkinNotify 匯出錨點 %d 次' % s.count(old_exp)); sys.exit(1)
write(P, s.replace(old_exp, "module.exports = { notifyCheckin, notifyCheckinSafely, buildCoachSummary", 1))
print('OK   checkinNotify：匯出 buildCoachSummary')


# ═══════ 3. manualDeductions：把通知移出 roster 迴圈 ═══════
rep('server/routes/admin/manualDeductions.js',
    "    for (const member of attendanceRoster) {\n"
    "      // 簽到通知（教練／家長）。fire-and-forget：簽到已 COMMIT，推播不該把它拖下水。\n"
    "      notifyCheckinSafely(courseSessionId, null);\n"
    "\n",
    "    // 簽到通知（教練／家長）。fire-and-forget：扣課已 COMMIT，推播不該把它拖下水。\n"
    "    // ⚠️ 必須在 roster 迴圈「之外」呼叫：這支本來就是傳 null（＝通知整堂），\n"
    "    // 放在迴圈裡等於一堂課呼叫 N 次、每次又處理 N 列 —— N×N 次推播嘗試。\n"
    "    // 去重索引擋掉大部分，但那是在補破網，不是設計。\n"
    "    notifyCheckinSafely(courseSessionId, null);\n"
    "\n"
    "    for (const member of attendanceRoster) {\n",
    'manualDeductions：通知移出 roster 迴圈（原本 N×N 次）')


# ═══════ 4. 煙霧測試工具的假資料同步 ═══════
rep('server/scripts/pushTemplateSmoke.js',
    "  checkinConfirmedToCoach: { parentName: '範例家長', studentName: '範例學員', courseType: '1 對 2', venueName: '範例場館', checkedInAt: AT, source: 'parent' },",
    "  checkinConfirmedToCoach: { parentName: '範例家長', studentNames: ['範例學員A', '範例學員B'], courseType: '1 對 2', venueName: '範例場館', checkedInAt: AT, source: 'parent' },",
    'pushTemplateSmoke：假資料改用學員清單')

print('\nDONE')
