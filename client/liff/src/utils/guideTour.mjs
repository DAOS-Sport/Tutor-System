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
    nav('/coach/history', '授課記錄：留下上課內容', '查詢已上課與簽到紀錄，填寫課程內容及學員表現。'),
    nav('/coach/profile', '個人：維護教練介紹', '查看個人資料與授權場館，編輯家長會看到的教練介紹。'),
  ] : [
    nav('/', '首頁：從這裡開始報名', '選擇課程品項、場館與教練，再依畫面完成報名。'),
    nav('/', '團報：一個家庭算一戶', '選好課程後可發起團報，或從家人朋友傳來的連結加入。每個家庭各自選學員與填付款資料；送審後名單鎖定，不能再加人。'),
    { route: '/', target: '[data-tour-checkin]', title: '上課前，從這裡查看與簽到', text: '開啟課程查看記錄。上課當天完成簽到後，請出示畫面給櫃台確認堂數。' },
    nav('/my-courses', '我的課程：付款與進度都在這裡', '上傳付款資料、查看審核進度與剩餘堂數，也能找到課程的簽到入口。'),
    nav('/profile', '個人：建立、編輯資料與邀請家人', '在「編輯資料」新增或修改家長與學員資料；在「我的家庭」邀請家人。學員停用、移除、轉出或家庭擁有者轉移，請洽櫃台。'),
  ];
  if (role === 'coach') return steps;
  return [...steps, {
    route: role === 'coach' ? '/coach/profile' : '/', target: '[data-guide-entry]',
    title: '忘記操作，隨時回來看指南',
    text: `${role === 'coach' ? '個人頁' : '首頁'}的「教學指南」可選主題重新開始，也能按「重看功能引導」再看一次。`,
  }];
}
