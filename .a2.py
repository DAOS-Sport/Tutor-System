# -*- coding: utf-8 -*-
"""接續 agg1（line.js 已完成）：checkinNotify 彙整 + manualDeductions + 煙霧工具。"""
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

# 前置狀態：line.js 應已改完，checkinNotify 應尚未改
l = read('server/services/line.js')
if 'studentNames' not in l:
    print('FAIL: line.js 尚未套用 agg1'); sys.exit(1)
c = read('server/services/checkinNotify.js')
if 'buildCoachSummary' in c:
    print('FAIL: checkinNotify 已改過，本腳本重複執行'); sys.exit(1)
print('OK   前置狀態符合預期')


SUMMARY = '''/**
 * 把該堂課的多筆簽到列彙整成「給教練的一則」。回 null＝這堂不該通知教練。
 *
 * ── 為什麼要彙整 ──
 * 共班簽到是一次原子寫入整班（checkins.js 的 SHARED_CHECKIN_USAGE_V2 分支直接
 * SELECT 整個 roster 做 INSERT），櫃檯手動扣課也是。逐列推播的話，一堂 1對3 的課
 * 教練手機會連響三次，內容幾乎一樣。dreams400 是全場館共用、每月只有 3,000 則
 * 額度 —— 這樣燒撐不住，而且通知一多就沒人看，真正要當下反應的那則會被淹掉。
 *
 * 抽成純函式是為了能單獨測：誰入選、家長怎麼標、學員怎麼併、時間取哪一個，
 * 都不需要資料庫也不需要 LINE 就能驗。
 */
function buildCoachSummary(rows) {
  // 'coach' 來源僅存在於歷史列（代簽已於 2026-08-10 移除）。見檔頭收訊者規則。
  const usable = (rows || []).filter((r) => r && r.coach_uid && r.checked_in_source !== 'coach');
  if (!usable.length) return null;
  const first = usable[0];

  const uniq = (xs) => Array.from(new Set(xs.map((x) => String(x || '').trim()).filter(Boolean)));
  const students = uniq(usable.map((r) => r.student_name));
  const parents = uniq(usable.map((r) => r.parent_name));

  // 共班可能跨家庭。硬挑第一位家長當代表，會讓教練看到一個跟其他學員不相干的
  // 名字，所以多於一位時改標數量。
  const parentLabel = parents.length === 1 ? parents[0]
    : (parents.length > 1 ? parents.length + ' 位家長' : null);

  // 批次是原子寫入，時間本來就幾乎相同；取最早的，語意是「這堂課的簽到時間」。
  const times = usable
    .map((r) => new Date(r.checked_in_at))
    .filter((d) => !Number.isNaN(d.getTime()));
  const checkedInAt = times.length ? new Date(Math.min.apply(null, times.map((d) => d.getTime()))) : null;

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

'''

rep('server/services/checkinNotify.js',
    'async function notifyCheckin(sessionId, studentIds, db = pool) {',
    SUMMARY + 'async function notifyCheckin(sessionId, studentIds, db = pool) {',
    'checkinNotify：新增 buildCoachSummary')

OLD_LOOP = """  for (const r of rows) {
    const when = r.checked_in_at instanceof Date ? r.checked_in_at.toISOString() : String(r.checked_in_at);

    // ── 教練 ──（教練自己簽的就不用通知他自己）
    // 'coach' 僅存在於歷史列（代簽已於 2026-08-10 移除）。這不是死碼 ——
    // 見檔頭「收訊者規則」：舊課的歷史 coach 列會混在同一批被撈出來。
    if (r.coach_uid && r.checked_in_source !== 'coach') {
      const ch = await resolveChannel({ kind: 'coach' }, '教練');
      if (!ch) { out.skipped += 1; }
      else {
        try {
          const res = await line.pushMessage(
            r.coach_uid,
            line.templates.checkinConfirmedToCoach({
              parentName: r.parent_name,
              studentName: r.student_name,
              courseType: r.course_type ? '1 對 ' + r.course_type : null,
              venueName: r.venue_name || r.venue_id,
              checkedInAt: when,
              source: r.checked_in_source,
            }),
            ch,
            { event: EVENT_COACH, refId: 'c:' + r.checkin_id, recipientKind: 'coach' });
          if (res && res.sent) out.coach += 1;
        } catch (e) { out.failed += 1; console.warn('[checkinNotify] 教練推播失敗：' + e.message); }
      }
    }
"""

