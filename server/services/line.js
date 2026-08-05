/**
 * LINE Messaging API 封裝
 * 各場館獨立 Channel Token，依 venue_id 選對應 Token
 * 所有通知使用 LINE Flex Message 格式，套用品牌色系
 */
const axios = require('axios');
const pushGate = require('./pushGate');

const BRAND = {
  primary:  '#15316a',  // 深海藍（主色）
  teal:     '#31aeab',  // 青碧綠
  green:    '#97bf36',  // 草地綠
  amber:    '#e8a020',  // 警示橘黃
  gold:     '#c9a84c',  // 資深教練金色
  white:    '#ffffff',
};

// 場館代號 → 獨立環境變數的別名。
//
// token 有兩種設定方式，都支援：
//   1. LINE_MESSAGING_TOKENS   一個 JSON，key＝venue_id，例如 {"B":"...","K":"..."}
//   2. LINE_MESSAGING_TOKEN_X  一個場館一個變數
// 第 2 種的變數名歷史上用的是館名（NEWPEI / SANCHONG / …）而不是 venue_id，
// 所以這裡留一份對照。新增場館時建議直接用 LINE_MESSAGING_TOKEN_<venue_id>，
// 不必再往這張表加東西。
const VENUE_ENV_ALIAS = {
  B: ['NEWPEI', 'XINBEI'],   // 新北高中
  K: ['SANCHONG'],           // 三重商工
  L: ['SANMIN'],             // 三民高中
  C: ['SONGSHAN'],           // 松山國小
};

// 已警告過的場館（避免 cron 迴圈裡每個收件人都刷一行相同的錯誤，把真正的問題淹掉）。
const _warnedMissingToken = new Set();

function getToken(venueId) {
  // (1) JSON 形式
  let tokens = {};
  try {
    tokens = JSON.parse(process.env.LINE_MESSAGING_TOKENS || '{}');
  } catch (e) {
    throw new Error('LINE_MESSAGING_TOKENS 不是合法 JSON，所有場館推播都會失敗，請檢查 Replit Secrets');
  }
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  let token = clean(tokens[venueId]);

  // (2) 獨立環境變數：先試 venue_id 本身，再試館名別名
  if (!token) {
    const names = [String(venueId), ...(VENUE_ENV_ALIAS[venueId] || [])];
    for (const n of names) {
      token = clean(process.env['LINE_MESSAGING_TOKEN_' + n]);
      if (token) break;
    }
  }

  if (!token) {
    // 每個場館只印一次完整診斷：講清楚「設了哪些、缺哪個、去哪裡補」。
    if (!_warnedMissingToken.has(venueId)) {
      _warnedMissingToken.add(venueId);
      const fromJson = Object.keys(tokens);
      const fromEnv = Object.keys(process.env)
        .filter((k) => k.startsWith('LINE_MESSAGING_TOKEN_'))
        .map((k) => k.replace('LINE_MESSAGING_TOKEN_', ''));
      console.error(
        '[line] 場館 ' + venueId + ' 沒有 Messaging API token，該館所有 LINE 推播都會失敗。'
        + ' LINE_MESSAGING_TOKENS 內的 key：' + (fromJson.length ? fromJson.join(', ') : '（空）')
        + '；獨立變數 LINE_MESSAGING_TOKEN_*：' + (fromEnv.length ? fromEnv.join(', ') : '（無）')
        + '。請設 LINE_MESSAGING_TOKEN_' + venueId + '，或在 LINE_MESSAGING_TOKENS 內加上 "' + venueId + '"。'
      );
    }
    throw new Error('No LINE token for venue: ' + venueId);
  }
  return token;
}

