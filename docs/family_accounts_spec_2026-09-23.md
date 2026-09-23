# 家庭帳號（櫃台確認制）規格 — 2026-09-23

> 狀態：規格定稿待實作。本文件不含任何真實家長／學員個資。
> 文中的程式位置皆以 `553da3e` 核對過。

## 0. 背景與已定案的決策

**問題**：同一個孩子常由兩位（以上）家人照顧。現行系統一個孩子只能掛在一個家長帳號
（`students.parent_id`），另一位家人：

- 看不到孩子、課程、訂單；
- 不能幫孩子簽到、不能付款；
- 想自己把孩子加進帳號時，被「身分證字號已存在」擋下（這道關卡是對的：重複的學員
  每晚都會在 Ragic 備份時失敗）。

正式庫實測（2026-09-23）：**24 位孩子被 2 位以上家長各自登記，牽涉 44 個帳號**；
其中 18 位只有一份掛課程、5 位兩份都掛課程、1 位都沒有。典型案例：媽媽報名、孩子在
Ragic 掛在媽媽名下，實際繳費與帶孩子簽到的是爸爸。

**擁有者決策（2026-09-23）**

| # | 決策 |
|---|---|
| 1 | 家庭成員**可以幫孩子簽到**（同意凍結令相關變更，範圍見 §5） |
| 2 | 通知**發給全家**（例外見決策 8） |
| 3 | 一個帳號**同一時間只屬於一個家庭** |
| 4 | **第二階段要做**：成員可以自己下單 |
| — | 成員（例如爸爸）可以幫家裡既有的訂單**付款** |
| 5 | 成員**可以預約課堂**，前提是教練先開放時段（現行流程本來就是教練開時段、家長選） |
| 6 | 第二階段成員**可以開團、參團**；同一家庭在同一團**只算一戶**，不能邀自己家人湊團，不會拿到第二份團購優惠 |
| 7 | 成員新增的孩子**掛在成員自己名下**（Ragic 家長＝該成員），全家都看得到；成員也可以把**自己**新增為學員 |
| 8 | **發票 Email 只寄報名者**；**簽到通知只發給簽到的人**；其餘通知照決策 2 發全家 |

**設計原則**

- **Ragic 完全不改**。孩子仍掛在原本的家長底下；家庭只擴充「誰可以代為操作」。
- **只有櫃台／管理員能建立家庭、增減成員**（防濫用：由認得這家人的人確認）。
- 家庭權限**每次請求即時判斷**，不寫進登入憑證，移除成員立刻生效。
- 全部功能掛在一個開關 `FAMILY_ACCOUNTS_V1` 後面，關掉即回到現行行為。

## 1. 名詞

| 名詞 | 定義 |
|---|---|
| 家庭 | 櫃台確認的一組家長帳號（`families`／`family_members` 兩張表） |
| 擁有者（owner） | 家庭建立時指定的帳號，預設是孩子在 Ragic 所屬的那位家長 |
| 成員（member） | 其他加入的家長帳號 |
| 關係 | 爸爸／媽媽／爺爺／奶奶／外公／外婆／其他照顧者（可擴充） |
| 孩子的所屬家長 | 維持 `students.parent_id`，等於 Ragic 上的家長，**不因家庭而改變** |
| 家庭可代操作的家長集合 | 本人 ∪ 同家庭所有 active 成員（含擁有者） |

> **命名注意**：程式裡已有三個不相干的「family」——付款單發票分組
> （`services/checkoutFamilies.js`，以家長手機為單位）、家庭共班（migration 029，同一家長
> 多位孩子共用課期）、Z01 來源家庭（`services/z03IdentityClaim.js`）。本功能的新程式一律用
> `familyScope`／`familyAccount` 開頭，不要沿用上述三者的函式。

## 2. 權限矩陣