NEW_LOOP = """  // ── 教練：一堂課一則 ──
  // refId 用 sessionId 而不是 checkin_id，讓去重索引把「一堂課」收斂成一則。
  // 逐列推的話共班會一次發 N 則；而手動扣課那支是在 roster 迴圈裡呼叫，
  // 沒有這層收斂會變成 N×N 次嘗試（去重擋掉大部分，但仍會送出 N 則）。
  const summary = buildCoachSummary(rows);
  if (summary) {
    const ch = await resolveChannel({ kind: 'coach' }, '教練');
    if (!ch) { out.skipped += 1; }
    else {
      try {
        const res = await line.pushMessage(
          summary.coachUid,
          line.templates.checkinConfirmedToCoach({
            parentName: summary.parentLabel,
            studentNames: summary.studentNames,
            courseType: summary.courseType,
            venueName: summary.venueName,
            checkedInAt: summary.checkedInAt,
            source: summary.source,
          }),
          ch,
          { event: EVENT_COACH, refId: 'cs:' + sessionId, recipientKind: 'coach' });
        if (res && res.sent) out.coach += 1;
      } catch (e) { out.failed += 1; console.warn('[checkinNotify] 教練推播失敗：' + e.message); }
    }
  }

  for (const r of rows) {
    const when = r.checked_in_at instanceof Date ? r.checked_in_at.toISOString() : String(r.checked_in_at);
"""

rep('server/services/checkinNotify.js', OLD_LOOP, NEW_LOOP,
    'checkinNotify：教練通知移出逐列迴圈')

s = read('server/services/checkinNotify.js')
exp = 'module.exports = { notifyCheckin, notifyCheckinSafely'
if s.count(exp) != 1:
    print('FAIL: 匯出錨點 %d 次' % s.count(exp)); sys.exit(1)
write('server/services/checkinNotify.js',
      s.replace(exp, 'module.exports = { notifyCheckin, notifyCheckinSafely, buildCoachSummary', 1))
print('OK   checkinNotify：匯出 buildCoachSummary')

rep('server/routes/admin/manualDeductions.js',
    "    for (const member of attendanceRoster) {\n"
    "      // 簽到通知（教練／家長）。fire-and-forget：簽到已 COMMIT，推播不該把它拖下水。\n"
    "      notifyCheckinSafely(courseSessionId, null);\n"
    "\n",
    "    // 簽到通知（教練／家長）。fire-and-forget：扣課已 COMMIT，推播不該把它拖下水。\n"
    "    // ⚠️ 必須在 roster 迴圈「之外」：這支本來就傳 null（＝通知整堂），\n"
    "    // 放在迴圈裡等於一堂課呼叫 N 次、每次又處理 N 列 —— N×N 次推播嘗試。\n"
    "    // 去重索引擋掉大部分，但那是在補破網，不是設計。\n"
    "    notifyCheckinSafely(courseSessionId, null);\n"
    "\n"
    "    for (const member of attendanceRoster) {\n",
    'manualDeductions：通知移出 roster 迴圈')

rep('server/scripts/pushTemplateSmoke.js',
    "  checkinConfirmedToCoach: { parentName: '範例家長', studentName: '範例學員', courseType: '1 對 2', venueName: '範例場館', checkedInAt: AT, source: 'parent' },",
    "  checkinConfirmedToCoach: { parentName: '範例家長', studentNames: ['範例學員A', '範例學員B'], courseType: '1 對 2', venueName: '範例場館', checkedInAt: AT, source: 'parent' },",
    'pushTemplateSmoke：假資料改用學員清單')

print('\nDONE')
