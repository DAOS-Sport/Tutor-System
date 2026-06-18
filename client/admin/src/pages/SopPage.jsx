import React, { useState } from 'react';
import PageHeader from '../components/PageHeader';

const BASE = typeof window !== 'undefined' ? window.location.origin : 'https://daos-tutoring-courses.replit.app';
const ADM = `${BASE}/admin`;
const LIFF = `${BASE}/liff`;

const SECTIONS = [
  {
    id: 'urls',
    title: '系統網址一覽',
    icon: '🔗',
    content: [
      {
        type: 'intro',
        text: '以下為系統各入口及常用頁面的直接連結，點擊可在新分頁開啟。',
      },
      {
        type: 'links',
        title: '後台（管理員 / 主管 / 行政）',
        rows: [
          { label: '後台登入', url: `${ADM}/login`, note: '所有後台角色統一入口', roles: '全部' },
          { label: '今日總覽 Dashboard', url: `${ADM}/dashboard`, note: '今日課程數、待對帳數、本月營收', roles: '全部' },
          { label: '待對帳 (F-M02)', url: `${ADM}/reconcile`, note: '對帳入口，比對轉帳末5碼', roles: 'admin / manager' },
          { label: '所有報名 (F-R02)', url: `${ADM}/enrollments`, note: '可篩狀態、場館、關鍵字', roles: '全部' },
          { label: '今日課程 (F-R01)', url: `${ADM}/sessions`, note: '今天課表依時段排序', roles: '全部' },
          { label: '簽到驗證 / 點名 (F-R03)', url: `${ADM}/checkin`, note: '輸入手機+期次確認簽到', roles: '全部' },
          { label: '退課 (F-R04)', url: `${ADM}/refund`, note: '退費試算 → 確認 → 推播', roles: 'admin / manager' },
          { label: '(F-M05) 扣課復活', url: `${ADM}/revive`, note: '已取消時段一鍵復活', roles: 'admin / manager' },
          { label: '課程轉讓審核', url: `${ADM}/transfers`, note: '審核家長提交的轉讓申請', roles: 'admin / manager' },
          { label: '優惠活動 (F-M07/F-A05)', url: `${ADM}/promotions`, note: '建立 / 上架 / 停用 / 複製優惠', roles: 'admin / manager' },
          { label: '進行中優惠 (F-R05)', url: `${ADM}/promotions-active`, note: '唯讀清單', roles: '全部' },
          { label: 'MGM 推薦統計 (F-M10)', url: `${ADM}/mgm-stats`, note: '推薦漏斗 + 教練排行', roles: 'admin / manager' },
          { label: '標籤庫管理 (F-A08)', url: `${ADM}/tags`, note: '4大分類 × 系統標籤 CRUD', roles: 'admin / manager' },
          { label: '教練考核報表 (F-M09)', url: `${ADM}/coach-eval`, note: '4維平均、月趨勢、評語', roles: 'admin / manager' },
          { label: '考核門檻 (F-A09)', url: `${ADM}/eval-threshold`, note: '設定最低分與觀察月數', roles: 'admin' },
          { label: '教練介紹審核 (F-C06)', url: `${ADM}/coach-intros-review`, note: '待審 / 已退回 / 已上架 tab', roles: 'admin / manager' },
          { label: '課程介紹維護 (F-A04)', url: `${ADM}/course-intros`, note: '三組別文案 + 主圖', roles: 'admin / manager' },
          { label: '教練資料 (F-C-Admin)', url: `${ADM}/coaches`, note: '同步 Ragic + 編輯係數 / 場館', roles: 'admin' },
          { label: '員工管理 (F-A02)', url: `${ADM}/staff`, note: '新增 / 停用員工帳號', roles: 'admin' },
          { label: '場館設定 (F-A03)', url: `${ADM}/venues`, note: '銀行帳號 + LINE Token', roles: 'admin' },
          { label: '系統設定 (F-A01)', url: `${ADM}/settings`, note: '簽到時間範圍、退費規則等', roles: 'admin' },
          { label: '報表 (F-B01)', url: `${ADM}/reports`, note: '營收 / 堂數 / 折扣 / MGM / 學習完成率', roles: 'admin / manager' },
          { label: '系統 SOP（本頁）', url: `${ADM}/sop`, note: '完整操作說明手冊', roles: '全部' },
        ],
      },
      {
        type: 'links',
        title: '前台 — 家長端 LIFF（手機 LINE 內開啟）',
        rows: [
          { label: '家長首頁（購課入口）', url: `${LIFF}/`, note: '三組別卡片 + 優惠橫幅', roles: '家長' },
          { label: '我的課程', url: `${LIFF}/my-courses`, note: '全部 / 待對帳 / 進行中 / 已結束', roles: '家長' },
          { label: '我的課堂（堂數總覽）', url: `${LIFF}/my-lessons`, note: '各孩子課程剩餘堂數、到期日', roles: '家長' },
          { label: '學習歷程', url: `${LIFF}/history/:periodId`, note: '時間軸：課前規劃 + 每堂授課記錄 + 列印', roles: '家長' },
          { label: '期末評鑑', url: `${LIFF}/evaluation/:id`, note: '4維星星評分 + 文字 + 續報意願', roles: '家長' },
          { label: '邀請好友（MGM）', url: `${LIFF}/referral`, note: '產生推薦連結 / QR Code', roles: '家長' },
          { label: '申請課程轉讓', url: `${LIFF}/transfer/new`, note: '填對方手機 + 堂數 + 理由', roles: '家長' },
          { label: '我的（個人資料）', url: `${LIFF}/profile`, note: '學員清單、推薦紀錄、登出', roles: '家長' },
        ],
      },
      {
        type: 'links',
        title: '前台 — 教練端 LIFF（手機 LINE 內開啟）',
        rows: [
          { label: '教練今日課程', url: `${LIFF}/coach`, note: '今天所有課、填課前規劃 / 授課記錄 CTA', roles: '教練' },
          { label: '排課總表', url: `${LIFF}/coach/schedule`, note: '週 / 月切換、新增可用時段', roles: '教練' },
          { label: '教練個人介紹', url: `${LIFF}/coach/profile`, note: '編輯 bio、上傳介紹圖、送審', roles: '教練' },
        ],
      },
      {
        type: 'note',
        text: '📌 LIFF 連結以 LINE 內開啟才有自動登入功能；瀏覽器備用版請用上表的 /liff/* 路徑。教練連結須先由管理員完成 Ragic H01 LINE userid 綁定才能自動登入。',
      },
    ],
  },
  {
    id: 'overview',
    title: '系統概覽',
    icon: '🏫',
    content: [
      {
        type: 'intro',
        text: 'DAOS 夢想體育學院家教課程系統，整合 Ragic 人事資料、LINE 推播通知與後台管理，提供完整的報名、對帳、授課、評鑑流程。',
      },
      {
        type: 'table',
        title: '使用角色一覽',
        headers: ['角色', '帳號', '可操作功能'],
        rows: [
          ['系統管理員 (admin)', '最高權限', '所有功能，包含系統設定、員工管理、場館設定'],
          ['主管 (manager)', '場館主管', '報名對帳、退費、轉讓審核、優惠管理、學習歷程'],
          ['行政櫃檯 (staff)', '場館職員', '今日課程、簽到、所有報名（唯讀）、進行中優惠'],
          ['教練 (coach)', 'LINE LIFF', '排課、填課前規劃、填授課記錄、個人介紹管理'],
          ['家長 (parent)', 'LINE LIFF', '報名購課、對帳繳費、查看課程與學習歷程、期末評鑑'],
        ],
      },
      {
        type: 'table',
        title: '主要外部系統',
        headers: ['系統', '用途'],
        rows: [
          ['Ragic H01', '教練 / 員工人事資料來源，每次進入教練資料頁自動同步'],
          ['Ragic H05', '場館清單 / 銀行收款資訊來源，每次進入場館設定頁自動同步'],
          ['LINE Messaging API', '每場館一支 Token，對帳通過、發票、退費等 18 種 Flex 通知'],
          ['LINE LIFF（家長端）', '家長購課、查閱課程、學習歷程、評鑑、MGM 推薦'],
          ['LINE LIFF（教練端）', '教練排課、填授課記錄、管理個人介紹'],
        ],
      },
    ],
  },
  {
    id: 'onboarding',
    title: '新場館 / 教練上線',
    icon: '🆕',
    content: [
      {
        type: 'steps',
        title: '新場館上線流程',
        steps: [
          { step: '1', title: '在 Ragic H05 建立場館', desc: '填寫部門編號（場館代碼）、部門名稱、完整地址、銀行 4 欄（總機構名稱 / 分支機構名稱 / 戶名 / 帳號），並將履約狀態設為「履約中」。' },
          { step: '2', title: '同步進後台', desc: '進入「場館設定 (F-A03)」頁面，系統自動從 Ragic 同步，新場館出現在清單中。若需立即更新，請重新整理頁面。' },
          { step: '3', title: '設定 LINE Channel Token', desc: '在「場館設定」編輯該場館，填入對應 LINE Messaging API 的 Channel Token（每場館一支）。此 Token 用來向家長 / 教練推播通知。' },
          { step: '4', title: '確認教練可教場館', desc: '進入「教練資料 (F-C-Admin)」，編輯教練 → 勾選可教場館。教練才會在 LIFF 家長端的場館篩選中出現。' },
          { step: '5', title: '測試推播', desc: '找一位測試家長（LINE 帳號已綁定）進行試報名並對帳，確認 LINE 通知正常送達該場館的家長與教練。' },
        ],
      },
      {
        type: 'steps',
        title: '新教練上線流程',
        steps: [
          { step: '1', title: '在 Ragic H01 建立教練', desc: '填寫員工編號、姓名、手機、E-mail，應徵職務選「教練」，在職狀態設為「在職」。' },
          { step: '2', title: '同步進後台', desc: '進入「教練資料 (F-C-Admin)」頁面自動同步；或點「立即同步 Ragic」按鈕。教練在職期間 is_active=TRUE，離職後自動軟下架。' },
          { step: '3', title: '設定深度標籤 / 修課係數', desc: '後台編輯教練：設定資深標籤、修課係數（1.0~2.0）、可教場館。係數影響家長 LIFF 報名頁的顯示費用。' },
          { step: '4', title: '教練完成 LIFF 登入綁定', desc: '教練點開 LIFF 教練連結，輸入手機 + LINE 帳號完成綁定，系統記錄 line_uid。完成後教練才能使用排課 / 填記錄功能。' },
          { step: '5', title: '教練撰寫個人介紹', desc: '教練端 LIFF 填寫個人簡介、上傳介紹圖片，送審後由管理員在「教練介紹送審 (F-C06)」核准，家長端才會看到正式介紹。' },
        ],
      },
    ],
  },
  {
    id: 'enrollment',
    title: '報名與對帳',
    icon: '📋',
    content: [
      {
        type: 'steps',
        title: '報名到上課完整流程',
        steps: [
          { step: '1', title: '家長在 LIFF 報名', desc: '家長選擇場館 → 教練 → 課程組別（1對1 / 1對2 / 1對3） → 填學員資料 → 查看費用（含優惠） → 複製銀行帳號 → 完成報名，狀態為「待對帳」。' },
          { step: '2', title: '家長轉帳並告知末 5 碼', desc: '家長轉帳後在 LINE 或系統中提供轉帳末 5 碼，系統記錄備用。' },
          { step: '3', title: '行政人員確認款項', desc: '進入「待對帳清單 (F-M02)」，找到該筆報名，核對轉帳金額與末 5 碼是否吻合。' },
          { step: '4', title: '對帳通過（含填發票）', desc: '點「對帳通過」，填寫發票號碼（格式 AA-12345678）、上傳發票照片，選填電子發票查詢網址，確認送出。系統同時：(a) 開通課程；(b) 建立教練與家長的聊天室；(c) 推播對帳通過 + 發票 Flex 給家長；(d) 寫入審計日誌。' },
          { step: '5', title: '家長收到 LINE 通知', desc: '家長 LINE 收到：發票照片 + 發票號碼 + 「查看電子發票」連結 + 「登入查看訂單」按鈕，可直接導入 LIFF 我的課程頁。' },
          { step: '6', title: '課程正式進行', desc: '教練在「今日課程 (F-R01)」查看排定的課程；行政在「簽到驗證 (F-R03)」確認學員到場；教練在 LIFF 填授課記錄。' },
        ],
      },
      {
        type: 'warning',
        text: '⚠️ 對帳通過後若家長已付款但金額有誤，請先使用「退課處理 (F-R04)」退款，再請家長重新報名。不可直接刪除已對帳的報名記錄。',
      },
      {
        type: 'table',
        title: '報名狀態說明',
        headers: ['狀態', '說明', '下一步'],
        rows: [
          ['待對帳', '家長已送出報名，等待款項確認', '行政對帳通過 / 退課'],
          ['進行中', '對帳通過，課程已開通', '教練授課，填記錄'],
          ['已結束', '所有堂數已使用完畢或期末評鑑完成', '—'],
          ['已退課', '退費處理完成，課程關閉', '可申請復活（F-M05）'],
        ],
      },
    ],
  },
  {
    id: 'refund',
    title: '退費與退課',
    icon: '↩️',
    content: [
      {
        type: 'steps',
        title: '退課退費流程',
        steps: [
          { step: '1', title: '確認退費理由', desc: '家長或教練提出退課申請，行政確認已上課堂數（used_sessions）與剩餘堂數。退費金額 = 剩餘堂數 × 單堂費用（原始費用按比例計算）。' },
          { step: '2', title: '填寫退費申請', desc: '進入「退課處理 (F-R04)」，選擇報名記錄，填寫退費金額與退費理由（必填）。可先點「退費試算」確認金額。' },
          { step: '3', title: '主管 / 管理員審核', desc: '由 manager 或 admin 角色確認退費，系統更新狀態為「已退課」並推播 LINE 通知家長。審計日誌記錄操作人、原因、退費金額。' },
          { step: '4', title: '實際匯款給家長', desc: '行政依退費金額進行銀行轉帳給家長，轉帳完成後可在備註欄記錄入帳日期（目前為手動作業）。' },
        ],
      },
      {
        type: 'steps',
        title: '扣課復活流程（家長重新報名同課程）',
        steps: [
          { step: '1', title: '在扣課復活頁操作', desc: '進入「(F-M05) 扣課復活」，找到已退課的報名記錄。' },
          { step: '2', title: '確認復活', desc: '確認後系統將狀態改回「進行中」，保留原有已上課堂數紀錄，重新開通聊天室。家長 LINE 收到復活通知。' },
        ],
      },
      {
        type: 'warning',
        text: '⚠️ 退費理由為必填欄位，所有退費操作皆寫入審計日誌，無法刪除。請務必填寫真實原因。',
      },
    ],
  },
  {
    id: 'transfer',
    title: '課程轉讓',
    icon: '🔄',
    content: [
      {
        type: 'steps',
        title: '課程轉讓審核流程',
        steps: [
          { step: '1', title: '家長發起轉讓申請', desc: '家長在 LIFF「我的課程」頁申請轉讓，填寫接收方家長手機號碼，系統建立轉讓記錄（狀態：申請中）。' },
          { step: '2', title: '接收方確認', desc: '接收方家長在 LIFF 收到轉讓通知後確認接受。雙方皆須為系統已註冊的家長。' },
          { step: '3', title: '行政審核', desc: '進入「課程轉讓審核 (F-M04)」，確認轉讓資訊（原家長、接收家長、課程、剩餘堂數），審核通過或拒絕。' },
          { step: '4', title: '完成轉讓', desc: '審核通過後，系統將課程從原家長名下移至接收方，推播 LINE 通知雙方家長。' },
        ],
      },
      {
        type: 'note',
        text: '📌 轉讓不影響教練與場館，僅更改課程的家長歸屬。轉讓後退費由接收方家長負責。',
      },
    ],
  },
  {
    id: 'checkin',
    title: '簽到與上課管理',
    icon: '✅',
    content: [
      {
        type: 'steps',
        title: '每日上課簽到流程',
        steps: [
          { step: '1', title: '確認今日課程', desc: '行政進入「今日課程 (F-R01)」，查看當天所有已安排的課程時段（依場館、教練、學員列出）。' },
          { step: '2', title: '學員到場簽到', desc: '進入「簽到驗證 (F-R03)」，選擇課程時段，點「確認簽到」記錄。系統自動扣除使用堂數（used_sessions +1）。' },
          { step: '3', title: '教練填授課記錄', desc: '教練在 LIFF 開啟授課記錄頁，填寫本次授課內容摘要、選擇技能標籤，系統自動帶入課前規劃內容供對照，可「複製上次記錄」快速填寫。' },
          { step: '4', title: '家長在 LIFF 查看', desc: '家長在 LIFF「我的課程」→ 學習歷程頁看到該堂授課記錄（教練已發布才顯示）。' },
        ],
      },
      {
        type: 'note',
        text: '📌 簽到時若發現學員未到，仍可選擇「缺席」記錄，不扣除堂數。具體規則依場館主管決定。',
      },
    ],
  },
  {
    id: 'promotions',
    title: '優惠活動與 MGM',
    icon: '🎁',
    content: [
      {
        type: 'steps',
        title: '建立優惠活動',
        steps: [
          { step: '1', title: '進入優惠管理 (F-M07/F-A05)', desc: '點「新增優惠」，填寫優惠名稱、說明、折扣類型（固定金額 / 百分比折扣）、折扣值、有效日期、使用次數上限。' },
          { step: '2', title: '設定適用條件', desc: '可設定最低消費金額、可使用的場館範圍（全館 / 指定場館）、僅限新戶使用等條件。' },
          { step: '3', title: '產生優惠碼', desc: '優惠活動建立後，系統自動產生優惠碼（可自訂前綴）。家長在 LIFF 報名頁輸入優惠碼，系統自動試算折扣。' },
          { step: '4', title: '追蹤使用狀況', desc: '在「進行中優惠 (F-R05)」查看所有有效優惠；在優惠活動列表查看使用次數統計。' },
        ],
      },
      {
        type: 'steps',
        title: 'MGM 推薦裂變流程',
        steps: [
          { step: '1', title: '家長取得推薦連結', desc: '家長在 LIFF 個人頁可產生個人推薦連結（QR code），分享給親友。' },
          { step: '2', title: '新家長透過連結報名', desc: '新家長點推薦連結進入 LIFF，系統自動記錄推薦來源，完成報名並對帳通過後，推薦記錄成立。' },
          { step: '3', title: '獎勵發放', desc: '達到推薦門檻（人數或金額）後，系統推播 LINE 通知推薦人，行政在「MGM 推薦統計 (F-M10)」查看發放清單並手動匯款。' },
        ],
      },
    ],
  },
  {
    id: 'learning',
    title: '學習歷程與評鑑',
    icon: '📚',
    content: [
      {
        type: 'steps',
        title: '學習歷程完整流程',
        steps: [
          { step: '1', title: '教練填課前規劃', desc: '教練在 LIFF 開課前填寫本期課程目標、計畫重點（草稿可存，發布後家長才看得到）。' },
          { step: '2', title: '每堂授課填記錄', desc: '每次上課後教練填授課記錄：摘要內容、選擇技能標籤（如「右手揮拍」「步伐移動」）、加個人標籤，可上傳影片或照片。' },
          { step: '3', title: '家長查閱歷程', desc: '家長在 LIFF「我的課程 → 學習歷程」看到時間軸排列的課前規劃 + 每堂授課記錄，可列印。' },
          { step: '4', title: '期末評鑑（家長端）', desc: '課程結束前，系統自動推播 LINE 邀請家長填寫期末評鑑（4 個面向：教學品質 / 溝通態度 / 準時出席 / 整體滿意度）+ 文字回饋 + 是否續課意願。7 天後若未填，再次提醒。' },
          { step: '5', title: '管理員查看考核', desc: '進入「教練考核 (F-M09)」查看每位教練的各面向平均分數、月趨勢折線圖、家長文字回饋。若分數低於「考核門檻 (F-A09)」設定值，系統自動標記預警。' },
        ],
      },
      {
        type: 'table',
        title: '標籤庫管理（F-A08）',
        headers: ['操作', '說明'],
        rows: [
          ['新增標籤分類', '進入「標籤庫」，建立分類（如「技術」「體能」「態度」），設定顏色。'],
          ['新增標籤', '在分類下新增具體標籤（如「右手正手拍」「橫向移位」），教練填記錄時可點選自動帶入描述文字。'],
          ['教練個人標籤', '教練可在 LIFF 自建只有自己看得到的個人標籤，不影響系統標籤庫。'],
        ],
      },
    ],
  },
  {
    id: 'line',
    title: 'LINE 通知管理',
    icon: '📩',
    content: [
      {
        type: 'table',
        title: '系統自動推播的 18 種通知',
        headers: ['觸發時機', '推播對象', '通知內容'],
        rows: [
          ['報名成功', '家長', '報名確認 + 轉帳帳號 + 末 5 碼提醒'],
          ['對帳通過（含發票）', '家長', '發票照片 + 發票號碼 + 查詢連結 + 訂單連結'],
          ['退費完成', '家長', '退費金額 + 原因 + 預計退款時間'],
          ['課程復活', '家長', '課程已恢復通知'],
          ['課程轉讓審核通過', '雙方家長', '各自收到轉讓完成通知'],
          ['教練介紹送審', '教練', '已送審確認通知'],
          ['教練介紹審核通過', '教練', '介紹已上架通知'],
          ['教練介紹審核拒絕', '教練', '拒絕原因 + 請修改重送'],
          ['評鑑邀請（期末）', '家長', '填寫評鑑連結 + LIFF 導入'],
          ['評鑑 7 天提醒', '家長', '同上，提醒未填者'],
          ['考核分數低於門檻', '主管 LINE', '教練姓名 + 面向分數 + 預警標示'],
          ['關鍵字警示', '主管 LINE', '聊天室關鍵字 + 家長資訊 + 連結'],
          ['優惠活動開始', '家長（選配）', '優惠碼 + 有效期限'],
          ['MGM 推薦達標', '推薦人家長', '達標通知 + 獎勵說明'],
          ['聊天室訊息（即時）', '家長 / 教練', 'WebSocket 即時推送（非 LINE 推播）'],
          ['今日課程提醒', '教練', '每日 10:00 推播當天課程清單'],
          ['未填授課記錄提醒', '教練', '課後 24h 未填時推播提醒'],
          ['推薦連結分享', '家長', '家長主動分享時推播 QR code + 連結'],
        ],
      },
      {
        type: 'note',
        text: '📌 每個場館的 LINE 推播皆使用各場館自己的 Channel Token，需在「場館設定 (F-A03)」填入。若 Token 空白，該場館的通知將靜默失敗（後端有 console.warn 記錄）。',
      },
    ],
  },
  {
    id: 'admin-settings',
    title: '系統設定',
    icon: '⚙️',
    content: [
      {
        type: 'table',
        title: '全域系統設定 (F-A01) 項目',
        headers: ['設定項目', '說明'],
        rows: [
          ['1對1 基礎費用', '家長 LIFF 計算費用的基礎單價（元/堂）'],
          ['1對2 基礎費用', '兩人同組時的每人費用'],
          ['1對3 基礎費用', '三人同組時的每人費用'],
          ['體驗課費用', 'MGM 推薦帶來的新戶體驗課固定費用'],
          ['MGM 推薦獎勵金', '每成功推薦一位新家長給予的獎勵金額'],
          ['發票開立提醒', '對帳通過時提示行政需上傳發票（介面提示文字）'],
        ],
      },
      {
        type: 'steps',
        title: '員工帳號管理 (F-A02)',
        steps: [
          { step: '1', title: '新增員工帳號', desc: '進入「員工帳號管理」，填寫帳號名稱、初始密碼、角色（admin / manager / staff）、所屬場館（staff 角色限單場館）。' },
          { step: '2', title: '員工首次登入', desc: '員工用初始密碼登入後，應立即至個人設定修改密碼（目前為管理員統一設定）。' },
          { step: '3', title: '離職員工停用', desc: '將員工帳號的 active 設為 FALSE，該帳號立即無法登入，已有的審計日誌保留。' },
        ],
      },
    ],
  },
  {
    id: 'faq',
    title: '常見問題 Q&A',
    icon: '❓',
    content: [
      {
        type: 'faq',
        items: [
          {
            q: '教練端 LIFF 進去後顯示「找不到教練」怎麼辦？',
            a: '確認 Ragic H01 該教練的在職狀態為「在職」、應徵職務含「教練」；進入後台「教練資料」頁點「立即同步 Ragic」；確認教練用來登入的手機號碼與 Ragic H01 記錄的「手機」欄一致（注意格式，09 開頭、10 碼）。',
          },
          {
            q: '家長報名後收不到 LINE 通知？',
            a: '(1) 確認該場館「場館設定」中已填入正確的 LINE Channel Token；(2) 確認家長的 LINE 帳號已加入該場館的 LINE 官方帳號為好友；(3) 查看伺服器 console 是否有 LINE push 錯誤 log。',
          },
          {
            q: '對帳清單中找不到某筆報名？',
            a: '對帳清單 (F-M02) 只顯示「待對帳」狀態的報名。若家長已對帳通過，可到「所有報名 (F-R02)」以手機或報名編號搜尋。若報名根本找不到，請確認家長是否在另一個場館報名。',
          },
          {
            q: '教練資料同步後仍顯示舊資料？',
            a: '點「立即同步 Ragic」按鈕強制同步；若按鈕點了仍無效，請重新整理頁面（Ctrl+Shift+R 清快取）。Ragic 同步有 5 分鐘快取，同一 server process 內連續同步只打一次 API。',
          },
          {
            q: '發票照片要傳多大？什麼格式？',
            a: '支援 jpg / png，建議壓縮至 5MB 以下以確保 LINE Flex 訊息中圖片能正常顯示。LINE 對 Flex imageHero 有圖片大小建議，過大可能顯示異常。',
          },
          {
            q: '如何確認 LINE 推播是否成功送出？',
            a: '查看伺服器 console log（Replit Workflow 輸出），搜尋 [line.push] 或 [line.broadcast]；成功時印 OK，失敗時印 error 與 LINE 回傳的錯誤碼（常見：400 無效 Token、403 未加好友）。',
          },
          {
            q: '優惠碼家長輸入說無效，但碼是正確的？',
            a: '確認 (1) 優惠活動是否在有效期限內；(2) 是否設定了「僅限新戶」但家長已有過報名記錄；(3) 是否設定了場館限制但家長選的是其他場館；(4) 使用次數是否已達上限。',
          },
          {
            q: '如何備份資料庫？',
            a: '目前使用 Replit 內建 PostgreSQL。建議定期執行 pg_dump 匯出（可在 Replit Shell 執行 `pg_dump $DATABASE_URL > backup_YYYYMMDD.sql`）。Task #27（自動備份排程）已取消，需手動備份。',
          },
        ],
      },
    ],
  },
];

