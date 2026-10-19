# 業務規則後端執行盤點（D18／GitHub #13）— 2026-10-19

> 範圍：報名、團報、價格、簽到與扣堂、退費、請假／補課、到期提醒、評價門檻。
> 判準（Owner 定義）：**只有後端擋才算數**；前端擋只是體驗，不算執行。
> 方法：逐條從程式找出執行點（file:line），再用**真的打 API 或呼叫 service、對拋棄式 PostgreSQL 執行**的測試取證，不靠讀程式判斷。

## 證據來源（皆已登記在 `scripts/run-tests.js` 的 db 層，`TEST_DATABASE_URL=… npm run test:db` 會跑）

| 代號 | 測試檔 | 說明 |
|---|---|---|
| **BR** | `tests/business_rules_audit_db_test.js`（本次新增，67 項斷言） | 自建定價區／場館／教練／家長，in-process 掛 `/api/enrollments`、`/api/group-orders` 實打 API，或直接呼叫 service；finally 清除 |
| **GT** | `tests/e2e/rules_20261014_group_trial.js` | 試上比照正式課、團報人數＝組別、團報整團退費（掛報名、簽到、後台對帳／退費／團報／課程需求路由） |
| **D18a** | `tests/e2e/rules_20261014_d18_booking_cancel.js` | 預約過去時段、過期課期、整組取消 |
| **D18b** | `tests/e2e/rules_20261015_d18_remaining.js` | 一對五人數、團報教練／組別停用、轉讓、評價並發 |
| 其他 | `tests/expiry_reminder_scope_db_test.js`、`tests/coach_checkin_removed_test.js`、`tests/refund_reason_parity_test.js`、`server/test/refundFeeAmount.test.js`、`tests/course_tier_price_test.js` | 既有測試，本次確認通過 |

GT／D18a／D18b 原本只掛在 `tests/e2e/run_all.js`（那一層要先起 server，平常沒人跑）；它們其實是 in-process、只吃 `DATABASE_URL`，本次一併放進 db 層，讓規則有固定的回歸。

步驟代號對照（例如「BR H3」）見各測試檔的 `step(...)` 標題。

---

## 一、報名（個人／整組，`POST /api/enrollments`）

| # | 規則 | 執行點 | 判定 | 證據 |
|---|---|---|---|---|
| 1 | 一對二～一對六須**一次剛好選滿 N 位**（一般與試上相同；一對一不設限＝各自獨立的一對一） | `server/services/enrollmentRules.js:10-27`、`server/routes/enrollments.js:397-408` | 後端擋 | BR H2（一對三 2 位擋）、BR H3（一對六 5／7 位擋、6 位成立）、BR H4（試上一對六 5 位擋）、D18b P1/P2（一對五）、GT C1（一對二試上） |
| 2 | 課程需求的人數設定若與組別不符 → 整筆拒絕（fail-closed，不猜） | `enrollments.js:385-396` | 後端擋 | BR H1（一對六 max 存 5 → 409 `COURSE_CAPACITY_CONFIG_MISMATCH`） |
| 3 | 同一張單不可重複選同一學員 | `enrollments.js:418-430` | 後端擋 | BR R1 `DUPLICATE_STUDENT` |
| 4 | 學員須屬於本人或同家庭、且未停用 | `enrollments.js:431-441` | 後端擋 | BR R1（別人家學員 403 `STUDENT_NOT_AVAILABLE`） |
| 5 | 場館停用不可報名 | `enrollments.js:283-297` | 後端擋 | BR R3 `VENUE_INACTIVE` |
| 6 | 組別停用／該定價區沒開此組別不可報名 | `enrollments.js:299-318` | 後端擋 | BR R3 `COURSE_TYPE_INACTIVE` |
| 7 | 教練須在職、且有有效修課係數 | `enrollments.js:329-350` | 後端擋 | BR R3（教練停用 400） |
| 8 | 期數須落在定價區 min–max | `enrollments.js:364-373`、`server/services/coursePricing.js:88-99` | 後端擋 | BR R2（本區 1–3 期，送 4 期 → `PURCHASE_PERIOD_INVALID`） |
| 9 | 試上只限「已開放試上」的組別 | `enrollments.js:324-328` | 後端擋 | BR P6 `TRIAL_NOT_ENABLED` |
| 10 | 試上一律現場付費；一般報名不可選現場付費 | `server/services/trialEnrollment.js:32-39`、`enrollments.js:130-136` | 後端擋 | BR P5（試上送 bank_transfer 仍存 on_site）、BR P6 `ON_SITE_TRIAL_ONLY` |
| 11 | 家長只能取消「待付款」；整組報名取消＝同批同期一起取消；混到別的購買人不代取消 | `server/routes/courses.js:840-956` | 後端擋 | D18a K1–K8 |
| 12 | 報名開放時間窗（何時起／止可報名） | — | **都沒擋（系統無此規則）** | 程式中沒有任何報名期間欄位或判斷；列入「待 Owner 決定」 |
| 13 | 名額／額滿（單一教練收生上限） | — | **都沒擋（系統無此規則）** | 報名不佔時段；時段容量在預約時擋（見 #36）。列入「待 Owner 決定」 |
| 14 | 重複報名（同學員、同教練、同組別再買一次） | — | **都沒擋** | BR X2（第二次照常成立）。可能是刻意（續購）；列入「待 Owner 決定」 |
| 15 | 年齡／程度資格 | — | **都沒擋（系統無此規則）** | 學員資料沒有程度欄位，報名不讀生日；列入「待 Owner 決定」 |
| 16 | 試上次數上限（例如每位學員限一次） | — | **都沒擋（前後端都沒有）** | BR X1（同一批學員第二次試上照常成立）；列入「待 Owner 決定」 |

