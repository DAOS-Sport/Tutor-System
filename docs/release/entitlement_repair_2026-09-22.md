# 課程權益一致性 —— 歷史資料修復計畫（2026-09-22）

適用分支：`fix/tutor-audit-20260918`（Draft PR #8 的後續修補）
正式環境版本：`76a5d51`。**本文所列程式修補一行都還沒上線。**

資料來源：正式資料庫**唯讀**查詢，查核時間 2026-09-22（台北）。
本文只記錄課期／學員的 UUID 與程式行為，不含姓名、電話等個資。
**未對正式資料執行任何異動。**

---

## 0. 為什麼要先看這份

本輪補了四道守門（T1／T2／T4／T5，見 §4）。
其中 **T2 改成 fail-closed**，上線後會讓 §2 那 3 個課期的自助簽到與扣堂
**立刻回 409**。這不是錯誤，是刻意的安全行為 —— 但如果沒有先處理，
櫃檯會在發布當天收到「家長簽不進去」的反應。

所以順序是：**先處理 §1–§3 的資料，再發布程式。**

---

## 1. T1：停學學員仍掛在有效名單上（4 筆 / 3 課期 / 2 名學員）

| course_period_id | student_id | 簽到模式 | total / used |
|---|---|---|---|
| `9110bd60-6a94-4350-98b9-b9626ebd0f20` | `66dd17e1-17e4-4554-9b54-0414ce97bbd8` | self | 12 / 0 |
| `9110bd60-6a94-4350-98b9-b9626ebd0f20` | `8ea5fc6f-0b90-4ade-b375-41632e71e153` | self | 12 / 0 |
| `d83a487b-5ca4-4731-8d62-cafff70fc1df` | `66dd17e1-17e4-4554-9b54-0414ce97bbd8` | self | 12 / 0 |
| `ff92aea6-d3d5-43da-8288-b1899c6ac796` | `66dd17e1-17e4-4554-9b54-0414ce97bbd8` | self | 6 / 0 |

四筆**全部**落在「名單含 2 個以上家長」的跨家庭共享課期 —— 這正是慧娟案的形狀：
守門看到別家小孩還有效就放行，最終寫入卻依 `is_active` 過濾，
結果是「回 201 成功、出席落在別人家小孩身上或一筆都沒寫」。

**判斷要做什麼，不要先動手。** 兩種情況要走不同路：

- **學員其實該復學**（帳號解綁重綁那一類，例如慧娟案）
  → 由櫃檯在後台把 `students.is_active` 改回 true。
  資料就自然一致，不需要碰 `course_period_enrollments`。
- **學員確實停學不再上課**
  → 把該學員在這些課期的 `course_period_enrollments.status` 改成非 `active`
  （沿用現有的退出狀態值，不要自創）。

上線後這兩種情況都不會再有「看得到但用不了」的中間態：
停學學員會在守門就被擋，錯誤碼 `STUDENT_ENTITLEMENT_INACTIVE`，訊息明確。

`used_sessions` 全為 0，**沒有已經錯扣的堂數要追回**。

---

## 2. T2：課期查不到來源報名（4 個課期）— 發布前必須先處理

四個課期的 `admin_enrollment_id` 全是 `NULL`，也沒有 `group_order_id` /
`enrollment_batch_id` 可以對回任何一筆 `admin_enrollments`。

| course_period_id | 課期狀態 | entitlement | 簽到模式 | total / used | 名單人數 | 未取消課堂 |
|---|---|---|---|---|---|---|
| `184fc15c-798e-4bbc-9ddf-799667434130` | active | ACTIVE | self | 6 / 0 | 1 | 1 |
| `b6a355a9-18ca-408a-bb19-b8af89e0f39b` | active | ACTIVE | self | 6 / 0 | 1 | 1 |
| `ba4c1d34-3c34-42da-b195-abb25c69f530` | active | ACTIVE | self | 6 / 0 | 1 | **6** |
| `584990d2-ae87-47fe-9ea5-b875d6d913d2` | completed | ACTIVE | self | 6 / 6 | 1 | 0 |

