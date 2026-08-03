# 自動時段供給（模組 1）— 上線與回退

## 這是什麼

家教預約從「教練逐格建立時段」反轉為「系統依場館營業時間自動產生、教練關掉不能上的」。

**時段語意**：`generated_by='auto'` 且 `venue_id IS NULL` 的列代表「這位教練這個時間有空」，
場館在家長預約當下由 `course_period.venue_id` 認領（`bookSlot1v1` 的 `COALESCE`）。
教練手建的時段仍帶 `venue_id`，行為完全不變。

## 開啟前置條件（全部完成才可開）

| # | 項目 | 狀態 |
|---|---|---|
| 1 | 教練可關閉時段的 UI | ✅ `SlotActionSheet`「封鎖此時段」 |
| 2 | 教練可重新開放 | ✅ 同上「解除封鎖」 |
| 3 | 已有預約時的關閉保護 | ✅ `/block` 有 `AND status='available'`，UI 也顯示唯讀說明 |
| 4 | 家長首次提示 | ✅ `needs_booking_notice` + `POST /period/:id/ack-notice` |
| 5 | 取消與異常處理 | ✅ `DELETE /booking/:sessionId`（24h）+ 逾時未簽到 cron |
| 6 | 完整權限驗證 | ✅ 教練端 `requireCoach`+owner、家長端 `requireParent`+ownership |
| 7 | 旗標同時控制三入口 | ✅ `config/slotSupplyFlags.js` |
| 8 | canary 教練／館別 | ✅ `SLOT_GEN_CANARY_COACH_IDS` / `_VENUE_IDS` |
| 9 | 場館營業時間可維護 | ✅ `GET/PUT /api/admin/venue-hours`（admin/manager）|
| 10 | 測試帳號端到端驗證 | ⚠️ **部分**：後台場館營業時間頁已在 dev 真機走過（存檔／持久化／兩種驗證失敗態／休館日 CRUD）；教練端與家長端 LIFF 尚未真機驗證 |
| 11 | 前端頁面（營業時間設定、首次提示彈窗、取消按鈕）| ✅ 三者皆已製作：`VenueHoursPage`、`SlotPicker` 的 `ConfirmModal`（+ `ackBookingNotice`）、`MyLessonsPage` 取消鈕 |
| 12 | 家長端首次預約流程可用 | ⚠️ **待真機驗證**：`ackNotice` 曾經只 ack 不預約（每個課期第一次預約靜默失敗），已修並加結構迴歸檢查，但尚未在真瀏覽器走過一次 |
| 13 | E2E 有被 runner 執行 | ✅ 三支已納入 `tests/e2e/run_all.js`，並加漏網檢查；先前完全沒被執行過 |

**第 10、12 項未完成前不得開啟。**

> 這份清單本身出過事：第 11 項在彈窗與取消鈕都做完之後仍寫著「尚未製作」，
> 而它是唯一的放行依據。改動前端後請一併回來更新這張表。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `SLOT_GEN_ENABLED` | 未設＝關 | 總開關。只認 `'1'`，其餘一律關閉（fail-closed）|
| `SLOT_GEN_CANARY_COACH_IDS` | 空＝全體 | 逗號分隔的教練 UUID 白名單 |
| `SLOT_GEN_CANARY_VENUE_IDS` | 空＝全體 | 逗號分隔的場館 ID 白名單，例如 `B,K` |
| `SLOT_GEN_DAYS` | 21 | 產生未來幾天 |
| `SLOT_GEN_SCOPE` | `active-periods` | `all` 擴大到所有在職教練（約 12 萬筆，慎用）|
| `BOOKING_CANCEL_DEADLINE_HOURS` | 24 | 家長可自行取消的期限 |
| `BOOKING_NO_SHOW_GRACE_MINUTES` | 120 | 課後多久未簽到才自動復原 |

## 分階段上線

```
① SLOT_GEN_ENABLED=1
   SLOT_GEN_CANARY_COACH_IDS=<1 位教練的 uuid>
   → 隔日 02:30 只為那位教練產生；觀察一週

② 擴大到 SLOT_GEN_CANARY_VENUE_IDS=B（單一場館）
   → 觀察家長預約行為、教練關班比例

③ 移除 canary 變數 → 全體適用
```

每一階段觀察：家長預約成功率、教練關班筆數、`SLOT_UNAVAILABLE`／`SLOT_TAKEN` 409 次數、
前台 API 延遲。

## 回退（由輕到重）

### 1. 立即停止（不刪資料）

```bash
# Replit Secrets 移除或設為 0
SLOT_GEN_ENABLED=0
```

三個入口同時關閉：cron 不再產生、家長端查詢濾掉 NULL venue 的時段、
直接打 `/book` 也回 409 `SLOT_SUPPLY_DISABLED`。**既有預約完全不受影響**
（已預約的槽位 `venue_id` 已被認領，不是 NULL）。

### 2. 清除未被預約的自動時段

```sql
BEGIN;
-- 先確認筆數，且必須全部是 available / 無預約
SELECT count(*) FROM coach_availability_slots
 WHERE generated_by='auto' AND status='available' AND venue_id IS NULL
   AND booked_session_id IS NULL
   AND id NOT IN (SELECT availability_slot_id FROM course_sessions WHERE availability_slot_id IS NOT NULL);

DELETE FROM coach_availability_slots
 WHERE generated_by='auto' AND status='available' AND venue_id IS NULL
   AND booked_session_id IS NULL
   AND id NOT IN (SELECT availability_slot_id FROM course_sessions WHERE availability_slot_id IS NOT NULL);

-- 刪除後：auto 應為 0，教練手建（generated_by IS NULL）數量不得改變
SELECT (SELECT count(*) FROM coach_availability_slots WHERE generated_by='auto') AS remaining_auto,
       (SELECT count(*) FROM coach_availability_slots WHERE generated_by IS NULL) AS coach_made;
COMMIT;
```

**絕不可刪 `generated_by IS NULL`（教練手建）、`status='booked'`、`status='blocked'` 的列。**
若刪除前後數字不符或出現非 available 狀態，`ROLLBACK`。

### 3. 程式碼回退

模組 1 全部在 branch `feature/auto-slot-supply`。main 不含任何時段功能。

### 4. Schema

migration 038/039 是純新增（新表 + 可空欄位），**不需要 rollback**。
未啟用時那些欄位就是沒人寫、沒人讀。為了讓 diff 好看而刪正式庫欄位，風險遠大於收益。

## 已知副作用（使用者已接受）

逾時未簽到會自動復原容量，因此「開課前 <24h 不可取消」對決定不出席的家長沒有約束力，
而教練仍會到場。這是刻意選擇的寬鬆政策，不標 `no_show`、不做課程鎖定。

## 尚未完成

- 端到端測試帳號驗證
- 後台場館營業時間設定頁（API 已就緒）
- 家長端首次提示彈窗與取消按鈕（API 已就緒）
- 教練操作影片