## 二、團報（`/api/group-orders`、後台 `/api/admin/group-orders`）

| # | 規則 | 執行點 | 判定 | 證據 |
|---|---|---|---|---|
| 17 | 一對一不開團報 | `server/routes/groupOrders.js:539` | 後端擋 | BR H5 `GROUP_NOT_ALLOWED_1V1` |
| 18 | 人數＝組別（一對三＝3、一對六＝6），以 `course_type` 為準，不看舊團存的 min | `server/services/groupOrderSubmit.js:26-30`、`groupOrders.js:50-58` | 後端擋 | GT B1（一對三存 2–3＝3、一對六存 5–6＝6） |
| 19 | 發起時一戶學生數不可超過組別 | `groupOrders.js:602-610`（本次補上 `code: 'OVER_CAPACITY'`） | 後端擋 | BR H5（一對六帶 7 位 → 400 `OVER_CAPACITY`，不建團） |
| 20 | 加入後總人數不可超過組別（`FOR UPDATE` 鎖團防並發） | `groupOrders.js:806-810, 879-894` | 後端擋 | BR H6（4＋3＞6 → 409 `OVER_CAPACITY`） |
| 21 | 送審須剛好滿團且每家付款資料齊（末 5 碼＋證明）；家長送審、自動送審、櫃檯代送審共用同一判斷 | `groupOrderSubmit.js:41-72`、`groupOrders.js:1195-1206`、`server/routes/admin/groupOrders.js:264-270` | 後端擋 | BR H7（6/6 缺付款 → `MISSING_PAYMENT_PROOF`；舊團 min 5、5 人 → `BELOW_MIN` 需 6）、GT B2 |
| 22 | 核准前再核一次人數（擋規則上線前已送審、人數不對的團） | `admin/groupOrders.js:372-386` | 後端擋 | GT B3 `GROUP_SIZE_MISMATCH`、不產生訂單 |
| 23 | 同一家庭在同一團只算一戶 | `groupOrders.js:850-866` | 後端擋 | BR H6（團主再加入自己的團 → `ALREADY_MEMBER`） |
| 24 | 發起後組別停用、該區不再提供、教練停用 → 不再接受加入；教練停用不能發起 | `groupOrders.js:581-587, 826-848` | 後端擋 | D18b G1–G4 |
| 25 | 團報整團一起退：退其中一家＝同團同期全部；未付款家庭改取消（付款單一併取消）；課期停用 | `server/routes/admin/enrollments.js:1653-1697, 1849-1935` | 後端擋 | GT A1/A2 |
| 26 | 「試上比照正式課」：試上同樣選滿人數、同批同堂開成同一共用課期、整班簽到、整班整期退 | `enrollments.js:381-408`、`admin/enrollments.js:1597-1634` | 後端擋 | GT C1–C6；團報流程本身不提供試上（無 `order_kind`），屬設計 |
| 27 | 團主才能取消，且只限揪團中／待審核 | `groupOrders.js:1243-1262` | 後端擋 | 程式（條件式 `UPDATE … WHERE status IN ('forming','submitted')`）；本次未另寫測試，風險低 |

