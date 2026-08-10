/**
 * 樣板煙霧測試 —— 把 19 個 LINE 模板各發一份給「指定的單一 LINE ID」，
 * 用來肉眼確認每個模板在手機上長什麼樣、有沒有壞版。
 *
 * 安全設計：
 *   - 只能送給命令列明確指定的一個 uid，不從資料庫撈任何真實客戶
 *   - 預設是演練（只印出要送什麼），必須加 --apply 才會真的送出
 *   - 每一則都寫進 line_push_log（event='template_smoke'），事後查得到
 *   - 不經過 pushGate 的事件開關 —— 這是維運人員手動觸發的一次性動作，
 *     不是產品功能；把它掛進事件開關反而要為了測試去開總開關，更危險
 *
 * 用法：
 *   node scripts/pushTemplateSmoke.js --uid=U... --venue=B            # 演練
 *   node scripts/pushTemplateSmoke.js --uid=U... --venue=B --apply    # 真的送
 *   node scripts/pushTemplateSmoke.js --uid=U... --venue=B --apply --only=enrollmentSuccess
 *   node scripts/pushTemplateSmoke.js --uid=U... --venue=dreams400 --apply --only=sessionReminder --role=coach
 */
const axios = require('axios');
const line = require('../services/line');
const { pool } = require('../models/db');

const arg = (k, d = null) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const APPLY = process.argv.includes('--apply');
const UID = arg('uid');
const VENUE = arg('venue');
const ONLY = arg('only');
// 有些樣板同一支要對教練與家長各出一種面貌（如 sessionReminder 的 role）。
// 假資料只寫死一種的話，工具看起來涵蓋了全部樣板，實際上另一面從沒被看過。
const ROLE = arg('role');

if (!UID || !/^U[0-9a-f]{32}$/i.test(UID)) {
  console.error('必須提供合法的 --uid=U…（32 位十六進位）。這支腳本只會送給這一個人。');
  process.exit(1);
}
if (!VENUE) { console.error('必須提供 --venue=<場館代號>，決定用哪個官方帳號的 token 送。'); process.exit(1); }

const LIFF = process.env.LIFF_URL_PARENT || process.env.LIFF_URL || 'https://example.invalid/liff';
const AT = '2026-08-06T14:00:00+08:00';

// 每個模板配一組看得懂的假資料。刻意用「範例」字樣，避免收件者誤以為是真的通知。
const SAMPLES = {
  enrollmentSuccess:     { coachName: '範例教練', venueName: '範例場館', courseType: '1 對 1', finalPrice: 6900, liffUrl: LIFF },
  checkinConfirmed:      { studentName: '範例學員', coachName: '範例教練', venueName: '範例場館', checkedInAt: AT, liffUrl: LIFF },
  checkinConfirmedToCoach: { parentName: '範例家長', studentName: '範例學員', courseType: '1 對 2', venueName: '範例場館', checkedInAt: AT, source: 'parent' },
  groupSubmitted:        { total: 4, venueName: '範例場館', courseType: '1 對 3', liffUrl: LIFF },
  courseActivated:       { coachName: '範例教練', venueName: '範例場館', liffUrl: LIFF },
  slotBooked:            { coachName: '範例教練', venueName: '範例場館', scheduledAt: AT, liffUrl: LIFF },
  groupConfirmInvite:    { initiatorName: '範例家長', coachName: '範例教練', scheduledAt: AT, agreeUrl: LIFF, rejectUrl: LIFF },
  sessionReminder:       { coachName: '範例教練', venueName: '範例場館', scheduledAt: AT, role: 'parent' },
  selfCancelToCoach:     { studentName: '範例學員', scheduledAt: AT, cancelType: 'self' },
  expiryReminder:        { coachName: '範例教練', remainingSessions: 2, expiresAt: '2026-09-30', liffUrl: LIFF },
  coursePlanPublished:   { coachName: '範例教練', liffUrl: LIFF },
  sessionRecordPublished:{ coachName: '範例教練', sessionDate: '2026-08-05', liffUrl: LIFF },
  groupMemberJoined:     { memberName: '範例家長', total: 3, min: 2, max: 6, reachedMin: true, liffUrl: LIFF },
  returnedForFix:        { title: '範例：匯款證明退回', reason: '影像不清楚', hint: '請重新上傳', liffUrl: LIFF },
  evaluationInvite:      { coachName: '範例教練', liffUrl: LIFF },
  keywordAlert:          { coachName: '範例教練', parentName: '範例家長', keyword: '退費', chatUrl: LIFF },
  transferRequest:       { fromParentName: '範例家長', courseInfo: '1 對 1 / 範例場館', sessionsRemaining: 4, liffUrl: LIFF },
  transferReviewed:      { approved: true, courseInfo: '1 對 1 / 範例場館', note: '範例備註', liffUrl: LIFF },
  mgmTrialTodayReminder: { refereeName: '範例學員', liffUrl: LIFF },
  mgmRewardIssued:       { refereeName: '範例學員', couponDetails: '範例：折價券 500 元', liffUrl: LIFF },
  invoiceIssued:         { parentName: '範例家長', invoiceNumber: 'AB-12345678', invoiceImageUrl: '', invoiceUrl: null,
                           coachName: '範例教練', venueName: '範例場館', courseType: '1 對 1', finalPrice: 6900, liffUrl: LIFF },
  adminPasswordReset:    { employeeName: '範例員工', employeeId: 'E0000', loginUsername: 'sample', defaultPassword: '（範例）', loginUrl: LIFF },
};