async function pushMessage(lineUserId, messages, venueId, opts = {}) {
  const event = opts.event || 'legacy';
  const meta = {
    event,
    refId: opts.refId || null,
    venueId: venueId || null,
    recipientKind: opts.recipientKind || null,
  };

  const d = await pushGate.decide({ event, uid: lineUserId });
  if (!d.allow) {
    await pushGate.logSkipped({ ...meta, uid: lineUserId, reason: d.reason });
    return { sent: false, reason: d.reason };
  }
  const uid = d.uid;   // 測試模式下會被改寫成指定的 LINE ID，必須用這個而不是原本的

  // 先確定拿得到 token 再佔位。順序反過來的話，缺 token 會留下永遠卡在 sending
  // 的紀錄，而那個組合之後就再也送不出去（被去重的唯一索引擋住）。
  let token;
  try {
    token = getToken(venueId);
  } catch (e) {
    await pushGate.logSkipped({ ...meta, uid, reason: 'NO_TOKEN:' + e.message });
    throw e;
  }

  const id = await pushGate.claim({ ...meta, uid });
  if (!id) {
    await pushGate.logSkipped({ ...meta, uid, reason: 'DUPLICATE' });
    return { sent: false, reason: 'DUPLICATE' };
  }

  if (d.dryRun) {
    await pushGate.finish({ id, status: 'dry_run', reason: d.redirected ? 'REDIRECTED_TO_TEST_UID' : null });
    return { sent: false, reason: 'DRY_RUN' };
  }

  const t0 = Date.now();
  try {
    const r = await axios.post('https://api.line.me/v2/bot/message/push', {
      to: uid,
      messages,
    }, {
      headers: { Authorization: `Bearer ${token}` },
      // 沒有 timeout 的話，LINE 慢回應會把呼叫它的那個 HTTP request 一起拖住。
      timeout: 10000,
      validateStatus: () => true,
    });
    const ms = Date.now() - t0;
    if (r.status >= 200 && r.status < 300) {
      await pushGate.finish({
        id, status: 'sent', httpStatus: r.status, durationMs: ms,
        reason: d.redirected ? 'REDIRECTED_TO_TEST_UID' : null,
      });
      return { sent: true };
    }
    const body = (() => { try { return JSON.stringify(r.data); } catch (_) { return String(r.data); } })();
    await pushGate.finish({ id, status: 'failed', httpStatus: r.status, durationMs: ms, reason: body.slice(0, 300) });
    throw new Error('LINE push failed: HTTP ' + r.status + ' ' + body.slice(0, 200));
  } catch (e) {
    await pushGate.finish({ id, status: 'failed', reason: String(e.message).slice(0, 300), durationMs: Date.now() - t0 });
    throw e;
  }
}

// ── Flex Message 模板 ────────────────────────

function flexHeader(text, color = BRAND.primary) {
  return {
    type: 'box', layout: 'vertical',
    backgroundColor: color,
    paddingAll: '16px',
    contents: [{
      type: 'text', text,
      color: BRAND.white, size: 'md', weight: 'bold',
    }],
  };
}

function flexButton(label, action, color = BRAND.teal) {
  return {
    type: 'button',
    style: 'primary',
    color,
    action: { type: 'uri', label, uri: action },
  };
}

// 報名成功通知
function enrollmentSuccess({ coachName, venueName, courseType, finalPrice, liffUrl }) {
  return [{
    type: 'flex', altText: '課程報名成功！',
    contents: {
      type: 'bubble',
      header: flexHeader('✅ 課程報名成功'),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `教練：${coachName}`, size: 'sm' },
          { type: 'text', text: `場館：${venueName}`, size: 'sm' },
          { type: 'text', text: `組別：1 對 ${courseType}`, size: 'sm' },
          { type: 'text', text: `費用：NT$ ${finalPrice.toLocaleString()}`, size: 'sm' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '請等待主管對帳確認，確認後課程即自動開通。', size: 'xs', color: '#888888', wrap: true },
        ],
      },
    },
  }];
}

// 課程開通通知
function courseActivated({ coachName, venueName, liffUrl }) {
  return [{
    type: 'flex', altText: '課程已開通！請前往選擇上課時間',
    contents: {
      type: 'bubble',
      header: flexHeader('🎉 課程已開通！', BRAND.teal),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `教練：${coachName}`, size: 'sm' },
          { type: 'text', text: `場館：${venueName}`, size: 'sm' },
          { type: 'text', text: '請點擊下方按鈕選擇上課時間', size: 'sm', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [flexButton('選擇上課時間 →', liffUrl, BRAND.teal)],
      },
    },
  }];
}

// 選槽成功（1v1 即時確認）
function slotBooked({ coachName, venueName, scheduledAt, liffUrl }) {
  return [{
    type: 'flex', altText: '課程時段預約成功！',
    contents: {
      type: 'bubble',
      header: flexHeader('📅 課程時段確認！', BRAND.green),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `教練：${coachName}`, size: 'sm' },
          { type: 'text', text: `場館：${venueName}`, size: 'sm' },
          { type: 'text', text: `時間：${scheduledAt}`, size: 'sm', weight: 'bold' },
        ],
      },
    },
  }];
}

