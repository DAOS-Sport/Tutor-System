const shown = new Set();
const requests = new Map();

export const tourKey = (role, id) => ['parent', 'coach'].includes(role) && id ? `${role}:${id}` : null;
export const tourSeen = key => !key || shown.has(key);
export const markTourShown = key => { if (key) shown.add(key); };

export function claimAutoTour(key, request) {
  if (!key) return Promise.resolve(false);
  if (!requests.has(key)) requests.set(key, Promise.resolve().then(request).then(r => r?.show === true).catch(() => false));
  return requests.get(key);
}

export function tourSteps(role) {
  const nav = (route, title, text) => ({ route, target: `[data-tour-nav="${route}"]`, title, text });
  const steps = role === 'coach' ? [
    nav('/coach', '首頁：掌握今天的課程', '查看今日課程，從課程卡片進入授課入口。'),
    nav('/coach/orders', '報名記錄：查看學員報名', '查詢學員的報名、付款狀態與課程堂數；付款對帳由櫃台處理。'),
    nav('/coach/schedule', '排課：安排上課時間', '切換週／月查看時段，管理預約時間。請先與家長協調好上課時間。'),
    nav('/coach/history', '授課記錄：留下上課內容', '查詢已上課與簽到紀錄，填寫課程內容及學員表現。'),
    nav('/coach/profile', '個人：維護教練介紹', '查看個人資料與授權場館，編輯家長會看到的教練介紹。'),
  ] : [
    nav('/', '首頁：從這裡開始報名', '選擇課程品項、場館與教練，再依畫面完成報名。'),
    { route: '/', target: '[data-tour-checkin]', title: '上課前，從這裡查看與簽到', text: '開啟課程查看記錄。上課當天完成簽到後，請出示畫面給櫃台確認堂數。' },
    nav('/my-courses', '我的課程：付款與進度都在這裡', '上傳付款資料、查看審核進度與剩餘堂數，也能找到課程的簽到入口。'),
    nav('/profile', '個人：管理家長與學員資料', '查看及管理家長、學員的基本資料，確認報名資料正確。'),
  ];
  return [...steps, {
    route: role === 'coach' ? '/coach/profile' : '/', target: '[data-guide-entry]',
    title: '忘記操作，隨時回來看指南',
    text: `${role === 'coach' ? '個人頁' : '首頁'}的「教學指南」有完整圖文說明，也能按「重看功能引導」再看一次。`,
  }];
}
