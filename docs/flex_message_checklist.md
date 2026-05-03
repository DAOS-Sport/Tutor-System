# Flex Message 全項驗證清單（18 項）

對應 `docs/flex_messages.md` 規格。模板實作於 `server/services/line.js`（`templates.*`）。
本表用於 Phase 8 上線前逐項煙霧測試；每次驗證後請更新「最後驗證」欄位。

> 觸發測試方式：
> - 後端有 cron 的項目 → 將 `cron/index.js` 的時間調為 `*/2 * * * *` 後本機跑 30 秒驗證；驗完還原。
> - 操作觸發者 → 用 admin / LIFF UI 走完流程，到 `notification_log` 確認 1 筆寫入。
> - 接收方 LINE 收到推播且 Flex 顯示正常（header 色、按鈕可點），即視為通過。

| # | spec 名稱 | 觸發點 | 模板函數 (`templates.*`) | 接收者 | Header 色 | 最後驗證 | 結果 |
|---|---|---|---|---|---|---|---|
| 1  | 報名成功                | `routes/payments.js` 末5碼送出後                 | `enrollmentSuccess`        | 家長            | `#15316a` | __PENDING__ | ☐ |
| 2  | 課程開通                | `routes/admin/enrollments.js` reconcile 通過    | `courseActivated`          | 家長            | `#31aeab` | __PENDING__ | ☐ |
| 3  | 1v1 選槽成功            | `routes/sessions.js` book 1v1                    | `slotBooked`               | 家長            | `#97bf36` | __PENDING__ | ☐ |
| 4  | 1vN 同組確認邀請        | `routes/sessions.js` book 1vN（A 後）            | `groupConfirmInvite`       | 同組其他家長    | `#15316a` | __PENDING__ | ☐ |
| 5  | 1vN 時段確認成功        | 同 #4 路由分支：全員同意 / 60 分逾時自動         | `groupConfirmInvite`(成功色) | 全組家長        | `#97bf36` | __PENDING__ | ☐ |
| 6  | 1vN 時段拒絕            | 同 #4 路由分支：B 拒絕                           | `groupConfirmInvite`(拒絕色) | A 家長          | `#e8a020` | __PENDING__ | ☐ |
| 7  | 上課前 1 小時提醒       | `cron/index.js` 每小時整點                       | `sessionReminder`          | 家長 + 教練     | `#e8a020` | __PENDING__ | ☐ |
| 8  | 學員自助取消（給教練）  | `routes/sessions.js` cancel                      | `selfCancelToCoach`        | 教練            | 依類型      | __PENDING__ | ☐ |
| 9  | 堂數快到期提醒          | `cron/index.js` 每日 09:00                       | `expiryReminder`           | 家長            | `#e8a020` | __PENDING__ | ☐ |
| 10 | 課前規劃發布            | `routes/learn.js` plan publish                   | `coursePlanPublished`      | 家長            | `#c9a84c` | __PENDING__ | ☐ |
| 11 | 授課記錄送出            | `routes/learn.js` record publish                 | `sessionRecordPublished`   | 家長            | `#31aeab` | __PENDING__ | ☐ |
| 12 | 期末評鑑邀請            | `cron/index.js` 每日 10:00（最後一堂簽到當天）   | `evaluationInvite`         | 家長            | `#c9a84c` | __PENDING__ | ☐ |
| 13 | 期末評鑑提醒            | `cron/index.js` 每日 10:00（邀請後 7 天未填）    | `evaluationInvite`(reminder) | 家長          | `#e8a020` | __PENDING__ | ☐ |
| 14 | 轉讓申請通知            | `routes/transfers.js` POST /                     | `transferRequest`          | 場館主管        | `#15316a` | __PENDING__ | ☐ |
| 15 | 轉讓結果通知            | `routes/admin/transfers.js` approve / reject     | `transferReviewed`         | 雙方家長        | 依結果      | __PENDING__ | ☐ |
| 16 | 關鍵字警示              | `routes/chat.js` 送訊息時 `keywordScanner` hit  | `keywordAlert`             | 場館主管        | `#e24b4a` | __PENDING__ | ☐ |
| 17 | MGM 推薦成功            | `routes/admin/enrollments.js` reconcile（含 referrer）| `mgmRewardIssued`     | 推薦方家長      | `#97bf36` | __PENDING__ | ☐ |
| 18 | 體驗課今日提醒          | `cron/index.js` 每日 09:30                       | `mgmTrialTodayReminder`    | 被推薦家長 + 教練 | `#97bf36` | __PENDING__ | ☐ |

## 模板覆蓋說明
- `groupConfirmInvite` 函數透過參數同時涵蓋 spec #4/#5/#6 三種狀態的 header 色與文案。
- `transferReviewed` 透過 `result` 參數涵蓋 #15 的同意 / 拒絕雙色。
- `evaluationInvite` 透過 `isReminder` 參數同時涵蓋 #12 邀請與 #13 7 天提醒。
- 因此 `templates` 物件實際匯出 15 個函數，但 spec 計 18 種通知狀態，正確對應如上。

## 驗證流程
1. 啟動 `Start application` workflow，確認 `[Cron] All cron jobs initialized`。
2. 依上表逐列觸發；每觸發後到 DB 跑：
   ```sql
   SELECT type, target_uid, sent_at FROM notification_log
   ORDER BY sent_at DESC LIMIT 5;
   ```
3. 接收方 LINE 對話視窗實際收到 Flex 卡片且按鈕可正確 deep-link 進 LIFF / 後台。
4. 將該列「最後驗證」改為 `YYYY-MM-DD HH:mm` 並把結果欄改為 ✅；如有問題改 ❌ 並開 issue 追蹤。

## 已知缺口（上線前需補）
- spec 規定的 #6（1vN 拒絕）目前由 `groupConfirmInvite(amber)` 共用模板送出；上線前確認 LINE 端顯示文案是否需要拆出獨立函數。
- #13 期末評鑑 7 天提醒目前判斷邏輯：`reminder_sent_at IS NULL AND invited_at <= now() - 7 days`，請確認 cron 在凌晨 / 假日是否容許跳過一次。