| 動作 | 擁有者 | 成員 | 階段 |
|---|---|---|---|
| 看全家的孩子、課表、上課紀錄、學習歷程 | ✓ | ✓ | 一 |
| 看全家的訂單、付款單、付款狀態 | ✓ | ✓ | 一 |
| 與教練的課程聊天室 | ✓ | ✓ | 一 |
| 期末評鑑（查看、填寫） | ✓ | ✓ | 一 |
| **幫孩子簽到** | ✓ | ✓ | 一 |
| 預約課堂（只能選教練已開放的時段） | ✓ | ✓ | 一 |
| **幫已存在的訂單／付款單／團購付款**（上傳匯款證明、填後五碼） | ✓ | ✓ | 一 |
| 取消訂單／付款單 | ✓ | 僅自己下的 | 一 |
| 自己下新訂單 | ✓ | ✓ | **二** |
| 團購開團／參團（同一家庭同一團只算一戶） | ✓ | ✓ | **二** |
| 團購送審、取消團 | 僅團主 | 僅團主 | — |
| 改孩子資料（會寫回 Ragic） | 僅孩子的所屬家長 | 僅孩子的所屬家長 | — |
| 新增孩子，或把自己新增為學員 | 加在自己名下，全家可見 | 同左 | 一 |
| 轉讓堂數 | 僅購買人 | 僅購買人 | — |
| 改自己的個人資料 | 本人 | 本人 | — |
| 推薦（MGM）獎勵 | 個人 | 個人 | — |

## 3. 資料表

`families`、`family_members` 早已建好（`db/migrations/010_customer_family_base.sql`），
正式庫**目前 0 筆**，`parents.family_id` 也全為空。原設計以 LINE UID 當成員唯一鍵，但 LINE
會換（帳號被盜重綁），**改用家長帳號**。表是空的，調整沒有資料風險。

```
families
  id, owner_parent_id, name, created_at, updated_at（既有）
  + status        TEXT NOT NULL DEFAULT 'active'  CHECK IN ('active','frozen')
  + created_by    TEXT                            -- 後台操作者
family_members
  id, family_id, line_uid, parent_id, role, status, invited_by, created_at（既有）
  - line_uid 的 UNIQUE                            -- 移除；欄位保留但不使用
  + parent_id     NOT NULL                        -- 家長帳號要先移出家庭才能硬刪
  + UNIQUE(parent_id)                             -- 決策 3：一人一家
  + role          CHECK IN ('owner','member')     -- 沿用 010 註解的值
  + status        CHECK IN ('active','revoked')   -- 沿用 010 註解的值；不用 invited（由櫃台直接連結）
  + relationship  TEXT NOT NULL CHECK IN ('father','mother','grandfather','grandmother',
                                          'maternal_grandfather','maternal_grandmother','guardian')
  + linked_by / linked_at / revoked_by / revoked_at / note
family_audit_logs（新）
  id, family_id, action, actor, target_parent_id, detail JSONB, created_at
family_pending_members（新，第二階段）
  id, family_id, phone_canonical, relationship, created_by, created_at, expires_at, claimed_parent_id
```

- `parents.family_id`、`students.family_id` 不再使用（欄位保留），單一真相是 `family_members`。
- **migration 010 從沒接進開機流程**（只能手動 `npm run db:migrate`），乾淨資料庫開機不會有
  這兩張表。所以新的 DDL 放在 `server/bootstrap/admin.js`（**非凍結檔**），要寫成：
  完整的 `CREATE TABLE IF NOT EXISTS`（給乾淨庫）＋ `ALTER … IF NOT EXISTS`（給既有庫），
  並補進 `tests/bootstrap_clean_database_test.js`。不放進 `coreSchema.js`。
- **發布前先把同一段 DDL 套到 dev 庫**（Replit 發布會把正式庫改成 dev 庫的樣子）。
  發布對話框應只出現新增的欄位、約束、表，**不能出現任何 DROP**。
