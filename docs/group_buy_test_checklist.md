# 團購功能（U5–U8）測試清單

> 桶 B 工作單元 U5–U8。後端即時生效；前端改動已 `VITE_USE_MOCK=false` 重 build 至
> `server/public/{admin,liff}` 並重啟。app 跑在 port 3000。

## 自動化驗證（已執行，全綠）
- **U6 後端 e2e**：22 passed / 0 failed（建團 / 遮罩 / 加入 / 送審 / 核准 / 重複核准 / 邊界）。
- **架構修正驗證**：7 passed / 0 failed（join_token 僅團主可見、跨家庭 parent_id 遮罩、取消原子轉換）。
- 兩支為一次性腳本，驗證後已刪除。

---

## Claude 驗收結果（2026-06-01，未寫入正式資料）

驗收方式：DB schema 實查（唯讀）＋ 程式碼對照規格逐項審查 ＋ 已上線 bundle 內容比對 ＋ live 端點權限/錯誤碼探測。
**未做**：對正式 DB 跑寫入型端到端（鐵則「不可破壞正式資料」）；以下標 🟡 者需真人在 LINE/LIFF 內點測一輪。

- ✅ **U5 資料模型**：`group_orders`、`group_order_members` 兩表 + 欄位齊全；`course_type_configs.min_students`、`admin_enrollments.group_order_id / is_group_shared / payment_proof_url` 皆存在。後台 `courseTypes.js` 驗證 `1 ≤ min ≤ max ≤ 10` 且 `min ≤ max`（POST 第 43–45 行、PATCH 第 104–115 行）。
- ✅ **U6 後端 API**：路由已掛載（`/api/group-orders` 401、`/api/admin/group-orders` 401）；錯誤碼 `PAYMENT_PROOF_REQUIRED / ALREADY_MEMBER / OVER_CAPACITY / BELOW_MIN / NOT_FORMING / NOT_SUBMITTED` 與規格一致；並發加入/送審以 `SELECT … FOR UPDATE` 保護；取消/退回用原子條件 UPDATE（符合 [[group-buy-state]] 規則）。
- ✅ **U7 前端已上線**：LIFF 與 admin 的 bundle 於 06-01 07:42 重 build，`index.html` 指向之新 bundle 內含團購字串；admin 側欄/路由「團購審核」對 admin/manager/staff 開放（App.jsx:56、Sidebar.jsx:34）；三頁 source（Create/Join/Status）齊備。
- ✅ **U7 共享可見（整合鏈已驗）**：approve 為每位成員建 `admin_enrollments(is_group_shared=TRUE, group_order_id)`；`GET /courses/mine` 以 `parent_phone` 過濾並回傳 `is_group_shared`；`CourseCard` 據此顯示「團購共享」徽章。**跨子系統縫隙無問題。**
- ✅ **U8 PII 去敏（後端遮罩）**：`utils/piiMask.js` 規則正確（莊柏彥→莊X彥、兩字遮末字）；家長端只在 `is_self` 時回傳原始 `parent_id`/姓名/學生名/join_token，他人一律遮罩或 null。
- ✅ **U8 教練整班/個別填**：`SessionRecordFormPage.jsx` 具「整班一起填 / 個別學員填」切換、「套用到全班」、個別模式送出時合併為單一紀錄（以【學員名】分段）。
- 🟡 **需真人點測**：LIFF 在 LINE 內登入後跑完整端到端（發起→分享連結→他人加入→達上下限送審→櫃檯核准→各家長我的課程可見徽章）；admin 以 staff 帳號實際核准/退回一筆。建議用測試家長帳號跑一輪後刪除測試團購單，勿用正式資料。

---

## U5 — 團購資料模型 + 後台人數上下限
- [ ] 重啟後 DB 已建 `group_orders`、`group_order_members`；`course_type_configs.min_students`、`admin_enrollments.group_order_id / is_group_shared` 已存在。
- [ ] 後台「課程需求管理」(`/course-types`)：每品相可設定/儲存人數**下限/上限**，驗證 `1 ≤ min ≤ max ≤ 10`。
- [ ] 既有報名流程不受影響。