// 1vN 同組確認邀請
function groupConfirmInvite({ initiatorName, coachName, scheduledAt, agreeUrl, rejectUrl }) {
  return [{
    type: 'flex', altText: `${initiatorName} 已選取課程時段，請確認`,
    contents: {
      type: 'bubble',
      header: flexHeader('📋 課程時段確認邀請'),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `${initiatorName} 已選取以下時段：`, size: 'sm', wrap: true },
          { type: 'text', text: `教練：${coachName}`, size: 'sm' },
          { type: 'text', text: `時間：${scheduledAt}`, size: 'sm', weight: 'bold' },
          { type: 'text', text: '請於 1 小時內確認，逾時視為同意。', size: 'xs', color: '#888888', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          flexButton('✅ 同意', agreeUrl, BRAND.green),
          flexButton('❌ 不同意', rejectUrl, '#e24b4a'),
        ],
      },
    },
  }];
}

// 上課前提醒
function sessionReminder({ coachName, venueName, scheduledAt, role }) {
  const title = role === 'coach' ? '即將上課提醒（教練）' : '📢 上課提醒';
  return [{
    type: 'flex', altText: `距離上課還有 1 小時`,
    contents: {
      type: 'bubble',
      header: flexHeader(title, BRAND.amber),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `教練：${coachName}`, size: 'sm' },
          { type: 'text', text: `場館：${venueName}`, size: 'sm' },
          { type: 'text', text: `時間：${scheduledAt}`, size: 'sm', weight: 'bold' },
          { type: 'text', text: '距上課還有 1 小時，請提前準備。', size: 'xs', color: '#888888', wrap: true },
        ],
      },
    },
  }];
}

// 自助取消通知（教練端）
function selfCancelToCoach({ studentName, scheduledAt, cancelType }) {
  const isNormal = cancelType === 'normal';
  return [{
    type: 'flex', altText: `${studentName} 已取消課程`,
    contents: {
      type: 'bubble',
      header: flexHeader('課程取消通知', isNormal ? BRAND.amber : '#e24b4a'),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `學員：${studentName}`, size: 'sm' },
          { type: 'text', text: `原上課時間：${scheduledAt}`, size: 'sm' },
          { type: 'text', text: isNormal ? '正常取消（堂數已歸還，時段已釋出）' : '逾時取消（堂數已扣除，時段已釋出）', size: 'xs', wrap: true, color: isNormal ? '#3B6D11' : '#A32D2D' },
        ],
      },
    },
  }];
}

// 堂數快到期提醒
function expiryReminder({ coachName, remainingSessions, expiresAt, liffUrl }) {
  return [{
    type: 'flex', altText: '課程堂數即將到期',
    contents: {
      type: 'bubble',
      header: flexHeader('⚠️ 課程即將到期', BRAND.amber),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `教練：${coachName}`, size: 'sm' },
          { type: 'text', text: `剩餘堂數：${remainingSessions} 堂`, size: 'sm', weight: 'bold' },
          { type: 'text', text: `到期日：${expiresAt}`, size: 'sm' },
          { type: 'text', text: '請盡快安排上課，以免堂數到期失效。', size: 'xs', color: '#888888', wrap: true },
        ],
      },
    },
  }];
}

// 課前規劃發布通知
function coursePlanPublished({ coachName, liffUrl }) {
  return [{
    type: 'flex', altText: '教練已為您建立課前規劃',
    contents: {
      type: 'bubble',
      header: flexHeader('📝 課前規劃已發布', BRAND.gold),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `${coachName} 教練已建立本期課程學習規劃，請查閱。`, size: 'sm', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [flexButton('查看課前規劃 →', liffUrl, BRAND.gold)],
      },
    },
  }];
}

// 授課記錄發布通知
function sessionRecordPublished({ coachName, sessionDate, liffUrl }) {
  return [{
    type: 'flex', altText: '教練已完成本堂授課記錄',
    contents: {
      type: 'bubble',
      header: flexHeader('📖 授課記錄已完成', BRAND.teal),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `${coachName} 教練已完成 ${sessionDate} 的授課記錄。`, size: 'sm', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [flexButton('查看授課記錄 →', liffUrl, BRAND.teal)],
      },
    },
  }];
}

