const step = (title, text, target = 'main h1, main h3', extra = {}) => ({ title, text, target, ...extra });
const live = (title, text, target, page, view = '', targetText = '') =>
  step(title, text, target, { page, view, targetText });

const account = () => step(
  '家長帳號',
  '先確認目前登入的家長身分。綁定問題請洽櫃檯，避免建立重複帳號。',
  'main',
  { targetText: '家長帳號' },
);
const edit = () => step(
  '編輯資料入口',
  '從這裡展開家長或學員資料，新增孩子、編輯聯絡方式並核對必填欄位。',
  'button',
  { targetText: '編輯資料' },
);

const venueAndCoach = [
  live('選擇新北高中', '在原場館頁確認啟用中的新北高中；教學無法取得此場館時會停止，不會替換成別的場館。', '[data-guide-venue]', 'venue'),
  live('選擇待分配教練', '在原教練清單確認待分配教練。教學不會代按付款說明或任何「我同意」。', '[data-guide-placeholder]', 'coaches'),
];

const enrollment = [
  live('購買期數或堂數', '一般課程選期數；試上依原頁選堂數。堂數與金額沿用目前品項及既有計價，不由教學另算。', '[data-guide-period]', 'enroll'),
  live('選擇學員', 'DEMO 學員只存在這次引導的記憶體；一般一對N仍須符合原頁人數限制。', '[data-guide-students]', 'enroll'),
  live('核對費用與優惠', '核對品項、係數、堂數、期數、優惠與應繳總額；計價仍走既有公式，教學不建立訂單。', '[data-guide-price]', 'enroll'),
];

const payment = [
  live('匯款帳戶及金額', '付款頁以 DEMO 金額與 DEMO 收款帳號示範欄位位置，不代表實際報價，也不可拿來匯款。', '[data-guide-bank]', 'checkout'),
  live('轉帳卡片末五碼', '正式付款填轉出帳號末五碼；DEMO 字樣不是實際末五碼，也不會送出。', '#checkout-last5', 'checkout'),
  live('上傳轉帳證明', '原欄位可選擇或拍攝匯款證明；本教學不讀檔、不建立預覽、不上傳。', '[data-guide-proof]', 'checkout'),
  live('發票擇一', '不填、載具與統一編號擇一；選另一類型會清掉原類型的暫存值。', '[aria-label="發票資訊選擇"]', 'checkout', 'none'),
  live('電子發票載具條碼', '原表單會在選載具後展開此欄。DEMO 是明示無效示例，不代表可用載具。', '#checkout-carrier', 'checkout', 'carrier'),
  live('統一編號', '原表單要求 8 碼及檢查碼有效；DEMO 是明示無效示例，不代表實際統編。', '#checkout-tax-id', 'checkout', 'tax_id'),
  live('備註', '可補對帳說明；不要填帳戶密碼、驗證碼或其他機密。', '#checkout-note', 'checkout', 'none'),
  live('確認付款資料', '核對末五碼、證明與發票類型後才自行送出；本教學不呼叫上傳或付款 API。', '[data-guide-payment-submit]', 'checkout', 'none'),
];