## 三、價格

| # | 規則 | 執行點 | 判定 | 證據 |
|---|---|---|---|---|
| 28 | 金額一律後端重算，完全忽略前端送的 `original_price`／`final_price` | `enrollments.js:350-363, 451-462` | 後端擋 | BR P1（送 1 元 → 每筆 7200、付款單 28800） |
| 29 | 單期單生價＝級距明價，沒有明價才 `base_price × 係數` | `coursePricing.js:23-43, 71-76` | 後端擋 | BR P2（`{"1.20":7000}` → 7000）、`tests/course_tier_price_test.js` |
| 30 | 教練係數以 `admin_staff.multiplier` 優先、其次 `coaches.pricing_multiplier`；須 > 0，否則 409 | `enrollments.js:336-350`、`groupOrders.js:579-593` | 後端擋 | BR P4（1.50 蓋過 1.20 → 9000，快照 1.50）、BR G1（團報 3000×1.50＝4500） |
| 31 | 小計＝單價 × 學員數 × 期數；依「學員 × 期數」拆子訂單，堂數取定價區 | `enrollmentRules.js:39-55`、`enrollments.js:629-657` | 後端擋 | BR P1（2 位 × 2 期 → 4 筆、每期 6 堂） |
| 32 | 試上價＝`trial_price × 係數`（每人每堂）；`trial_price` 未設才以期價 ÷ 每期堂數推算 | `coursePricing.js:77-87`、`enrollments.js:442-449` | 後端擋 | BR P5（700 × 1.50＝1050；2 位 × 2 堂 → 4 筆、總額 4200、每筆 1 堂） |
| 33 | 試上不可用折價券 | `enrollments.js:464-468` | 後端擋 | BR P6 `TRIAL_COUPON_NOT_SUPPORTED` |
| 34 | 折價券驗證：啟用、期間、次數、適用組別／場館／期數門檻、指定家長；明確輸入的券失敗 → 整筆退回 | `server/services/promotions.js:153-196, 245-292`、`enrollments.js:497-519` | 後端擋 | BR P3（9 折生效、用量記一筆）、BR P3b（次數用盡、非指定家長 → 400 `COUPON_*`、不建單） |
| 35 | 折扣分攤：非負整數、總和精確等於整筆折抵 | `enrollmentRules.js:57-76`、`enrollments.js:612-626` | 後端擋 | BR P3（14000 折 1400 → 兩筆各 6300、合計 12600） |
| 36 | 團報單價在發起時鎖定快照，之後加入的家庭沿用；教練日後調價不影響 | `groupOrders.js:613-620, 291-325, 896-912` | 後端擋 | BR G1/G2（調價 1.50→2.00 後加入仍 4500×2＝9000） |
| 37 | 團報優惠在發起時鎖快照、每家獨立算 | `groupOrders.js:313-325, 622-660, 919-947` | 後端擋 | 程式；既有 e2e `group_auto_submit.js` 等需起 server，本次未跑。列為「待補測試」 |
| 38 | TRIAL50 推薦 5 折僅限受推薦新客、一次推薦一次（`FOR UPDATE` 序列化） | `enrollments.js:470-492, 664-676` | 後端擋 | 程式；既有 e2e `path_f_mgm.js` 需起 server，本次未跑。列為「待補測試」 |
| 39 | 加購（add-ons） | — | 不適用 | 系統沒有加購品項 |
| 40 | 櫃台手動建檔：金額須＝每人每期價 × 人數 × 期數、係數只可選 1.00／1.20／1.50／教練目前值 | `admin/enrollments.js:868-916`（🧊 手動建檔凍結區） | 後端擋 | 程式（凍結區，未改、未另測） |

## 四、簽到與扣堂（🧊 凍結區：只做唯讀驗證，未修改任何凍結檔）