// 團購：有新成員加入 → 通知團主前往查看並送審
function groupMemberJoined({ memberName, total, min, max, reachedMin, liffUrl }) {
  return [{
    type: 'flex', altText: '有新成員加入您的團購',
    contents: {
      type: 'bubble',
      header: flexHeader('👨‍👩‍👧 團購有新成員加入', BRAND.teal),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `${memberName || '一位家長'} 已加入您發起的團購。`, size: 'sm', wrap: true },
          { type: 'text', text: `目前共 ${total} 人（開團需 ${min}–${max} 人）`, size: 'xs', color: '#888888', wrap: true },
          { type: 'text', text: reachedMin ? '已達開團人數，可送出審核！' : '達到下限後即可送出審核。',
            size: 'xs', color: reachedMin ? BRAND.green : '#888888', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [flexButton('查看團購並送審 →', liffUrl, BRAND.teal)],
      },
    },
  }];
}

// 退回補件（U14）：團購或一般報名被櫃檯退回，但「單沒有消失」，補齊即可續作。
// 與「取消／退回終止」不同，文案刻意強調可以繼續完成，避免家長誤以為要重新報名。
function returnedForFix({ title, reason, hint, liffUrl }) {
  return [{
    type: 'flex', altText: `${title}：請補件後重新送出`,
    contents: {
      type: 'bubble',
      header: flexHeader('📝 需要補件', BRAND.amber),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: title, size: 'sm', weight: 'bold', wrap: true },
          { type: 'text', text: `退回原因：${reason}`, size: 'sm', wrap: true },
          ...(hint ? [{ type: 'text', text: hint, size: 'xs', color: '#888888', wrap: true }] : []),
          { type: 'text', text: '這筆單並未取消，補齊資料後即可繼續完成。',
            size: 'xs', color: BRAND.green, wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [flexButton('前往補件 →', liffUrl, BRAND.amber)],
      },
    },
  }];
}

// 期末評鑑邀請
function evaluationInvite({ coachName, liffUrl }) {
  return [{
    type: 'flex', altText: '請為本期課程進行評鑑',
    contents: {
      type: 'bubble',
      header: flexHeader('⭐ 課程期末評鑑', BRAND.gold),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `與 ${coachName} 教練的課程本期圓滿結束！`, size: 'sm', wrap: true },
          { type: 'text', text: '請花 1 分鐘填寫評鑑，您的回饋對教練很重要。', size: 'xs', color: '#888888', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [flexButton('填寫期末評鑑 →', liffUrl, BRAND.gold)],
      },
    },
  }];
}

// 關鍵字警示（主管）
function keywordAlert({ coachName, parentName, keyword, chatUrl }) {
  return [{
    type: 'flex', altText: '聊天室關鍵字警示',
    contents: {
      type: 'bubble',
      header: flexHeader('🚨 聊天室警示', '#e24b4a'),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `教練：${coachName}`, size: 'sm' },
          { type: 'text', text: `家長：${parentName}`, size: 'sm' },
          { type: 'text', text: `觸發關鍵字：「${keyword}」`, size: 'sm', color: '#e24b4a', weight: 'bold' },
          { type: 'text', text: '請進入後台查閱對話內容。', size: 'xs', color: '#888888', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [flexButton('查閱對話 →', chatUrl, '#e24b4a')],
      },
    },
  }];
}

// 課程轉讓送出（轉入方）
function transferRequest({ fromParentName, courseInfo, sessionsRemaining, liffUrl }) {
  return [{
    type: 'flex', altText: '收到課程轉讓邀請',
    contents: {
      type: 'bubble',
      header: flexHeader('🎁 收到課程轉讓', BRAND.teal),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `${fromParentName} 想將以下課程轉讓給您：`, size: 'sm', wrap: true },
          { type: 'text', text: courseInfo, size: 'sm', weight: 'bold' },
          { type: 'text', text: `剩餘堂數：${sessionsRemaining} 堂`, size: 'sm' },
          { type: 'text', text: '請等待主管審核，審核通過後課程將自動開通。', size: 'xs', color: '#888888', wrap: true },
        ],
      },
    },
  }];
}

