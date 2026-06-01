# 團購功能（U5–U8）測試清單

> 桶 B 工作單元 U5–U8。後端即時生效；前端改動已 `VITE_USE_MOCK=false` 重 build 至
> `server/public/{admin,liff}` 並重啟。app 跑在 port 3000。

## 自動化驗證（已執行，全綠）
- **U6 後端 e2e**：22 passed / 0 failed（建團 / 遮罩 / 加入 / 送審 / 核准 / 重複核准 / 邊界）。
- **架構修正驗證**：7 passed / 0 failed（join_token 僅團主可見、跨家庭 parent_id 遮罩、取消原子轉換）。
- 兩支為一次性腳本，驗證後已刪除。

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

## 桶 A — 只驗證不改碼（回歸）
- [ ] D 段後台頁面（聊天監察 / 標籤庫 / 考核 / 門檻 / 介紹送審 / 關鍵字）admin/manager 正常載入；staff 維持隱藏。
- [ ] 登入：教練 LINE、家長有資料自動登入 / 無資料註冊兩條路徑（`npm run smoke:ragic-auth`）。
- [ ] Ragic 狀態頁連續呼叫穩定。
- [ ] 教練「填授課記錄」標籤正常載入。