| # | 規則 | 執行點 | 判定 | 證據 |
|---|---|---|---|---|
| 41 | 簽到／預約／手動扣課／後台改期前，都要驗課期與**來源報名**仍有效；來源已退費或取消 → 擋；找不到來源 → 擋（不 fail-open） | `server/services/courseEntitlements.js:70-139`；呼叫點 `server/routes/checkins.js:96, 362`、`server/routes/slots.js:300`、`server/routes/admin/manualDeductions.js:370`、`server/routes/admin/sessions.js:699` | 後端擋 | BR E1（有效 → 回名單；來源退費 → `ENROLLMENT_ENTITLEMENT_INACTIVE`；課期退費 → `PERIOD_ENTITLEMENT_INACTIVE`；無來源 → `ENROLLMENT_SOURCE_UNRESOLVED`） |
| 42 | 退費後不可再簽到：退費同交易把課期轉 refunded、取消未上課預約、釋出時段 | `courseEntitlements.js:141-158` | 後端擋 | GT A2（課期 refunded/MANUAL_REVIEW、未上課預約 cancelled_normal） |
| 43 | 課期過期不可自助簽到／預約（到期日當天仍可） | `checkins.js:91-95`、`slots.js:316-320` | 後端擋 | D18a E1/E2 |
| 44 | 已過去或已開始的時段不可預約 | `slots.js:329-334` | 後端擋 | D18a S1–S3 |
| 45 | 堂數用完不可再預約／簽到；手動扣課剩餘不足擋 | `slots.js:336-344`、`checkins.js:204-213`、`manualDeductions.js:404` | 後端擋 | 程式；既有 e2e `admin_manual_deduction.js`（凍結、需起 server）本次未跑 |
| 46 | 共享課期（家庭共班／團報／試上共班）一方簽到＝整班出席，整班共扣 1 堂；`usageSync` 為唯一同步入口 | `server/services/usageSync.js:23-45`、`checkins.js` | 後端擋 | GT C4（整班簽到一次 → 2 人出席、1 個課堂、兩張訂單各用 1 堂） |
| 47 | 教練端無簽到／扣堂路徑 | `server/routes/sessions.js`（全唯讀） | 後端擋 | `tests/coach_checkin_removed_test.js`（unit，通過） |
| 48 | 家長只能簽到今日課堂；同日不可重複自助簽到 | `checkins.js:224-233, 377-382` | 後端擋 | 程式（凍結區，未另測） |

## 五、退費（`/api/admin/enrollments/:id/refund`）

| # | 規則 | 執行點 | 判定 | 證據 |
|---|---|---|---|---|
| 49 | 申請原因：分類須在白名單、詳述必填 | `admin/enrollments.js:1739-1764` | 後端擋 | `tests/refund_reason_parity_test.js`（unit） |
| 50 | 已退費／已取消不可再退；試算後金額有變 → 409 請重算 | `admin/enrollments.js:1788-1796, 1934-1941` | 後端擋 | GT A2（已退的家庭再退 → 400） |
| 51 | 權益鎖：先以 advisory lock＋`FOR UPDATE OF cp` 鎖課期，再鎖訂單（與簽到同鎖序，防退費與簽到併發） | `courseEntitlements.js:28-68`、`admin/enrollments.js:1770` | 後端擋 | BR E2（可正常鎖定 1 個課期） |
| 52 | 身分核對：團報訂單缺家長識別、同一家長本期多筆有效 → 不自動退，交人工核對 | `courseEntitlements.js:50-64` | 後端擋 | BR E2（兩種情境都 `REFUND_IDENTITY_REVIEW_REQUIRED`） |
| 53 | 家庭共班／試上共班整期退（不支援退單一小孩） | `admin/enrollments.js:1597-1634, 1797-1847` | 後端擋 | GT C5 |
| 54 | 團報整團退 | 見 #25 | 後端擋 | GT A1/A2 |
| 55 | 手續費率 0–100%、固定手續費須非負整數、兩者擇一 | `server/services/refundReasons.js:43-60` | 後端擋 | `server/test/refundFeeAmount.test.js`（通過） |
| 56 | 只能退自己場館範圍的報名 | `admin/enrollments.js:1784-1787` | 後端擋 | 程式（權限層） |

## 六、請假／補課、到期提醒、評價、轉讓、課程需求設定