// 課程轉讓審核結果（雙方收到）
function transferReviewed({ approved, courseInfo, note, liffUrl }) {
  const color = approved ? BRAND.green : '#e24b4a';
  const title = approved ? '✅ 轉讓已通過' : '❌ 轉讓未通過';
  return [{
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      header: flexHeader(title, color),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: courseInfo, size: 'sm', weight: 'bold', wrap: true },
          ...(note ? [{ type: 'text', text: `主管備註：${note}`, size: 'xs', color: '#666666', wrap: true }] : []),
          { type: 'text',
            text: approved ? '課程已轉至新學員，可前往「我的課程」查看。' : '若有疑問請聯繫場館。',
            size: 'xs', color: '#888888', wrap: true },
        ],
      },
      ...(liffUrl ? { footer: { type: 'box', layout: 'vertical', contents: [flexButton('我的課程', liffUrl, color)] } } : {}),
    },
  }];
}

// MGM 體驗課當天 9 折提醒（推給推薦方）
function mgmTrialTodayReminder({ refereeName, liffUrl }) {
  return [{
    type: 'flex', altText: '您推薦的好友今天上體驗課',
    contents: {
      type: 'bubble',
      header: flexHeader('🎯 體驗課今日進行', BRAND.amber),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `您推薦的 ${refereeName} 今天上體驗課！`, size: 'sm', wrap: true },
          { type: 'text', text: '簽到完成後，您將獲得正期 9 折券。', size: 'sm', weight: 'bold' },
        ],
      },
      ...(liffUrl ? { footer: { type: 'box', layout: 'vertical', contents: [flexButton('查看推薦進度', liffUrl, BRAND.amber)] } } : {}),
    },
  }];
}

// MGM 推薦方獎勵通知
function mgmRewardIssued({ refereeName, couponDetails, liffUrl }) {
  return [{
    type: 'flex', altText: '您的推薦獎勵已發放！',
    contents: {
      type: 'bubble',
      header: flexHeader('🎁 推薦獎勵發放！', BRAND.green),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `您推薦的 ${refereeName} 已完成體驗課！`, size: 'sm', wrap: true },
          { type: 'text', text: `獎勵：${couponDetails}`, size: 'sm', weight: 'bold' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [flexButton('查看我的優惠券 →', liffUrl, BRAND.green)],
      },
    },
  }];
}

// Task #39：對帳通過發票通知（推給家長）
// params: parentName, invoiceNumber, invoiceImageUrl, invoiceUrl,
//         coachName, venueName, courseType, finalPrice, liffUrl
function invoiceIssued({ parentName, invoiceNumber, invoiceImageUrl, invoiceUrl,
                          coachName, venueName, courseType, finalPrice, liffUrl }) {
  const footerButtons = [];
  if (invoiceUrl) {
    footerButtons.push(flexButton('查看電子發票 →', invoiceUrl, BRAND.teal));
  }
  if (liffUrl) {
    footerButtons.push(flexButton('登入查看訂單 →', `${liffUrl}/my-courses`, BRAND.primary));
  }

  const bodyContents = [
    { type: 'text', text: `親愛的 ${parentName || '家長'} 您好：`, size: 'sm', wrap: true },
    { type: 'text', text: '您的報名款項對帳已通過，課程已開通，發票資訊如下：', size: 'sm', color: '#555555', wrap: true },
    { type: 'separator', margin: 'md' },
  ];

  if (coachName) {
    bodyContents.push({
      type: 'box', layout: 'horizontal', margin: 'md',
      contents: [
        { type: 'text', text: '教練', size: 'sm', color: '#888888', flex: 2 },
        { type: 'text', text: coachName, size: 'sm', flex: 3, align: 'end' },
      ],
    });
  }
  if (venueName) {
    bodyContents.push({
      type: 'box', layout: 'horizontal', margin: 'sm',
      contents: [
        { type: 'text', text: '場館', size: 'sm', color: '#888888', flex: 2 },
        { type: 'text', text: venueName, size: 'sm', flex: 3, align: 'end' },
      ],
    });
  }
  if (courseType) {
    bodyContents.push({
      type: 'box', layout: 'horizontal', margin: 'sm',
      contents: [
        { type: 'text', text: '組別', size: 'sm', color: '#888888', flex: 2 },
        { type: 'text', text: courseType, size: 'sm', flex: 3, align: 'end' },
      ],
    });
  }
  if (finalPrice != null) {
    bodyContents.push({
      type: 'box', layout: 'horizontal', margin: 'sm',
      contents: [
        { type: 'text', text: '金額', size: 'sm', color: '#888888', flex: 2 },
        { type: 'text', text: `NT$ ${Number(finalPrice).toLocaleString()}`, size: 'sm', weight: 'bold', flex: 3, align: 'end' },
      ],
    });
  }

  bodyContents.push({ type: 'separator', margin: 'md' });
  // format: AB12345678 → AB-12345678
  const displayInvoice = invoiceNumber && invoiceNumber.length >= 3
    ? `${invoiceNumber.slice(0, 2)}-${invoiceNumber.slice(2)}`
    : invoiceNumber;
  bodyContents.push({
    type: 'box', layout: 'horizontal', margin: 'md',
    contents: [
      { type: 'text', text: '發票號碼', size: 'sm', color: '#888888', flex: 2 },
      { type: 'text', text: displayInvoice, size: 'sm', weight: 'bold', flex: 3, align: 'end' },
    ],
  });

  const bubble = {
    type: 'bubble',
    ...(invoiceImageUrl ? {
      hero: {
        type: 'image',
        url: invoiceImageUrl,
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover',
      },
    } : {}),
    header: flexHeader('🧾 對帳通過・發票已開立', BRAND.teal),
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents },
    ...(footerButtons.length ? {
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footerButtons },
    } : {}),
  };

  return [{ type: 'flex', altText: `對帳通過・發票號碼 ${invoiceNumber}`, contents: bubble }];
}

