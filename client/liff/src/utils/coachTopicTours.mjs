// Booking and schedule are not open; do not expose their guide entries.
const step = (route, key, title, text, view) => ({ route, target: `[data-coach-guide="${key}"]`, title, text, view });
export const coachTopicTours = {
  "coach-login": { start: "/coach", steps: [
    step("/coach", "today-overview", "教練登入與功能入口", "教練由專屬入口使用 LINE 登入，先核對教練身分。底部可用入口為首頁、報名記錄、授課記錄與個人；需家長身分請由家長登入入口進入。無法登入請洽櫃檯核對綁定。本次顯示 DEMO，不會登出、切換身分或執行登入。", ""),
  ] },
  "coach-today": { start: "/coach", steps: [
    step("/coach", "today-overview", "今日課程、優惠與到期提醒", "同頁先核對教練身分及日期，再查看進行中的優惠、到期組數與今日課程。課程卡顯示時間、場館、學員與簽到狀態，可開啟授課入口；教練不代簽。付款及訂單問題請洽櫃檯。", ""),
    step("/coach", "today-expiry-items", "展開需要提醒的報名", "到期通知涵蓋往後 3 個曆月，月底取當月最後一天。展開後核對學員、組別、場館、期別、堂數及期限，可查看對應報名並提醒家長授課。載入失敗不代表沒有到期資料。", "expiry"),
  ] },
  "coach-orders": { start: "/coach/orders", steps: [
    step("/coach/orders", "orders-overview", "報名記錄與狀態查詢", "同頁使用全部或狀態標籤篩選，核對學員、期別、組別、狀態及堂數；從到期通知進來會標示對應報名。教練頁不提供金額或發票號碼。同一期同班兄弟姊妹算一張訂單，下一期另計。待對帳由櫃檯處理，不代表家長未匯款。", ""),
  ] },
  "coach-session": { start: "/coach/session/DEMO-SESSION", steps: [
    step("/coach/session/DEMO-SESSION", "session-overview", "授課場次與簽到狀態", "同頁核對日期時間、場館、組別、時長、學員名單及課程狀態。簽到只供查閱；教練不代簽，家長整班簽到與櫃檯第二堂處理沿用既有流程，「教練代簽（舊制）」僅供歷史辨識。下方原入口可填本期課前規劃及本堂授課記錄。", ""),
  ] },
  "coach-plan": { start: "/coach/plan/DEMO-PERIOD", steps: [
    step("/coach/plan/DEMO-PERIOD", "plan-overview", "課前規劃、草稿與發佈", "同頁填本期學習目標、預期成果、訓練規劃、初評及備註。未完成先儲存草稿，核對後發佈給家長；已發佈內容可以更新並重新發佈。離開前確認保存回應。本次只展示原表單與按鈕，不會保存或發佈。", ""),
  ] },
  "coach-record": { start: "/coach/record/DEMO-SESSION", steps: [
    step("/coach/record/DEMO-SESSION", "record-overview", "整班授課記錄、標籤與附件", "同頁逐項填摘要、亮點、待加強、回家練習及備註。可複製前一堂再修改，點分類標籤帶入文案，管理個人常用文案與照片／影片附件；附件勿夾帶其他學員資料。未完成存草稿，核對後送出。已送出記錄再次保存會建立新版本；家長看最新已送出內容。教學模式不讀取真記錄、不保存或上傳。", "class"),
    step("/coach/record/DEMO-SESSION", "record-overview", "個別學員填寫", "同一份原表單切為個別學員模式。先選學員，再填同頁五個欄位、套用標籤及核對附件；需要共用內容時可把目前學員內容套用到全班，再逐一核對。個別填寫僅區分教學內容，簽到與扣堂仍以整班訂單處理，不會各自扣堂。草稿、送出與修訂仍用下方原按鈕；本次教學不會保存。", "individual"),
  ] },
  "coach-history": { start: "/coach/history", steps: [
    step("/coach/history", "history-overview", "授課記錄篩選與查閱", "同頁以日期區間、簽到狀態及學員／課期篩選，再核對記錄卡的學員、堂數、日期時間、場館及原授課教練。點卡片可進授課入口。既有「已預約未簽到／已預約已簽到」只是歷史狀態，這裡不提供預約或代簽；時間以台北顯示。", "students"),
  ] },
  "coach-profile": { start: "/coach/profile", steps: [
    step("/coach/profile", "profile-bio-overview", "個人介紹、大頭照與審核", "同頁核對教練身分、授權場館及介紹審核狀態，展開短版個人介紹並維護大頭照。家長小卡只顯示兩行，超過建議長度會提醒；文字按儲存才送審，大頭照正式操作即更新。教學模式已阻擋保存、選檔、上傳及移除。", "bio"),
    step("/coach/profile", "profile-detail", "詳細介紹與介紹圖片", "在原詳細介紹區編輯長版說明，並核對照片、圖片說明、刪除和上下排序。文字按儲存才送審；圖片上傳、刪除與排序會即時保存，與文字時機不同。可由原入口新增圖片或預覽家長看到的樣子；本次所有寫入均停用。", "detail"),
    step("/coach/profile", "profile-add-modal", "新增介紹圖片", "原圖片視窗可選 JPG／PNG（最多 5MB）、填圖片說明再送出。這次只展示原視窗，不開選檔、不上傳。", "add-media"),
    step("/coach/profile", "profile-preview-modal", "預覽介紹與發佈狀態", "這是原預覽視窗，含介紹、照片、授權場館及優惠。教練預覽也可看到未發佈圖片；家長須等審核通過才看得到。送審不代表立即發佈。本次顯示 DEMO，按「完成，返回首頁」即結束引導並回到首頁。", "preview"),
  ] },
};
export const coachGuideTopicIds = Object.freeze(Object.keys(coachTopicTours));
export const coachTopicPlan = id => coachTopicTours[id] || null;