**今天的行為**：這 4 個課期完全繞過退費守門（`linked.length === 0` →
`closed.length === 0` → 一路放行）。前 3 個是 active + 自助簽到，隨時簽得進去。

**上線後的行為**：一律 409 `ENROLLMENT_SOURCE_UNRESOLVED`。

**發布前要做的事（逐筆，不可批次）**：
1. 查清楚這 4 個課期當初是怎麼建出來的（人工建檔？舊版匯入？來源報名被刪？）。
2. 能對回來源報名的 → 把 `admin_enrollment_id` 補正確，守門自然通過。
3. 對不回來、但確認是有效已付費課程的 → 需要一個**有稽核紀錄**的例外機制，
   不要為了讓它通過而把守門改回 fail-open。
4. 確認是廢資料的 → 依現有流程關閉課期。

**另外有一筆帳目不一致**：`ba4c1d34` 有 6 堂未取消課堂但 `used_sessions = 0`，
`584990d2` 是 0 堂課堂卻 `used_sessions = 6`。**名義剩餘堂數不得直接當成實際已使用**
（Issue #4 完成條件第 3 點），這兩筆要人工核對堂數真相後才能動。

---

## 3. T4：家庭共班（`enrollment_batch_id`）部分退款

**本輪實測結論：目前正式庫沒有任何一筆處於部分退款狀態。**
272 個家庭共班課期中，266 個兄弟訂單全未退、6 個全退，**部分退款 0 筆**。

所以 T4 是**潛在風險，不是正在流血**。但那 6 個全退的課期有另一個問題：

| 狀況 | 課期數 | 課期狀態 | entitlement_state |
|---|---|---|---|
| 兄弟訂單全部退款 | 6 | refunded | **ACTIVE** |

`status='refunded'` 但 `entitlement_state` 還是 `ACTIVE` —— 這就是 Issue #4
說的「已退款課程期仍標 ACTIVE」。這 6 筆**現在就已經被 `period.status !== 'active'`
擋住了**，不是可簽到的缺口；但狀態欄不一致會讓報表與修復腳本兩邊看到不同事實。

**建議**：由 `revokeRefundedPeriods` 的既有邏輯把它們收斂成 `MANUAL_REVIEW`，
或人工逐筆核對後更新。**不要批次重置。**

---

## 4. 本輪的程式修補（兩個檔案、四處）

| 代號 | 檔案 | 改了什麼 | 為什麼 |
|---|---|---|---|
| **T1** | `server/services/courseEntitlements.js` | 名單查詢排除 `is_active = false` 的學員；唯一例外是**名單裡已經沒有任何在籍學員時**、被呼叫端明確指名的那一位（可能是單人課期，也可能是全員停學的共享課期） | 原本 `JOIN students` 卻不看 `is_active`，造成「守門放行、最終寫入過濾」的相反語意。例外是為了保留 `admin/manualDeductions.js` 既有且有註解的行為：停用學員的補登仍要留下出席紀錄，否則扣課會變成無出席的幽靈 session。注意 `manualDeductions.js` 的註解寫的是「單人課期」，但實作條件是「名單裡沒有任何在籍學員」—— 以程式為準 |
| **T2** | 同上 | `linkedEnrollments` 回空 → 拋 409 `ENROLLMENT_SOURCE_UNRESOLVED` | 原本查不到來源報名就等於沒有退費狀態可查，`closed.length === 0` 一路放行，Issue #4 想堵的情境完全沒防線 |
| **T4** | 同上 | 家庭共班部分退款 → 拋 409 `REFUND_IDENTITY_REVIEW_REQUIRED`，不再用「來源報名已退費或取消」擋還在付費的兄弟 | `admin_enrollments.students` 只存姓名、沒有 student UUID，無法把「哪一筆報名退了」對應到「哪一個學員」。不靠姓名猜（程式原本的註解就明令禁止），也不對付費家庭謊稱已退費 |
| **T5** | `server/routes/checkins.js`（**凍結檔，已取得擁有者同意**） | 預約制簽到 `POST /` 呼叫守門時加 `{ requireActiveStudent: true }` | 原本停用學員會放行 → 寫入依 `is_active` 過濾成 0 筆 → **COMMIT 之後**才讀 `ins.rows[0]` 撞 undefined 拋 500，結果是「堂數扣了、出席沒有、家長看到錯誤」 |