- `services/parentSync.js` 的 `PARENT_REFERENCE_SPECS` 已列出 `family_members.parent_id`，
  但目前沒有程式使用它；日後若接上「合併兩個家長帳號」，要先處理一人一家的唯一鍵衝突。

## 4. 核心模組 `server/services/familyScope.js`（新）

```
actingParentIds(client, parentId)  → [parentId] ∪ 同家庭 active 成員；開關關閉或家庭 frozen 時只回 [parentId]
actingPhones(client, parentId)     → 上述家長的電話（給以購買人電話判斷的查詢用）
familyOf(client, parentId)         → { familyId, role, relationship } | null
```

- 每個請求算一次，掛在 `req.family`，不寫進 JWT。
- 所有路由與服務層的改動都透過這三個函式，不在各處自己拼 SQL。

## 5. 逐路由修改清單

範圍：`server/routes/` 下掛 `requireParent`／`requireLiffUser` 的全部 **52 支路由**，加上註冊
1 支（`parents.js` POST /），逐支列出。⛔ 為凍結檔。

> 盤點方法的限制：先前用關鍵字找「這是不是你的」檢查點（149 處），會漏掉兩種寫法：
> 擁有權檢查寫在 helper 裡、以參數傳入家長（`checkout.js` 開頭的 helper），以及用
> `req.liffUser` 的聊天室（`chat.js`、`services/chatRooms.js`、`services/websocket.js`）。
> 本表已補上這兩處；**實作第一步要把服務層再掃一次**，確認沒有其他同類寫法。

### 第一階段：要改

| 路由 | 現在的判斷 | 改成 |
|---|---|---|
| `parents.js` GET /me（含模組層載入學員的函式） | 學員屬於本人 | 全家孩子，標示所屬家長與關係 |
| ⛔ `courses.js` GET /lessons、GET /mine、GET /:id | 購買人電話＝本人 或 `extra_parent_phones`；學員屬於本人 | 購買人電話 ∈ 全家電話；學員 ∈ 全家 |
| ⛔ `courses.js` POST /:id/payment-proof | 本人的訂單 | 全家的訂單 |
| ⛔ `courses.js` POST /:id/cancel | 本人 | 購買人或擁有者 |
| `checkout.js` GET /:checkoutId、POST /:checkoutId/payment-proof | helper：付款單屬於本人，或單內訂單電話＝本人 | 付款單屬於全家任一人，或單內訂單電話 ∈ 全家電話 |
| `checkout.js` POST /:checkoutId/cancel | 同上 | 下單人或擁有者 |
| `uploads.js` POST /payment-proof | 本人的付款單 | 全家的付款單 |
| ⛔ `checkins.js` POST /self、POST / | 學員屬於本人 | 學員 ∈ 全家（凍結政策 2「一方簽到＝整組生效、揭露簽到方全名」維持；簽到方記實際操作的成員） |
| ⛔ `slots.js` GET /period/:coursePeriodId、POST /:id/book | 學員屬於本人 | 學員 ∈ 全家；仍只能選教練已開放的時段（現行規則，決策 5）；凍結政策 1「即時 confirmed、不走同組確認」不變 |
| `groupOrders.js` GET /mine、GET /:id、POST /:id/my-proof | 本人在團內 | 全家任一人在團內即可查看、幫忙上傳付款資料（決策「成員可以付款」） |
| `learn.js` GET /history/:periodId | 學員屬於本人 | 學員 ∈ 全家 |
| `evaluations.js` GET /mine、GET /:id、POST /:id/submit | 本人 | 全家 |
| `chat.js` 全部 7 支（GET /rooms、GET /period/:coursePeriodId/room、GET /rooms/:id、messages 讀寫、upload、read） | `chatRooms.listRoomsForParent`、`chatRooms.canAccess`、`chat.js` 內的課期檢查：孩子的 `parent_id`＝本人 | 孩子 ∈ 全家；即時連線（`websocket.js` 經 `canAccess`）自動跟著生效；訊息以實際發話的成員具名 |