// Task #82：admin 重設密碼通知（推給該員工）
function adminPasswordReset({ employeeName, employeeId, loginUsername, defaultPassword, loginUrl }) {
  const username = loginUsername || defaultPassword || employeeId;
  const password = defaultPassword || employeeId;
  return [{
    type: 'flex', altText: '您的後台密碼已被重設為手機號碼',
    contents: {
      type: 'bubble',
      header: flexHeader('🔑 後台密碼已重設', BRAND.amber),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `${employeeName || employeeId} 您好：`, size: 'sm', wrap: true },
          { type: 'text', text: '系統管理員已重設您的後台登入密碼。', size: 'sm', wrap: true },
          { type: 'separator', margin: 'md' },
          { type: 'box', layout: 'horizontal', margin: 'md', contents: [
            { type: 'text', text: '登入帳號', size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: username, size: 'sm', weight: 'bold', flex: 3, align: 'end' },
          ] },
          { type: 'box', layout: 'horizontal', margin: 'md', contents: [
            { type: 'text', text: '新密碼', size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: password, size: 'sm', weight: 'bold', flex: 3, align: 'end' },
          ] },
          { type: 'text', text: '（即為您的手機號碼）', size: 'xs', color: '#888888', align: 'end' },
          { type: 'text', text: '為了帳號安全，請點下方按鈕登入後立即修改密碼。', size: 'xs', color: '#A32D2D', wrap: true, margin: 'md' },
        ],
      },
      ...(loginUrl ? {
        footer: { type: 'box', layout: 'vertical', contents: [flexButton('登入後台 →', loginUrl, BRAND.amber)] },
      } : {}),
    },
  }];
}

// 高階 helper：推 keywordAlert Flex 給單一主管 line_uid（呼叫端不必組 message）
// venueId 必填：用於挑該場館的 LINE channel token（pushMessage 第三參數）
async function pushKeywordAlert(lineUserId, { venueId, keyword, chatRoomId, snippet }) {
  if (!venueId) throw new Error('pushKeywordAlert: venueId required');
  const adminUrl = (process.env.ADMIN_URL || '').replace(/\/$/, '');
  const chatUrl = adminUrl ? `${adminUrl}/admin/alerts` : `https://example.com/admin/alerts`;
  const messages = keywordAlert({
    coachName: '—',
    parentName: snippet ? `「${snippet}…」` : '—',
    keyword,
    chatUrl,
  });
  return pushMessage(lineUserId, messages, venueId);
}

module.exports = {
  pushMessage,
  pushKeywordAlert,
  templates: {
    enrollmentSuccess,
    courseActivated,
    slotBooked,
    groupConfirmInvite,
    sessionReminder,
    selfCancelToCoach,
    expiryReminder,
    coursePlanPublished,
    sessionRecordPublished,
    groupMemberJoined,
    returnedForFix,
    evaluationInvite,
    keywordAlert,
    mgmRewardIssued,
    transferRequest,
    transferReviewed,
    mgmTrialTodayReminder,
    invoiceIssued,
    adminPasswordReset,
  },
};

// 供維運診斷用：只回「拿不拿得到」，呼叫端不得印出回傳值。
module.exports._getTokenForDiagnostics = getToken;