export const parentTopicPlans = {
  'parent-login': { start: '/profile', steps: [account(), edit()] },

  'parent-enroll': {
    start: '/venue?courseType=1',
    steps: [
      ...venueAndCoach,
      ...enrollment,
      live('建立付款單前再次確認', '正式按鈕會建立付款單；教學直接前往原付款頁的記憶體 DEMO，不送出報名。', 'button', 'enroll', '', '下一步：填寫轉帳資料'),
      ...payment,
    ],
  },

  'parent-trial': {
    start: '/trial',
    steps: [
      live('選擇啟用中的試上品項', '原頁只列啟用且開放試上的品項；試上是堂數與現場付款，價格以目前品項為準。', '[data-guide-trial-item]', 'trial'),
      ...venueAndCoach,
      ...enrollment,
      live('查看試上課程', '試上訂單開通或完成後，可在我的課程查看原課程卡與狀態。', '[data-guide-course-card]', 'courses', 'all'),
      live('續報一般課程', '符合原條件的試上卡會顯示續報一般課程；續報仍建立新的普通課程訂單。', 'button', 'courses', 'all', '續報一般課程'),
    ],
  },

  'parent-group': {
    start: '/venue?courseType=2',
    steps: [
      ...venueAndCoach,
      live('發起團購入口', '一對二以上可從原報名頁發起團購；一對一不提供。', 'button', 'enroll', '', '發起團購'),
      live('團主填自己的學員', '使用原團購表單填自己的學員。教學從第一次 mount 就關閉草稿讀寫，只保留記憶體 DEMO。', '[data-guide-group-fields]', 'groupNew'),
      live('期數、折價券與備註', '選期數並核對選填折價券與備註；數量限制仍沿用原表單。', '[data-guide-group-options]', 'groupNew'),
      live('建立團購', '正式建立後才取得邀請連結；本教學不建立團購、不清草稿。', '[data-guide-group-create]', 'groupNew'),
      live('分享團購邀請', '原團購狀態頁可分享邀請；教學不呼叫分享、不產生真 token。', '[data-guide-group-share]', 'groupStatus'),
      live('其他家庭加入', '受邀家長在原加入頁填自己的學員；不能由團主代填其他家庭。', '[data-guide-group-join]', 'groupJoin'),
      live('各家庭付款資料', '每個家庭各自填證明、末五碼與發票資料，不互相覆寫。', '[data-guide-group-proof]', 'groupStatus'),
      live('團報發票擇一', '各家庭分別選不填、載具或統編，不能同時填兩種。', '[data-guide-group-invoice]', 'groupStatus'),
      live('團報載具', '在原團報付款區填自己的有效載具；DEMO 不會保存。', '[data-guide-group-carrier]', 'groupStatus', 'carrier'),
      live('團報統一編號', '在原團報付款區填 8 碼並通過檢查碼；DEMO 不會保存。', '[data-guide-group-tax-id]', 'groupStatus', 'tax_id'),
      live('核對名單與送審條件', '人數與各家庭資料備齊後，依原頁目前顯示的條件與送審按鈕操作，再等待櫃檯審核；教學不送審。', '[data-guide-group-submit]', 'groupStatus', 'review'),
    ],
  },

  'parent-profile': {
    start: '/profile',
    steps: [
      live('展開編輯資料', '這是原個人頁的編輯資料區，接著查看家長與學員欄位。', 'button', 'profile', 'overview', '編輯資料'),
      live('家長基本資料', '姓名、館別、性別及 Email 需完整；手機唯讀，異動請洽櫃檯。', '[data-guide-parent-form]', 'profile', 'parent'),
      live('家長選填欄位', '住家電話、LINE ID、地址選填；登入 UID 與 LINE ID 是不同欄位。', 'label', 'profile', 'parent', '住家地址'),
      live('儲存家長資料', 'DEMO 欄位只在教學記憶體中；按下一步即可繼續，不必真的儲存。', 'button', 'profile', 'parent', '儲存家長資料'),
      live('學員清單與編輯', '從既有學員旁編輯，避免重複新增同一位孩子。', '[data-guide-student-list]', 'profile', 'student'),
      live('新增或編輯學員', '姓名、身分證字號、出生年月日必填；生日不可在未來。DEMO 身分證明示為非真實值。', '[data-guide-student-form]', 'profile', 'student'),
      live('儲存或取消編輯', '停用、移除或轉出請洽櫃檯；教學不呼叫新增或儲存 API。', '[data-guide-student-actions]', 'profile', 'student'),
    ],
  },

  'parent-family': {
    start: '/profile',
    steps: [
      live('我的家庭', '這是原個人頁的家庭區；家庭、邀請、申請皆為記憶體 DEMO。', '#family-card', 'profile', 'family'),
      live('邀請家人加入', '正式操作會建立邀請連結，由對方登入接受；教學不發 POST、不分享。', 'button', 'profile', 'family', '邀請家人加入'),
      live('申請加入家人的家庭', '展開原申請表，核對對方家長與孩子，需對方同意才加入。', '[data-guide-family-apply]', 'profile', 'apply'),
      live('孩子的名字', '填對方已登記的孩子姓名；DEMO 只存在本頁記憶體。', '[data-guide-family-child]', 'profile', 'apply'),
      live('對方家長的手機', '正式操作逐碼核對手機；DEMO 不是真實手機，也不做身分查找。', '[data-guide-family-phone]', 'profile', 'apply'),
      live('關係與備註', '選您與孩子的關係，可補接送等說明。', '[data-guide-family-relation]', 'profile', 'apply'),
      live('送出申請與共享範圍', '對方同意且成員有效後才可依權限使用共享學員、課程與訂單；教學不送出。', '[data-guide-family-submit]', 'profile', 'apply'),
    ],
  },

  'parent-payment': { start: '/checkout/DEMO-CHECKOUT', steps: payment },

  'parent-courses': {
    start: '/my-courses',
    steps: [
      live('全部、進行中與待審核', '以原分頁篩選課程與訂單；DEMO 課程只存在本頁記憶體。', '[data-guide-course-tabs]', 'courses', 'all'),
      live('訂單與課程卡', '原課程卡顯示學員、場館、教練及目前生命週期。', '[data-guide-course-card]', 'courses', 'all'),
      live('已購、已用與剩餘堂數', '堂數顯示沿用原 CourseCard；DEMO 堂數依目前品項每期堂數建構，不代表真人餘額。', '[data-guide-course-card]', 'courses', 'active'),
      live('可用操作與限制', '按鈕依付款、開通、預約制或自助簽到狀態開放；教學不取消、不簽到。', '[data-guide-course-card] button', 'courses', 'active'),
    ],
  },

  'parent-booking': {
    start: '/book-slot/DEMO-PERIOD',
    steps: [
      live('尚可預約堂數', '原資訊卡顯示課程、教練、場館與尚可預約堂數；DEMO 不是真課程期。', '[data-guide-booking-info]', 'booking'),
      live('選擇日期', '原日期列顯示台北今日起往後 30 天內有開放時段的日期。', '[data-guide-booking-dates]', 'booking'),
      live('早、午、晚時段', '原 SlotPicker 依開始時間分成早上、下午與晚上。', '[data-guide-booking-slots]', 'booking'),
      live('單選一個時段', '一次只選一個時段，改選會覆蓋；DEMO 選擇只改 React 記憶體。', '[data-guide-booking-slots] button', 'booking', 'selected'),
      live('確認日期與時間', '核對後才自行送出。教學不開確認送出、不呼叫預約 API。', '[data-guide-booking-submit]', 'booking', 'submit'),
    ],
  },
};

for (const plan of Object.values(parentTopicPlans)) {
  plan.steps.push(step(
    '忘記操作，隨時回來看指南',
    '按完成回指南，隨時選主題重看；跳過會回首頁。',
    '[data-guide-entry]',
    { route: '/guide' },
  ));
}

export function parentTopicPlan(id) {
  return Object.hasOwn(parentTopicPlans, id) ? parentTopicPlans[id] : null;
}