### 第一階段：不變

| 路由 | 理由 |
|---|---|
| `parents.js` PATCH /me、POST /me/sync | 本人資料 |
| `parents.js` POST /me/students | 加在本人名下、全家可見（決策 7）；也能新增自己為學員（現行只檢查姓名、生日、身分證格式，沒有年齡限制）；字號若已在同家庭 → 提示「這位孩子已在您的家庭中」 |
| `parents.js` PATCH /me/students/:id | 只有所屬家長能改（會寫回 Ragic） |
| `parents.js` DELETE /me/students/:id | 已固定回 405「請洽櫃臺」 |
| `transfers.js` 3 支 | 轉讓維持只限本人（§2） |
| `referrals.js` 2 支 | 推薦是個人的 |
| `onboarding.js` POST /claim | 功能導覽（feature tour）領取，與家庭無關 |
| `coaches.js` 2 支 | 教練公開資料，沒有擁有權 |
| `groupOrders.js` 草稿 3 支、POST /by-token/:token/lookup-phone、POST /:id/submit、POST /:id/cancel | 草稿是個人的；送審與取消團只限團主 |
| `enrollments.js` POST /、`checkout.js` POST /route | 第二階段 |

### 第二階段

| 路由 | 改成 |
|---|---|
| `enrollments.js` POST / | 學員 ∈ 全家；訂單購買人＝下單的成員 |
| `checkout.js` POST /route | 同上 |
| `groupOrders.js` POST /（開團）、POST /by-token/:token/join（參團）、GET /by-token/:token（邀請頁） | 學員 ∈ 全家；參團時現行「本人已在團內」（`ALREADY_MEMBER`）擴大為「家人已在團內」→ 擋下，一家在同一團只算一戶，不會拿到第二份優惠（決策 6）；邀請頁的「已加入」判斷一併擴大到全家 |
| `parents.js` POST /（註冊）與 auth 註冊流程 | 手機命中 `family_pending_members` → 註冊免填孩子、自動加入家庭 |
| 優惠 `services/promotions.js`、`services/referrals.js`、`enrollments.js` 的 TRIAL50 | 新客／試上資格以**家庭**為單位；私人券（`eligible_parent_id`）維持個人；櫃台連結家庭**不算推薦**；同家庭互推不給獎勵 |

**發票**：付款單發票以下單家長的手機分組（`services/checkoutFamilies.js`），第二階段成員自己
下單，發票自然開給成員。第一階段成員幫既有訂單付款時，發票預設沿用訂單上的資料；
發票資料本來就由櫃台開立時填寫（`routes/admin/checkouts.js`），要開給付款的家人由櫃台改填。

> 家教的購買紀錄**不會寫回 Ragic**（`ragicWriteback` 只回寫家長與學員基本資料），
> 所以成員下單不影響 Ragic。

## 6. 通知（決策 2 發全家；決策 8 的例外）

推播只有一個出口 `line.pushMessage`，全部呼叫點逐一決定：