(async () => {
  let token;
  try { token = line._getTokenForDiagnostics(VENUE); }
  catch (e) { console.error('取不到場館 ' + VENUE + ' 的 token：' + e.message); process.exit(1); }

  // LINE 的 userId 是「每個官方帳號各自獨立」的 —— 同一個人在不同 OA 有不同的 U... ID。
  // 用錯 channel 的話 19 則會全部回 400「Failed to send messages」，訊息還看不出原因。
  // 先用唯讀的 profile 查詢確認好友關係，不是就直接停，並把正確的 channel 指出來。
  const whoAmI = async (tk) => {
    const r = await axios.get('https://api.line.me/v2/bot/profile/' + UID,
      { headers: { Authorization: 'Bearer ' + tk }, timeout: 10000, validateStatus: () => true });
    return r.status === 200 ? (r.data.displayName || '(無名)') : null;
  };
  const name = await whoAmI(token);
  if (!name) {
    console.error('這個 uid 不是場館 ' + VENUE + ' 官方帳號的好友（LINE 的 userId 每個帳號各自獨立）。');
    let hint = null;
    try {
      const all = JSON.parse(process.env.LINE_MESSAGING_TOKENS || '{}');
      for (const k of Object.keys(all)) {
        if (await whoAmI(all[k])) { hint = k; break; }
      }
    } catch (_) { /* best-effort */ }
    if (hint) console.error('這個 uid 屬於「' + hint + '」，請改用 --venue=' + hint);
    else console.error('已設定的每個官方帳號都查不到這個 uid —— 請先加該帳號好友，或確認 uid 來源。');
    process.exit(1);
  }
  console.log('收件者：' + name + '（' + UID + '）\n');

  const names = Object.keys(line.templates).filter((n) => !ONLY || n === ONLY);
  const missing = names.filter((n) => !SAMPLES[n]);
  if (missing.length) console.warn('（沒有假資料，將略過）：' + missing.join(', '));

  console.log((APPLY ? '### 實際送出' : '### 演練（未送出，加 --apply 才會真的送）') +
    '  →  ' + UID + '  透過場館 ' + VENUE + '\n');

  let ok = 0, fail = 0, skip = 0;
  for (const name of names) {
    if (!SAMPLES[name]) { skip += 1; continue; }
    let sample = SAMPLES[name];
    if (ROLE && Object.prototype.hasOwnProperty.call(sample, 'role')) sample = { ...sample, role: ROLE };
    let messages;
    try { messages = line.templates[name](sample); }
    catch (e) { console.log('  ' + name.padEnd(24) + '模板組裝失敗：' + e.message); fail += 1; continue; }

    if (!APPLY) { console.log('  ' + name.padEnd(24) + '準備好了（' + (messages || []).length + ' 則）'); ok += 1; continue; }

    const t0 = Date.now();
    let status = 'failed', reason = null, http = null;
    try {
      const r = await axios.post('https://api.line.me/v2/bot/message/push',
        { to: UID, messages },
        { headers: { Authorization: 'Bearer ' + token }, timeout: 10000, validateStatus: () => true });
      http = r.status;
      if (r.status >= 200 && r.status < 300) { status = 'sent'; ok += 1; console.log('  ' + name.padEnd(24) + 'OK'); }
      else {
        reason = (() => { try { return JSON.stringify(r.data); } catch (_) { return String(r.data); } })();
        fail += 1; console.log('  ' + name.padEnd(24) + '!! HTTP ' + r.status + '  ' + reason.slice(0, 160));
      }
    } catch (e) { reason = e.message; fail += 1; console.log('  ' + name.padEnd(24) + '!! ' + e.message); }

    try {
      await pool.query(
        `INSERT INTO line_push_log (event, venue_id, recipient_uid, recipient_kind, ref_id, status, reason, http_status, duration_ms)
         VALUES ('template_smoke',$1,$2,'test',$3,$4,$5,$6,$7)`,
        [VENUE, UID, name, status, reason ? String(reason).slice(0, 300) : null, http, Date.now() - t0]);
    } catch (e) { console.warn('    （紀錄寫入失敗：' + e.message + '）'); }

    await new Promise((r) => setTimeout(r, 400));   // 別打太快
  }

  console.log('\n成功 ' + ok + ' / 失敗 ' + fail + ' / 略過 ' + skip);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('例外：' + e.message); process.exit(1); });