function StepList({ steps }) {
  return (
    <div className="space-y-3">
      {steps.map((s) => (
        <div key={s.step} className="flex gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-primary text-sm font-bold text-white">
            {s.step}
          </div>
          <div>
            <div className="font-semibold text-gray-800">{s.title}</div>
            <div className="mt-0.5 text-sm text-gray-600">{s.desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ContentTable({ title, headers, rows }) {
  return (
    <div>
      {title && <div className="mb-2 font-semibold text-gray-700">{title}</div>}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              {headers.map((h) => (
                <th key={h} className="px-4 py-2 text-left font-semibold text-gray-600">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-gray-50">
                {row.map((cell, j) => (
                  <td key={j} className="px-4 py-2 text-gray-700">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FaqList({ items }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="divide-y divide-gray-200 rounded-lg border border-gray-200">
      {items.map((item, i) => (
        <div key={i}>
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="flex w-full items-start justify-between px-4 py-3 text-left hover:bg-gray-50"
          >
            <span className="font-medium text-gray-800">{item.q}</span>
            <span className="ml-3 shrink-0 text-brand-primary">{open === i ? '▲' : '▼'}</span>
          </button>
          {open === i && (
            <div className="border-t border-gray-100 bg-brand-primary/5 px-4 py-3 text-sm text-gray-700">
              {item.a}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function LinksTable({ title, rows }) {
  return (
    <div>
      {title && <div className="mb-2 font-semibold text-gray-700">{title}</div>}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-semibold text-gray-600">頁面名稱</th>
              <th className="px-4 py-2 text-left font-semibold text-gray-600">網址</th>
              <th className="px-4 py-2 text-left font-semibold text-gray-600">說明</th>
              <th className="px-4 py-2 text-left font-semibold text-gray-600">可用角色</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-blue-50">
                <td className="px-4 py-2 font-medium text-gray-800">{row.label}</td>
                <td className="px-4 py-2">
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded bg-brand-primary/10 px-2 py-0.5 font-mono text-xs text-brand-primary hover:bg-brand-primary/20 hover:underline"
                  >
                    {row.url.replace(window.location.origin, '')}
                    <span className="opacity-60">↗</span>
                  </a>
                </td>
                <td className="px-4 py-2 text-gray-600">{row.note}</td>
                <td className="px-4 py-2">
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                    {row.roles}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RenderBlock({ block }) {
  switch (block.type) {
    case 'intro':
      return <p className="text-gray-600">{block.text}</p>;
    case 'links':
      return <LinksTable title={block.title} rows={block.rows} />;
    case 'steps':
      return (
        <div>
          {block.title && <div className="mb-3 font-semibold text-gray-700">{block.title}</div>}
          <StepList steps={block.steps} />
        </div>
      );
    case 'table':
      return <ContentTable title={block.title} headers={block.headers} rows={block.rows} />;
    case 'warning':
      return (
        <div className="rounded-md border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {block.text}
        </div>
      );
    case 'note':
      return (
        <div className="rounded-md border-l-4 border-brand-teal bg-teal-50 px-4 py-3 text-sm text-teal-800">
          {block.text}
        </div>
      );
    case 'faq':
      return <FaqList items={block.items} />;
    default:
      return null;
  }
}

export default function SopPage() {
  const [active, setActive] = useState('urls');
  const section = SECTIONS.find((s) => s.id === active);

  return (
    <div className="p-6">
      <PageHeader title="系統操作 SOP" subtitle="完整流程說明 · 所有角色通用參考手冊" />
      <div className="flex gap-6">
        {/* 左側目錄 */}
        <aside className="hidden w-52 shrink-0 md:block">
          <nav className="sticky top-4 space-y-1 rounded-xl border border-gray-200 bg-white p-3">
            <div className="px-2 pb-2 text-[11px] font-bold uppercase tracking-wider text-gray-400">
              目錄
            </div>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setActive(s.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                  active === s.id
                    ? 'bg-brand-primary font-semibold text-white'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                <span>{s.icon}</span>
                <span>{s.title}</span>
              </button>
            ))}
          </nav>
        </aside>

        {/* 行動版下拉選單 */}
        <div className="mb-4 block md:hidden w-full">
          <select
            value={active}
            onChange={(e) => setActive(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
          >
            {SECTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.icon} {s.title}
              </option>
            ))}
          </select>
        </div>

        {/* 內容區 */}
        {section && (
          <main className="min-w-0 flex-1">
            <div className="rounded-xl border border-gray-200 bg-white p-6">
              <h2 className="mb-5 flex items-center gap-2 text-xl font-bold text-gray-900">
                <span className="text-2xl">{section.icon}</span>
                {section.title}
              </h2>
              <div className="space-y-6">
                {section.content.map((block, i) => (
                  <RenderBlock key={i} block={block} />
                ))}
              </div>
            </div>

            {/* 上下導覽 */}
            <div className="mt-4 flex justify-between">
              {SECTIONS.findIndex((s) => s.id === active) > 0 && (
                <button
                  onClick={() =>
                    setActive(SECTIONS[SECTIONS.findIndex((s) => s.id === active) - 1].id)
                  }
                  className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
                >
                  ← 上一章
                </button>
              )}
              {SECTIONS.findIndex((s) => s.id === active) < SECTIONS.length - 1 && (
                <button
                  onClick={() =>
                    setActive(SECTIONS[SECTIONS.findIndex((s) => s.id === active) + 1].id)
                  }
                  className="ml-auto rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
                >
                  下一章 →
                </button>
              )}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