| 呼叫點 | 內容 | 改成 |
|---|---|---|
| ⛔ `cron/index.js` L135（每小時整點） | 上課前 1 小時提醒 | 全家 |
| ⛔ `cron/index.js` L191（每天 09:00） | 堂數快到期提醒 | 全家 |
| ⛔ `cron/index.js` L299（每小時 :05） | 期末評鑑邀請與提醒 | 全家 |
| `services/checkinNotify.js`（家長段） | 簽到完成通知 | **只發給簽到的人**（`checkin_records.checked_in_by_parent_id`，決策 8）。櫃台補登沒有簽到的家長、以及同組其他家庭的孩子 → 照舊發給該孩子的所屬家長 |
| `routes/learn.js`（兩處） | 課程計畫、上課紀錄發布 | 全家 |
| `routes/admin/enrollments.js`（退回補件） | 報名被退回補件 | 全家（成員也能補傳付款證明） |
| `services/enrollmentNotify.js` | 報名成功（只推教練） | 不變 |
| `services/reconcileNotify.js`（**Email**，由 `admin/checkouts.js`、`admin/enrollments.js` 排入） | 對帳成功、發票 | 不變：只寄報名者（決策 8） |
| ⛔ `cron/index.js` L255（每天 09:30）、`services/referrals.js` | 推薦（MGM）相關 | 不變（個人） |
| `routes/groupOrders.js`、`services/groupOrderSubmit.js`、`routes/admin/groupOrders.js` | 團購 | 不變（依參與人） |
| `routes/transfers.js`、`routes/admin/transfers.js` | 轉讓 | 不變（當事人） |
| ⛔ `cron/index.js` L368（每天 10:30）、`services/ragicAdmin.js`、`services/ragicWriter.js`、`routes/admin/staff.js` | 給主管／員工 | 不變 |

- cron 的三個排程已用 `notification_log` 的 UNIQUE(kind, ref_id, recipient_uid) 防重複，
  改成全家後每位收件人各佔一筆，不會重複推。其他通知是事件觸發、一次性，逐一發給全家即可。
- **推播量會增加**（每個家庭多 1～3 人），受既有的每小時上限與 LINE 月額度保護；
  上線前先估算月用量（見 §12）。
- 家長端簽到推播（事件 `checkin_confirmed_parent`）目前在正式環境是**關的**：`/health`
  顯示只開了 `checkin_confirmed_coach`。收件人規則改好之後，何時打開另外決定。

## 7. 後台（櫃台在哪裡分家庭）

全部在左側選單「**客戶資料管理 →（Z01）家長 & 學員關係**」這一頁（`CustomerParentsPage.jsx`）
完成，不另開選單項目，權限沿用這一頁：

1. **家長清單**：新增「家庭」欄（例如「媽媽的家庭・3 人」），篩選列加「有無家庭」。
2. **家長編輯視窗**（清單右邊的「編輯」，`RagicZ01Modal.jsx`）：現在的
   「Family ID（家庭組・背景預留）」那一行換成「家庭」區塊——建立家庭（以此家長為擁有者）、
   用手機搜尋既有帳號加入成員並選關係、移除成員、轉移擁有者、凍結家庭、異動紀錄。
3. **「家庭建議」按鈕**（頁面上方，顯示待處理數，目前 24）：列出「同一個身分證字號掛在
   不同帳號」的孩子。點一筆 → 確認視窗預填擁有者（Ragic 上的家長）、成員、關係，以及要停用的
   重複學員 → 櫃台確認後才建立。系統只建議，不自動建立。

- 新端點 `/api/admin/families`：`requireAdminAuth` ＋ `requireResource('customer-parents')`；
  比照 `customerParents.js`，manager／staff 只能處理擁有者 `primary_venue_id` 在自己範圍內的家庭；
  轉移擁有者與凍結限 admin。
- 每次異動寫 `family_audit_logs`，並用 LINE 通知家庭所有成員。

## 8. 家長端（LIFF）

- 個人頁「我的家庭」：成員與關係；孩子依所屬家長分組。
- 我的課程、帳單：全家的，標示購買人。
- 簽到：全家的孩子都有簽到鈕。
- 預約：全家的孩子都能選教練已開放的時段。
- 團購（第二階段）：家人已在團內時，邀請頁顯示「您的家人已加入此團」，不再給加入鈕。
- 「身分證字號已存在」紅字改為引導：「這位孩子已登記在另一個家庭帳號下。如果是同一個家庭，
  請聯絡櫃台協助連結。」（併入紅字修改工作）

## 9. 既有 24 位孩子的搬遷

用後台「家庭建議」清單**逐家確認**，不做批次：

