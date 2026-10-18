const lesson = (id, title, entry, steps, tips, sources) => ({ id, title, entry, steps, tips, sources });
export const guideCatalog = {
  parent: [
    lesson('parent-login', '登入、綁定與首頁入口', '家長登入 → 首頁', ['從家長入口使用自己的 LINE 登入。', '依畫面完成手機綁定或註冊，核對家長與學員資料。', '登入後使用首頁、我的課程、個人與教學指南。'], ['聊天分頁目前顯示敬請期待，不是可用的聯絡管道。', '綁定衝突請洽櫃檯，不要另建重複帳號。'], ['LoginPage', 'LineBindPage', 'RegisterPage', '../components/BottomNav']),
    lesson('parent-enroll', '一般課程報名', '首頁 → 場館 → 教練 → 報名', ['選擇開放的場館、教練與課程組別。', '填寫資料並選滿不同學員，核對系統試算金額。', '送出後到「我的課程」查看報名與付款狀態。'], ['一對二／三／四需分別選滿 2／3／4 位不同學員，不能重複充數。', '優惠資格與金額以送出時系統核算為準。'], ['HomePage', 'VenueSelectPage', 'CoachListPage', 'EnrollmentPage', 'EnrollmentSuccessPage', 'EnrollStatusPage']),
    lesson('parent-trial', '體驗課與續報', '首頁 → 試上課程；我的課程 → 續報一般課程', ['選試上品項、場館、教練及學員，再送出報名。', '依付款頁指示提交資料。', '已開通或已完成試上卡若顯示「續報一般課程」，點選後重新核對正式課程資料與費用。'], ['續報建立新報名，不是自動扣款或延長原課程。', '一般課程續課請重新報名；「續報一般課程」快捷入口屬於試上卡。'], ['TrialSelectPage', 'MyCoursesPage']),
    lesson('parent-group', '發起、加入與送審團報', '首頁選課 → 發起團購；團購邀請連結', ['發起人選課程與自家學員，建立團報並分享邀請連結。', '其他家庭從連結加入，各自選學員、填付款資料。', '在團購狀態核對名單；全團付款資料備齊後依頁面操作送審。'], ['同一家庭在同一團只算一戶；送審後名單鎖定。', '不要把其他家庭的孩子直接建立在自己名下。'], ['GroupCreatePage', 'GroupJoinPage', 'GroupStatusPage']),
    lesson('parent-profile', '建立與編輯家長、學員資料', '個人 → 編輯資料', ['展開家長資料，核對聯絡方式並保存。', '展開學員資料，新增或編輯學員，填妥必填資料。', '保存後回報名頁選擇該學員。'], ['不能修改時請洽櫃檯，不要另建重複學員。', '學員停用、移除或轉出需由櫃檯協助。'], ['ProfilePage']),
    lesson('parent-family', '家庭共享與加入家人', '個人 → 我的家庭；家庭邀請連結', ['確認家庭成員，依頁面邀請或申請加入。', '家人用自己的家長帳號登入後加入。', '回「我的課程」及報名學員清單確認共用資料。'], ['有效家庭成員可共用學員報課與查看課程；停用狀態請洽櫃檯。', '家庭擁有者轉移與成員開關由櫃檯處理；家庭邀請與團報邀請用途不同。'], ['ProfilePage', 'FamilyJoinPage', '../components/FamilyCard']),
    lesson('parent-payment', '匯款資料與載具／統編', '我的課程 → 付款資訊；團購狀態', ['核對訂單金額與匯款資訊。', '填末 5 碼、上傳匯款證明；發票選不填、載具或統編其中一項。', '確認後提交，再查看待對帳或審核狀態。'], ['載具與統編不能同時填；統編格式檢核不代表營業登記查核。', '已送出資訊若鎖定請洽櫃檯；待對帳不等於尚未匯款。'], ['CheckoutPage', 'GroupStatusPage', 'EnrollStatusPage']),
    lesson('parent-courses', '查看訂單、課程與剩餘堂數', '我的課程 → 課程詳情', ['依狀態找到訂單或課程。', '查看學員、場館、付款狀態及課期。', '開啟詳情，使用當下可用的付款、歷程或預約操作。'], ['課程開通處理中時，部分功能需待正式課期建立。'], ['MyCoursesPage', 'CourseDetailPage']),
    lesson('parent-booking', '選擇可用時段', '課程詳情 → 選可用時段', ['從已開通課程進入「選可用時段」。', '選頁面提供的日期、時段並確認預約。', '回上課記錄核對；取消需求依該筆預約提供的操作處理。'], ['自助簽到制不必先預約；沒有槽位不等於不能上課。', '聯絡功能不可用時請洽櫃檯。'], ['SlotBookingPage', 'CourseDetailPage']),
    lesson('parent-checkin', '上課記錄與家長簽到', '首頁 → 上課記錄', ['找到正確學員及課程，查看已簽／未簽。', '依課程模式開啟簽到，核對提示後確認。', '檢查簽到狀態及剩餘堂數；夥伴已代簽時不要重複操作。'], ['簽到會使用堂數，錯誤請洽櫃檯更正。', '自助簽到整組一起簽，同一課程每日限一次；教練不代簽。'], ['MyLessonsPage', '../components/SelfCheckinModal']),
    lesson('parent-history', '學習歷程與期末評鑑', '課程詳情 → 學習歷程／期末評鑑', ['開啟學習歷程，查看已發佈授課內容。', '已完成課程若顯示評鑑，填寫評分與意見。', '確認後送出，查看頁面回應。'], ['教練草稿不等於家長可見記錄。'], ['LearningHistoryPage', 'EvaluationFormPage']),
    lesson('parent-transfer', '申請課程轉讓', '課程詳情 → 課程轉讓', ['選要轉出的課程及學員。', '填轉入方手機、學員姓名及原因，核對後送出。', '在「我的申請記錄」查看結果。'], ['需主管審核，送出不代表已完成轉讓。'], ['TransferRequestPage']),
    lesson('parent-referral', '推薦好友與查詢推薦記錄', '邀請好友', ['選推薦教練，產生連結。', '核對後複製或使用 LINE 分享。', '在「我的推薦記錄」查看進度。'], ['優惠以當時活動與核定結果為準；分享不等於獎勵已發放。'], ['ReferralPage']),
  ],
  coach: [
    lesson('coach-login', '教練登入與功能入口', '教練專屬登入 → 今日', ['由教練入口使用 LINE 登入。', '確認身分，再使用今日、報名、排課、授課記錄與個人頁。', '要切家長身分時使用家長登入入口。'], ['教練聊天室目前停用，舊網址返回今日。', '不能登入請洽櫃檯核對綁定，不要借用帳號。'], ['CoachPortalLoginPage', '../App']),
    lesson('coach-today', '今日課程、優惠與到期提醒', '今日', ['查看今日課程及簽到，點課程卡開啟授課入口。', '展開即將到期通知，查看對應報名。', '查看進行中的優惠；訂單問題請聯絡櫃檯。'], ['到期提醒依台北日期往後 3 個曆月，月底取當月最後一天。', '載入失敗不代表沒有到期課程。'], ['CoachTodayPage']),
    lesson('coach-orders', '查詢報名記錄', '報名記錄', ['依全部或狀態標籤篩選。', '查看學員、期別、狀態及付款資訊。', '由到期提醒進入時，找到標示的報名。'], ['同一期同班的兄弟姊妹算一筆，下一期是另一筆。', '待對帳由櫃檯處理，不代表家長未匯款。'], ['CoachOrdersPage']),
    lesson('coach-schedule', '週／月排課與新增槽位', '排課總表', ['切換週／月視圖，按場館查看時段。', '點「新增槽位」，填日期、時間及開放場館並確認。', '多筆用「批量新增」，檢查成功與失敗結果。'], ['沒有開放場館時不能新增。', '自助簽到課程不必先排槽位；新增時段才提供預約。'], ['CoachScheduleWeekPage', '../components/coach/AddSlotModal', '../components/coach/BatchAddSlotModal', '../components/coach/BatchResultModal']),
    lesson('coach-slot', '封鎖、解封與檢視時段', '排課總表 → 槽位', ['點可用槽位，依需要封鎖或刪除。', '點已封鎖槽位可解除封鎖。', '已預約槽位查看學員及時間，依提示處理取消需求。'], ['已預約時段不能當空槽刪除，需家長取消後釋回。'], ['../components/coach/SlotActionSheet']),
    lesson('coach-session', '授課入口與簽到狀態', '今日／授課記錄 → 課程', ['開啟課程，核對時間及學員。', '查看家長簽到與課程狀態。', '依可用入口進入授課記錄。'], ['教練不代簽；「教練代簽（舊制）」只是歷史來源。'], ['CoachSessionPage']),
    lesson('coach-plan', '填寫課前規劃', '課程 → 課前規劃', ['開啟指定課期的規劃。', '填寫內容，未完成先保存草稿。', '核對後依頁面操作送出。'], ['草稿與正式送出不同，離開前確認保存結果。'], ['LessonPlanFormPage']),
    lesson('coach-record', '授課記錄、附件與修訂', '授課入口 → 填授課記錄', ['開啟指定堂次，逐項填寫或套用前一堂後修改。', '需要時加入媒體附件，未完成先存草稿。', '核對後送出；已送出記錄再次保存會建立新版本。'], ['家長看到最新已送出內容；附件勿夾帶其他學員資料。'], ['SessionRecordFormPage']),
    lesson('coach-history', '授課記錄篩選與查閱', '授課記錄', ['使用日期與狀態篩選。', '查看已預約未簽到、已簽到等記錄。', '開啟課程詳情或授課內容。'], ['簽到標籤僅顯示狀態，不能在此代簽；時間以台北顯示。'], ['CoachHistoryPage']),
    lesson('coach-profile', '個人介紹、照片與送審', '個人', ['展開個人或詳細介紹，編輯後保存送審。', '依照片區的上傳、刪除及排序調整照片。', '查看審核狀態，確認核定內容。'], ['文字要按保存才送審；照片保存時機不同，操作前先看提示。', '送審不代表立即發佈。'], ['CoachProfilePage']),
  ],
};

// Only add recordings after exact media and playback have been reviewed.
export const guideRecordings = {};
export function reviewedRecording(recording) {
  return recording?.reviewed === true
    && /^\/brand\/guides\/videos\/[a-z0-9][a-z0-9_-]*\.(mp4|webm)$/.test(recording.src || '')
    ? recording : null;
}