**T1 一處就關掉多個入口的原因**：5 個簽到／扣堂入口
（`checkins.js` ×2、`slots.js`、`admin/sessions.js`、`admin/manualDeductions.js`）
全部都用 `assertCourseEntitlement` 的回傳名單過濾實際寫入
（`cpe.student_id = ANY($n::uuid[])` 或 `.includes(id)`）。
本輪逐一讀過並確認 —— **沒有任何入口繞過這個名單**。

---

## 5. 行為變更（擁有者已於 2026-09-22 同意，逐項實測確認）

| 入口 | 情境 | 改前 | 改後（實測） |
|---|---|---|---|
| 櫃檯手動扣課 | **單人**課期、學員停用 | 201、寫出席 | **201、寫出席**（完全不變） |
| 櫃檯手動扣課 | **共享**課期、指名的學員停用 | 201、出席寫給別人或寫 0 筆 | **409 `STUDENT_ENTITLEMENT_INACTIVE`、零寫入** |
| 櫃檯補簽到 | 共享課期、一人停用一人有效 | 兩人都寫出席 | **200、出席只寫給有效那位、仍只扣 1 堂** |
| 櫃檯補簽到 | 單人課期、唯一學員停用 | 寫出席 | **409、零寫入、課堂狀態不動** |
| 家長自助簽到 `POST /self` | 停用學員 | 201「成功」但出席落在別人身上或 0 筆 | **409 `STUDENT_ENTITLEMENT_INACTIVE`、不建幽靈課堂** |
| 家長預約制簽到 `POST /` | 停用學員 | **500、堂數已扣、出席 0 筆** | **409、課堂維持 confirmed、`session_deducted=false`** |
| 家庭共班部分退款 | 一位兄弟退款 | 整期擋成「你已退費」 | **409 人工覆核**（目前正式庫 0 筆） |

凍結令逐條確認：第 1、2、4、5、6、7 條不受影響；第 3 條（櫃台手動扣課＝整班簽到
語意、共享課期不得重新加回硬擋）相鄰 —— 共享課期「整班簽到」語意保留（見上表
補簽到那列：一堂 session、整班出席、共扣 1 堂），新增的擋門只針對**停用學員**與
**部分退款識別歧義**，不是對共享課期本身的硬擋。

迴歸鎖：
- `tests/course_entitlement_is_active_db_test.js`（14 案例，含並行／重送／故障）
- `tests/counter_entitlement_routes_db_test.js`（4 案例，櫃檯兩入口的真實路由）
- 既有 `tests/e2e/admin_manual_deduction.js`（整班簽到語意）與
  `tests/e2e/path_c_group_confirm.js`（團報即時確認）本輪實測皆**通過**。

---

## 6. 本輪**沒有**做的事

- 沒有對正式資料做任何異動（全程唯讀 SELECT）。
- 除已獲同意的 `server/routes/checkins.js` 一處外，沒有修改任何凍結清單內的檔案。
- 沒有補造不存在的歷史操作紀錄。
- 沒有部署、沒有合併 PR、沒有關閉 Issue、沒有 git commit。
- Issue #1／#2／#6／#7 **沒有獨立驗證**，本輪只確認 `ragic_incremental_sync_test`
  在基準版本以相同訊息失敗（既有問題，非 PR #8 造成）。

### 歷史受害者查核：0 筆

T5 修掉的那個缺陷（扣了堂卻沒有出席）在正式庫**從未真的發生過**：

```sql
SELECT count(*) FROM course_sessions cs
 WHERE cs.session_deducted = TRUE AND cs.status::text NOT LIKE 'cancelled%'
   AND NOT EXISTS (SELECT 1 FROM checkin_records cr
                    WHERE cr.course_session_id = cs.id AND cr.attendance_status = 'ATTENDED');
-- → 0
```

原因是有停用學員掛在有效名單上的 3 個課期全是 `self` 簽到模式、名單 2–3 人，
走不到 `POST /`（預約制）那條路。T5 修的是**潛在**缺陷，不是正在流血的傷口。
