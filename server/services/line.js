/**
 * LINE Messaging API 封裝
 * 各場館獨立 Channel Token，依 venue_id 選對應 Token
 * 所有通知使用 LINE Flex Message 格式，套用品牌色系
 */
const axios = require('axios');

const BRAND = {
  primary:  '#15316a',  // 深海藍（主色）
  teal:     '#31aeab',  // 青碧綠
  green:    '#97bf36',  // 草地綠
  amber:    '#e8a020',  // 警示橘黃
  gold:     '#c9a84c',  // 資深教練金色
  white:    '#ffffff',
};

function getToken(venueId) {
  const tokens = JSON.parse(process.env.LINE_MESSAGING_TOKENS || '{}');
  const token = tokens[venueId];
  if (!token) throw new Error(`No LINE token for venue: ${venueId}`);
  return token;
}

async function pushMessage(lineUserId, messages, venueId) {
  const token = getToken(venueId);
  await axios.post('https://api.line.me/v2/bot/message/push', {
    to: lineUserId,
    messages,
  }, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
          ...(note ? [{ type: 'text', text: `主管備註：${note}`, size: 'xs', color: '#666', wrap: true }] : []),
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
function invoiceIssued({ parentName, invoiceNumber, invoiceImageUrl, invoiceUrl, liffUrl }) {
  const bubble = {
    type: 'bubble',
    hero: invoiceImageUrl ? {
      type: 'image',
      url: invoiceImageUrl,
      size: 'full',
      aspectRatio: '20:13',
      aspectMode: 'cover',
    } : undefined,
    header: flexHeader('🧾 對帳通過・發票已開立', BRAND.teal),
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm',
      contents: [
        { type: 'text', text: `親愛的 ${parentName || '家長'} 您好：`, size: 'sm', wrap: true },
        { type: 'text', text: '您的報名款項對帳已通過，發票資訊如下：', size: 'sm', color: '#555555', wrap: true },
        { type: 'separator', margin: 'md' },
        {
          type: 'box', layout: 'horizontal', margin: 'md',
          contents: [
            { type: 'text', text: '發票號碼', size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: invoiceNumber, size: 'sm', weight: 'bold', flex: 3, align: 'end' },
          ],
        },
        ...(invoiceUrl ? [{
          type: 'box', layout: 'horizontal', margin: 'sm',
          contents: [
            { type: 'text', text: '查詢連結', size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: '點此查詢', size: 'sm', color: BRAND.teal, flex: 3, align: 'end',
              action: { type: 'uri', label: '查詢', uri: invoiceUrl } },
          ],
        }] : []),
      ],
    },
    footer: liffUrl ? {
      type: 'box', layout: 'vertical',
      contents: [flexButton('登入查看訂單 →', `${liffUrl}/my-courses`, BRAND.primary)],
    } : undefined,
  };
  if (!bubble.hero) delete bubble.hero;
  if (!bubble.footer) delete bubble.footer;
  return [{ type: 'flex', altText: `對帳通過・發票號碼 ${invoiceNumber}`, contents: bubble }];
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
    evaluationInvite,
    keywordAlert,
    mgmRewardIssued,
    transferRequest,
    transferReviewed,
    mgmTrialTodayReminder,
    invoiceIssued,
  },
};