1. 建立家庭，擁有者＝孩子在 Ragic 所屬的那位家長，另一位以對應關係加入。
2. **18 位只有一份有課**：有課的那份就是 Ragic 上那份時，另一份停用（停用的學員不回寫
   Ragic，每晚的備份失敗就會停止）。有課的若是沒進 Ragic 的那份 → 列為個案，由櫃台跟
   Ragic 一起處理，不自動處理。
3. **5 位兩份都有課**：兩份都保留，家庭內都看得到；課程結束後再停用沒進 Ragic 的那份。
   **不搬課程**：搬課程會改到扣堂與簽到紀錄（凍結範圍），風險高於好處。
4. **1 位兩份都沒課**：保留 Ragic 上那份，另一份停用。
5. 試點：案例家庭（媽媽為擁有者、爸爸為成員；爸爸帳號那份重複學員生日填錯且無課程，停用）。

## 10. 測試

- **單元**：`familyScope` 的開關、frozen、一人一家、移除即時生效。
- **資料庫層**：§5「要改」的每支路由各一組「成員可以」與「非家庭成員仍被擋」；
  聊天室另測即時連線加入房間（`canAccess`）。
- **e2e**：成員簽到仍是整組生效（凍結政策 2）、櫃台手動扣課不受影響（凍結政策 3）、
  成員上傳付款證明（訂單、付款單、團購三條路）、移除後立即失效。
- **通知收件人**：成員簽到 → 只有簽到的成員收到；櫃台補登、同組其他家庭 → 照舊發給孩子的所屬家長。
- **第二階段**：家人已在團內時參團被擋；非家人照常可參團。
- **變異測試**：每一個「∈ 全家」條件拿掉，對應測試必須轉紅。
- 一律在 Replit 工作區（LF、Node 20.20）執行；本機 CRLF 會誤判原始碼比對類測試。

## 11. 發布與回滾

1. DDL 先套 dev 庫 → 發布（對話框只應有新增項目）→ 開關維持關閉。
2. 後台建立試點家庭 → 開啟開關 → 觀察一週（簽到、付款、推播量）。
3. 逐家處理其餘家庭。
4. **回滾**：關閉 `FAMILY_ACCOUNTS_V1` → 立即回到單一家長歸屬；家庭資料保留、不影響任何既有資料。

## 12. 風險

| 風險 | 處理 |
|---|---|
| 修改凍結檔（checkins.js、slots.js、courses.js、cron/index.js） | 決策 1、2、5 已同意簽到、通知、預約；courses.js 只改可見範圍，不動簽到欄位。實作前仍把 ⛔ 檔的每處修改列給擁有者確認；必須附凍結政策 1、2、3 的迴歸測試 |
| 盤點遺漏（helper 參數、`req.liffUser`、服務層） | 實作第一步重掃服務層；變異測試兜底 |
| 推播量增加、LINE 月額度與費用 | 上線前以現有家庭規模估算；既有每小時上限與額度保護 |
| 帳單隱私（匯款截圖、統編） | 依決策全家可見；家庭必須由櫃台確認建立 |
| 擁有者帳號被盜 | 櫃台可凍結家庭、轉移擁有者；成員異動都會通知全家 |
| 一人一家（決策 3）遇到跨多家的祖父母 | 第一版由櫃台個別處理 |

## 13. 已定案與解讀

第一版的四題已由擁有者回覆（2026-09-23，見決策 5～8）。以下兩點是依回覆做的解讀，
實作前如有不同再修正：

1. **團購「同一家庭同一團只算一戶」**：家人已在團內（團主或已參團），另一位家人再用邀請連結
   參團會被擋下，改由已在團內的那位處理。現行團購參團後不能再加孩子，所以家人要一起報，
   就由同一位一次把孩子選齊（第二階段成員可以選全家的孩子）。
2. **「簽到通知只發給簽到的人」只管自己家的孩子**：同組其他家庭的孩子，照舊通知那個孩子的
   所屬家長；櫃台補登沒有簽到的家長，也照舊通知孩子的所屬家長。