| # | 規則 | 執行點 | 判定 | 證據 |
|---|---|---|---|---|
| 57 | 家長請假／補課 | — | **都沒擋（系統無此流程）** | 家長端沒有請假或補課 API；`services/slots.js` 的 `cancelSession()` 是死碼，凍結令禁止接上。列入「待 Owner 決定」 |
| 58 | 櫃台撤銷逾時取消扣堂（cancelled_penalty → cancelled_normal） | `admin/sessions.js:553-610`（🧊 `POST /:id/revive`） | 後端擋 | 程式（凍結區，未改、未另測） |
| 59 | 到期提醒：只提醒有剩餘堂數、N 天內到期（`expiry_notice_days`，預設 60）、同期同家長只一次 | `server/cron/index.js:197-257`（🧊） | 後端擋 | `tests/expiry_reminder_scope_db_test.js`（db 層，通過） |
| 60 | 評價四項 1–5 星必填；超出範圍夾回 1–5 | `server/services/evaluations.js:80-92` | 後端擋（夾值、不拒絕） | BR T2（缺總評 400；9→5、0→1） |
| 61 | 同一份評價只能送一次（條件式 UPDATE 防並發） | `evaluations.js:83, 94-104` | 後端擋 | BR T2（409）、D18b V1（並發只生效一次） |
| 62 | 門檻設定：評分 0–5、續報率 0–1、視窗 1–24 月 | `server/routes/admin/learn.js:131-145` | 後端擋 | 程式（未另測） |
| 63 | 低於門檻 → 每教練每指標每月寫一筆告警，不重複 | `evaluations.js:219-274` | 後端擋 | BR T1 |
| 64 | 轉讓：過期課期不可申請；同一學員同一課期審核中不可重複 | `server/services/transfers.js:60-90` | 後端擋 | D18b T1/T2 |
| 65 | 課程需求人數＝組別：後台新增／編輯一律存 min＝max＝組別 | `server/routes/admin/courseTypes.js:160-165, 258-262` | 後端擋 | GT B4 |
| 66 | **（本次修正）** 規則上線前的舊列（一對三存 2–3、一對六存 5–6）開機時校正成組別，每筆寫稽核、冪等 | `server/services/courseTypeHeadcount.js`、`server/index.js:404-416` | 後端擋 | BR N1/N2（本區 2、3、6 校正；稽核記 5→6；第二次 0 筆） |
| 67 | **（本次修正）** 規則上線前排定的排程帶著舊人數，生效時一律存組別人數 | `server/services/courseTypeSchedule.js:30-37` | 後端擋 | BR N3（排程 min 2／max 2 → 仍是 3／3，價格照套用） |

---

## 本次修正

1. **`course_type_configs` 舊人數資料校正**（`server/services/courseTypeHeadcount.js`，由 `server/index.js` 開機時呼叫）。
   - 為什麼放這裡：判斷端（`requiredGroupSize`、`enrollmentRules`）與寫入端（`admin/courseTypes.js`）早已改成「人數＝組別」，缺的只是「規則上線前存進去、之後沒人編輯過」的舊列。這是資料校正、不是 schema 變更；`coreSchema.js` 的遷移／種子區塊屬凍結範圍，所以不放那裡。走寫入端（等櫃檯編輯）又不可靠——沒人編輯的列會永遠是舊值。
   - 性質：冪等（已正確的列不碰，第二次 0 筆）；advisory lock 序列化多實例開機；每筆寫 `course_type_config_audit_logs`（action＝`人數校正`、by_user＝`system`、記 before/after），後台「異動紀錄」看得到。
   - 失敗不擋開機但大聲記錄：判斷端只看組別、不讀這兩欄放寬人數；max 不符的組別個人報名本來就 fail-closed（#2）。
   - 副作用（正面）：櫃台手動建檔頁依學員數自動帶組別時讀 min／max（`ManualEnrollPage.jsx:349-352`），校正後 2 位學員不會再被一對三（存 2–3）搶先比對到。
2. **排程生效不寫回舊人數**（`server/services/courseTypeSchedule.js`）：pending_changes 裡的 min／max 一律以組別取代，稽核記實際寫入值。
3. **團報發起超額補上錯誤碼**（`server/routes/groupOrders.js:609`）：原本只回中文訊息，現在帶 `code: 'OVER_CAPACITY'`，與加入端一致。
4. **測試**：新增 `tests/business_rules_audit_db_test.js`；把三支既有的 in-process 規則 e2e 放進 db 層。