## U6 — 團購後端 API
- [ ] 家長（1對2 以上）發起團購 → 拿到 `join_token` + 分享連結，成為團主。
- [ ] 缺匯款證明 → 400 `PAYMENT_PROOF_REQUIRED`。
- [ ] 其他家長帶 token 加入，各自填學生 + 上傳證明。
- [ ] 重複加入 → 409 `ALREADY_MEMBER`；超過上限 → 409 `OVER_CAPACITY`。
- [ ] 未達下限送審 → 400 `BELOW_MIN`；達標 → 200 `submitted`。
- [ ] 非團主送審 → 403；非揪團中加入 → 409 `NOT_FORMING`。
- [ ] 並發加入受 `FOR UPDATE` 鎖保護，不超容量。

## U7 — 團購前端（LIFF + 後台）+ 共享可見
- [ ] LIFF 報名頁（課程 1對2 以上）顯示「發起團購」入口。
- [ ] 發起頁 `/group/new`、加入頁 `/group/join/:token`、狀態頁 `/group/:id` 可正常運作。
- [ ] 狀態頁即時顯示「目前人數 / 上下限」與各成員狀態；團主可複製邀請連結（`/liff/group/join/<token>`）。
- [ ] 後台「團購審核」頁（側欄，staff 可見可審）：列待審 / 已核准 / 已退回，可檢視成員、匯款證明。
- [ ] 櫃檯核准 → 為每位成員建立 `admin_enrollments`（`pending_payment`、`is_group_shared`、連 `group_order_id`），寫 audit log。
- [ ] 核准後各家長「我的課程」皆看得到此共享報名，`CourseCard` 顯示「團購共享」徽章。
- [ ] 退回需填原因；已核准/已退回的團購不能再被審核（409 `NOT_SUBMITTED`）。

## U8 — PII 去敏 + 教練整班/個別填記錄
- [ ] 加入頁 / 狀態頁中，**他家長 / 他學生**姓名中間字遮罩（莊柏彥 → 莊X彥；兩字名遮末字），由**後端**遮罩。
- [ ] 跨家庭成員回傳的 `parent_id` 為 `null`（僅本人可見自己的 id）；`join_token` 僅團主可取得。
- [ ] 教練「填授課記錄」：單一學員課照舊單份填寫。
- [ ] 團購班（多位學員）出現「整班一起填 / 個別學員填」切換。
- [ ] 「整班一起填」：一份內容套用全班。
- [ ] 「個別學員填」：可逐位學員填寫；「套用到全班」一鍵複製目前學員內容到全班；送出後合併為單份紀錄（以【學員名】分段）。

## U9 — 複數期數 + 對帳自動開通課程期（2026-06-02 新增）
- [x] DB：`group_orders.period_count`、`admin_enrollments.period_count` idempotent ALTER（rolled-back 交易實測通過）。
- [ ] 發起頁可選「購買期數」（1–6 期）；草稿暫存/還原會帶期數。
- [ ] 建立後 `GroupStatusPage`、後台 `GroupOrdersPage` 顯示「· N 期」。
- [ ] 核准後每位成員 `admin_enrollments.final_price = 單期價 × 學生數 × 期數`、`period_count` 正確。
- [x] 對帳通過 → 為團報 get-or-create **共用** `course_period(active)`，`total_sessions=6×期數`、`expires_at=365×期數` 天（partial-index `ON CONFLICT` 冪等，PG16 實測通過）。
- [ ] 同團多位成員逐筆對帳 → 仍只有「一個」course_period；各成員學員都進 `course_period_enrollments`。
- [ ] 🟡 真人點測：團報核准+對帳後，**教練端課表**該班期已開通可排課/選槽；家長端可進入「已開通課程期」。
- [ ] 團報無指定教練時對帳 → 報名仍轉 confirmed，period 暫不建（log warning），不報錯。
- [ ] 回歸：一般報名（非團報）對帳行為不變（total_sessions=6、不建 group period）。

## 桶 A — 只驗證不改碼（回歸）
- [ ] D 段後台頁面（聊天監察 / 標籤庫 / 考核 / 門檻 / 介紹送審 / 關鍵字）admin/manager 正常載入；staff 維持隱藏。
- [ ] 登入：教練 LINE、家長有資料自動登入 / 無資料註冊兩條路徑（`npm run smoke:ragic-auth`）。
- [ ] Ragic 狀態頁連續呼叫穩定。
- [ ] 教練「填授課記錄」標籤正常載入。