> 關於 Issue 列的已知缺口「一對五、一對六人數只有前端擋」：本次盤點時程式已經在後端擋（`enrollmentRules.js` 與 `groupOrderSubmit.requiredGroupSize`，2026-10-14／15 補上），只是一對六沒有測試、一對五只有 e2e（平常沒人跑）。本次以 BR H3／H4／H5／H6／H7 補齊一對六在個人報名、試上、團報發起、加入、送審的實測，並把一對五的 D18b P1/P2 放進 db 層。

## 「只有前端擋」：0 條

逐一對照 LIFF `EnrollmentPage.jsx`（人數、期數、試上清券）、`GroupCreatePage.jsx`（一對一導回、人數上限）、`GroupJoinPage.jsx`（剩餘名額）、`SlotBookingPage.jsx`（過去時段）後，前端擋的每一條在後端都有對應且已實測（#1、#8、#17、#19、#20、#33、#44）。

## 「都沒擋」與待 Owner 決定事項

| 項目 | 現況 | 建議／需要 Owner 決定的事 |
|---|---|---|
| #12 報名開放時間窗 | 系統沒有這個概念 | 是否需要「某期間才開放報名」？需要的話要先定義是全域、場館還是組別層級 |
| #13 教練收生上限／額滿 | 報名不限；時段在預約時才擋 | 是否要限制單一教練同時進行中的課期數？ |
| #14 重複報名 | 同學員同教練同組別可再買（BR X2） | 多半是刻意（續購、一次多期）。若要擋，要定義「重複」＝同教練同組別且仍有剩餘堂數的有效課期？ |
| #15 年齡／程度資格 | 沒有程度欄位，報名不讀生日 | 是否有組別要限制年齡或程度？ |
| #16 試上次數上限 | 前後端都沒有；同一批學員可重複試上（BR X1） | 要不要「每位學員（或每家庭）每位教練限試上一次」？這是金額相關，建議 Owner 決定後在 `enrollments.js` 試上分支加後端擋 |
| #57 請假／補課 | 系統沒有家長請假或補課流程；`cancelSession()` 為死碼且凍結令禁止接上 | 是否需要這個流程？若需要，屬「簽到／扣課」凍結範圍，必須 Owner 同意後另案設計 |
| 櫃台手動建檔人數 | 手動建檔不檢查學員數＝組別（前端只是依人數自動帶組別，可手動改） | 🧊 手動建檔凍結區（`admin/enrollments.js` 611–1004 行）。若要比照一般報名加後端擋，需 Owner 同意 |
| #60 評分超出範圍 | 後端夾回 1–5，不是拒絕 | 夾值不會寫進錯的分數，但家長送 0 星會被記成 1 星。是否改成拒絕？（非凍結，可直接改） |

## 凍結區：需 Owner 同意才能動的項目

| 位置 | 想改什麼 | 為什麼 |
|---|---|---|
| `server/bootstrap/coreSchema.js:2731-2738`（`seedCourseTypeConfigs` 預設值） | 新定價區的種子預設 `min_students` 由 1 改成組別人數 | 新開的定價區會先種出 min 1 的列，雖然開機校正（#66）會在同一次開機立即修正、不影響判斷，但種子本身與規則矛盾。是否屬凍結的「種子區塊」有疑義，故未動 |
| `server/routes/admin/enrollments.js` 🧊 手動建檔凍結區 | 學員數須＝組別（一對一除外），比照 `enrollmentRules.validateStandardStudentCount` | 見上表「櫃台手動建檔人數」 |

## 其他觀察（不屬規則缺口，留紀錄）

- 舊團（沒有購買價快照）核准時，係數只讀 `coaches.pricing_multiplier`、不讀 `admin_staff`（`admin/groupOrders.js:405-416`），與新報名路徑不同源；但同一團的畫面金額（`groupOrders.js:260, 901`）也用同一來源，畫面＝核准金額，所以不改。新團一律走快照。
- `tests/refund_entitlement_db_test.js`（db 層）與 `tests/trial_price_multiplier_test.js`（unit 層）在 main 上本來就失敗：前者的隔離 schema 與現行欄位不同步，後者還在比對 v7 之前的試上價 API 與前端正規式（前端現在共用 `resolveTrialUnitPrice`）。兩者測的規則（退費身分核對、試上價乘係數）本次已由 BR E2、BR P5 以真實資料庫取證；這兩支舊測試的修復不在本 Issue 範圍。
- #37、#38、#45 的既有 e2e 需要起 server，本次未跑；列為「待補 db 層測試」。
