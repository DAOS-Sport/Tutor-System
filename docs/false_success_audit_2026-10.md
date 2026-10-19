# 假成功與不明確路由稽核（2026-10，GitHub #12）

目標：**畫面說成功、實際沒做成的地方 = 0；因路由不明造成的誤導狀態 = 0。**
先前已修：Ragic webhook 部分失敗回 200、LINE 推播失敗當成功（不在本次範圍內重複列）。

迴歸鎖：
- `tests/false_success_audit_test.js`（unit，不連 DB）：未知 `/api` JSON 404、SPA fallback、路由表重複／遮蔽、
  「catch 之後回 2xx」與「吞錯 `.catch(() => {})`」的全庫掃描，以及本次每個修正點。
- `tests/false_success_db_test.js`（db，真實路由 handler + 拋棄式庫）：團購取消與優惠名額回沖同交易、
  系統設定先驗後寫。

狀態欄說明：**已修** ＝本次改掉並有測試；**可接受** ＝刻意的 best-effort／降級，理由寫在旁邊；
**凍結區** ＝落在 CLAUDE.md 凍結範圍內，只列不改，需 Owner 同意。

---

## 0. 總表

| 類別 | 盤點數 | 已修 | 可接受 | 凍結區（需 Owner） |
|---|---|---|---|---|
| A. 伺服器路由成功路徑 | 307 條 router 路由（58 個路由檔）+ `server/index.js` 直掛 7 條 | （見 A1／A2） | | |
| A1. 伺服器 `catch` 區塊（`server/routes/**`、`server/index.js`，修正後掃描） | 425 處 | 5 | 其餘全部 | 0（凍結檔內 6 處皆判定可接受） |
| A2. 伺服器非 catch 的假成功（0 筆更新仍回 200、未知 key 被略過、通知結果不回報、/health） | 15 處 | 6 | 9 | 0 |
| B. 前端成功訊息（toast.success／成功 callback／成功旗標） | 158 處 | 4 | 154 | 0 |
| B2. 前端誤導狀態（樂觀更新不回滾、讀取失敗顯示成空清單） | 24 處 | 5 | 19 | 0 |
| C. 重複／不明確路由 | 307 條逐一比對 + 5 個 catch-all + 2 個 SPA fallback | 2 | 6 | 1 |
| **合計** | | **22** | | **1** |

> A1 的 425 處裡 274 處本來就回 4xx/5xx；69 處是吞掉 `ROLLBACK` 本身的錯（原始錯誤之後照實回錯），
> 這兩類不逐條列；其餘逐條列在 §1.2。已修的 5 處是修正前的吞錯點（修完後已不是 catch-回成功）。

掃描方法（腳本未進 repo，結果見下表；可重現的部分已寫成 `tests/false_success_audit_test.js`）：
- 路由表：實際 `require` 每個 router、走訪 `router.stack` 展開成 method+path 清單，比對完全重複與「前面的參數路由遮蔽後面的固定路由」。
- 伺服器 catch：以括號配對切出每個 `catch (…) {…}` 與 `.catch(cb)`，分類為「回錯誤碼／ROLLBACK／只記 log／回成功」。
- 0 筆更新：每支 POST/PUT/PATCH/DELETE handler 內有 `UPDATE`/`DELETE` 卻完全沒有 `rowCount`／`rows[0]`／404／409 檢查者；以及 `UPDATE … RETURNING` 直接 `res.json(x.rows[0])` 而中間沒檢查者。
- 前端：用 `@babel/parser` 解析 `client/admin/src`、`client/liff/src`、`client/shared`，找出每個 `toast.success`、含「成功／已…」字樣的 `alert`、`setXxxSuccess(true)` 類旗標、`onSaved/onDone/onCreated/onMutated/onChanged…` 成功 callback，判定它是否位在「`await` 後端呼叫之後、同一個 `try` 內」。
  兩個前端 API 入口（`client/admin/src/api/client.js`、`client/liff/src/api/client.js`）都是 axios，非 2xx 一律 reject；
  正式 build 不會退回 mock（只有 `VITE_USE_MOCK=true` 或 dev 下的 501 才會）。直接用 `fetch` 的 3 處都有檢查 `response.ok`
  （`GuideTour.jsx:25`）或本身就是 best-effort（`DateTimePicker.jsx:67` 診斷回報、`useSpaVersionCheck.js:24` 版本偵測）。

---

## 1. 伺服器 `catch`（A1）

### 1.1 已修

| 位置 | 問題 | 修法 |
|---|---|---|
| `server/routes/coachPortal.js:373`（POST `/api/coach-portal/logout`） | 撤銷 portal session 失敗仍回 `{ ok: true }`（「撤銷失敗也視為已登出」）。token 仍在 DB、30 天內可換新 JWT，等於騙使用者「已登出」。 | 回 500 `LOGOUT_REVOKE_FAILED`。 |
| `server/routes/groupOrders.js:1255`（POST `/api/group-orders/:id/cancel`） | 優惠名額回沖是 COMMIT 後 `.catch(e => console.warn)`：失敗時畫面「團購已取消」，名額永遠被佔著。其他取消／退費路徑都同交易回沖，只有這裡不是。 | 取消 + 稽核 + `revertUsage` 同一交易；任何一步失敗整筆回滾、回 500。DB 測試 A1–A3。 |
| `server/routes/groupOrders.js:711`、`:955`（發起／加入團購的優惠 SAVEPOINT） | `catch (e)` 吞掉「任何」錯誤並降級成原價：DB 斷線之類的系統錯誤也被包裝成「本團不帶折扣，建立成功」。 | 只有 `COUPON_*`（名額滿、券失效）才降級；其他錯誤往外丟、整筆 500。 |
| `server/routes/promotions.js:19`（`resolveCoachMultiplier`，GET 試算） | 查詢失敗吞成 `null` → 被呼叫端回 409「教練修課係數尚未設定」，錯誤原因是假的。 | 拿掉 catch，DB 錯誤由路由回 500。 |

（A1 已修 5 處＝登出 1、團購取消回沖 1、團購優惠 SAVEPOINT 2、教練係數查詢 1。）

### 1.2 可接受（逐條）

**(a) 交易後的背景通知：主要動作已 COMMIT、回應已照實回，推播／通知失敗只影響通知。**
`LINE` 推播本身的失敗已在先前修正中寫入推播紀錄；這些 catch 只是不讓通知失敗把已成功的主動作變成 500。

| 位置 | 內容 |
|---|---|
| `server/routes/_chatNotify.js:14,49,80,84` | 聊天關鍵字警示推播主管 |
| `server/routes/groupOrders.js:735` | 建團後清草稿（失敗下次覆寫） |
| `server/routes/groupOrders.js:993,995,1177,1244` | 加入／自動送審／送審後通知團主與全團 |
| `server/routes/admin/groupOrders.js:293,760` | 櫃台代送審、退回補件通知 |
| `server/routes/admin/enrollments.js:2131` | 退回補件推播（不在手動建檔凍結區內） |
| `server/routes/admin/transfers.js:60,62`、`server/routes/transfers.js:56` | 轉讓審核結果通知 |
| `server/routes/family.js:160,255,308,345,386`、`server/routes/admin/families.js:75`、`server/routes/parents.js:609` | 家庭異動通知；`familyNotify.sendNotices` 內部逐筆記 log，外層 `.catch(() => {})` 只是保險 |
| `server/routes/learn.js:73,103,200,225` | 學習歷程發佈後推播家長 |
| `server/routes/chat.js:216` | 聊天關鍵字警示 |
| `server/routes/auth.js:417,425` | 登入時快取 LINE 顯示名稱、記錄來源 channel（不影響登入結果） |
| `server/routes/admin/enrollments.js:1563`、`server/routes/admin/checkouts.js:499` | 對帳後補聊天室；cron（`server/cron/index.js:128`）5 分鐘內會再補 |

**(b) 回應裡已明示降級狀態，前端有對應顯示。**

| 位置 | 內容 |
|---|---|
| `server/routes/admin/customerParents.js:259` | 解除 LINE 綁定：Ragic 清除失敗 → `ragic_cleared:false` + `note`，前端用警告色（`CustomerParentsPage.jsx:127`） |
| `server/routes/admin/staff.js:1334` | 重設密碼：LINE 通知失敗 → `notified:false` + `notify_error`；前端本次改成警告色（見 §3） |
| `server/routes/admin/ragicStaging.js:118` | 批次核准逐筆失敗 → `results.failed[]`；前端依數量顯示 success／warning／error（`RagicStagingPage.jsx:221`） |
| `server/routes/admin/ragicStatus.js:63` | Ragic 即時探測失敗 → `live_probe.ok:false`，狀態頁照實顯示 |
| `server/routes/parents.js:482,497` | 開頁同步失敗 → 回既有鏡像 + `sync_status: stale／not_found_in_ragic／error`（背景刷新，不宣稱成功） |
| `server/routes/auth.js:1650`、`server/routes/parents.js:879` | 推薦關係綁定失敗 → `ref_bound:false` + `ref_error`，註冊頁依此顯示（`RegisterPage.jsx:329-339`） |
| `server/routes/auth.js:546,561` | 回 `respond(4xx/5xx)`（掃描器誤判為 log-only） |

**(c) 讀取路徑的容錯，不宣稱寫入成功。**

| 位置 | 內容 |
|---|---|
| `server/routes/parents.js:119` | 個人頁的家庭區塊讀不到 → `family:null`（等同功能關閉，不影響個人頁其他資料）。後續建議：補 `family_unavailable` 旗標讓前端說明。 |
| `server/routes/parents.js:212` | 建學員前的 Ragic 家長查詢失敗 → 走後續既有流程，最後寫回失敗會由 `ragicError()` 回錯 |
| `server/routes/admin/courseTypes.js:125` | 讀清單前順手套用已到期排程；失敗時清單照實顯示「仍在排程中」，每日 cron 會再套 |
| `server/routes/auth.js:1710` | 舊路徑 `/api/auth/register`（前端已無呼叫者）電話撞號時 Z03 hydrate 失敗；回 `pending_review`，排程拉入 Z03 會補上 |

**(d) 背景同步 202 Accepted：回應明說「已排入」，不宣稱完成。**
`server/routes/admin/venues.js:81`、`server/routes/admin/staff.js:632`、`server/routes/admin/ragicStatus.js:217`。
其中 H01 員工同步的前端輪詢有誤判（見 §3 已修）。

**(e) 其他刻意設計。**

| 位置 | 內容 |
|---|---|
| `server/routes/diagnostics.js:61` | 前端診斷回報一律 204：診斷管道壞掉不可連累正在註冊的人（只收集，不對使用者宣稱任何事） |
| `server/routes/coaches.js:189` | 回 `guaiGuai.deny()`（錯誤回應） |
| `server/routes/coachPortal.js:155,180,204` | OAuth 失敗 → 帶 `error=` 參數導回前端登入頁 |
| `server/routes/learn.js` 其餘 13 處、`server/routes/family.js` 其餘 9 處 | 呼叫 `handle()`／`fail()` 回 4xx/5xx（掃描器誤判） |
| `server/index.js:30,36,130,150,163,176,270,344,384,392,411,418,426` | 啟動、build-info、/health 子區塊診斷、上傳串流錯誤（回 502）、關機流程；/health 主狀態見 §2 |

**(f) 凍結檔內的 catch（只列，判定可接受，未改）。**

| 位置 | 內容 | 判定 |
|---|---|---|
| `server/routes/checkins.js:281,443` | 簽到成功後通知櫃台畫面的 websocket 廣播 | 可接受：廣播只是即時刷新，櫃台頁重整即見 |
| `server/routes/admin/sessions.js:838` | 補簽到後的 websocket 廣播 | 同上 |
| `server/routes/admin/manualDeductions.js:509` | 手動扣課後的 websocket 廣播 | 同上 |
| `server/routes/admin/manualDeductions.js:513-536` | 唯一鍵衝突時查回原紀錄：payload 指紋相同 → `{ok:true, idempotent:true}`，不同 → 409 | 可接受：冪等重放，扣課確實已發生且未重扣；前端顯示「已確認原扣課操作，未重複扣除」 |

---

## 2. 伺服器非 catch 的假成功（A2）

| 位置 | 問題 | 狀態 |
|---|---|---|
| `server/index.js:182`（GET `/health`） | DB 探測失敗仍回 200 `status:'ok'`。啟動註解寫明「health=ok 代表 API 可使用」，部署平台與 `scripts/smoke-admin.sh` 只看狀態碼。 | **已修**：DB 失敗回 503 `status:'degraded'`、`database_ok:false`。 |
| `server/routes/admin/learn.js:90`（PATCH `/api/admin/learn/tags/:id`） | 找不到標籤回 200 + `null`，標籤頁跳「已儲存」。 | **已修**：404 `TAG_NOT_FOUND`。 |
| `server/routes/admin/settings.js:50`（PATCH `/api/admin/settings`） | 不認得的 key `continue` 略過仍回 200（前後端 key 名一對不上就「已儲存」但沒存）；邊驗邊寫，第 3 個值不合法時前 2 個已寫入卻回「儲存失敗」。 | **已修**：先全部驗證（未知 key 400 `SETTING_KEY_UNKNOWN`），再同一交易寫入。DB 測試 B1–B3。 |
| `server/routes/coaches.js:616`（PATCH `/api/coaches/:id/media/reorder`） | 不檢查每筆是否真的更新（清單過期或混入別人的 id），回 `count: ids.length`。 | **已修**：累計 `rowCount`，對不上整批回滾、409 `MEDIA_REORDER_STALE`。 |
| `server/routes/admin/checkouts.js:283`（POST `/api/admin/checkouts/:id/reconcile`） | 回應不含通知信結果；前端一律顯示「已記錄並推播家長」——家長沒 Email、SMTP 失敗、演練模式都長得一樣。 | **已修**：回應加 `notify { families, queued, not_queued, sent, dry_run, failed }`，前端照實顯示（§3）。 |
| `server/routes/admin/staff.js:623`（POST `/api/admin/staff/sync`） | 202 回應沒有可用來分辨「這一輪」的時間點（前端誤判見 §3）。 | **已修**：回 `accepted_at`。 |
| `server/routes/groupOrders.js:514`（DELETE `/draft`）、`server/routes/admin/learn.js:68,111`（DELETE 標籤分類／標籤） | 刪 0 筆也回 `ok:true`。 | 可接受：冪等刪除，目的狀態（不存在）已達成。 |
| `server/routes/admin/courseTypes.js:246`、`server/routes/admin/promotions.js:229,315`、`server/routes/admin/pricingZones.js:178`、`server/routes/admin/auth.js:367` | `UPDATE … RETURNING` 後直接 `res.json(rows[0])` 沒檢查 rowCount。 | 可接受：同一 handler 前段已 `SELECT` 確認存在（404 已處理）；剩下的只是極窄的並行刪除視窗。`promotions.js:315` 的狀態轉換 UPDATE 沒帶 `status` 條件屬並行／業務規則，交給 #13。 |
| `server/routes/admin/enrollments.js:1568`（POST `/api/admin/enrollments/:id/reconcile`，單筆舊對帳） | 同 checkouts 對帳，回應不含通知信結果。 | 可接受：目前前端沒有任何呼叫者（`enrollmentsApi.reconcile` 未被使用），沒有畫面會宣稱「已通知」。若日後恢復使用，比照 checkouts 加 `notify`。 |

---

## 3. 前端成功訊息（B）與誤導狀態（B2）

### 3.1 盤點

158 處成功訊號：`toast.success` 134、成功 callback／旗標 24。

| 判定 | 數量 | 說明 |
|---|---|---|
| 在 `await` 後端呼叫之後、同一個 `try` 內（axios 非 2xx 會 reject，進不到成功行） | 133 | 其中再逐一檢查「2xx 但 body 帶部分失敗／降級欄位」的 9 支：批次核准、Z03 存檔（`upgraded/synced_to_ragic/skipped`）、解除綁定（`ragic_cleared`）、重設密碼（`notified`）、對帳（`notify`）、退費（`group_shared`）、學員存檔（`sync_status/family_linked`）、註冊（`status/ref_bound`）、自助簽到（`error`）。除下表兩處外都已依欄位分流。 |
| 純本機動作（匯出檔案 8、複製到剪貼簿 5、「已套用到全班」1） | 14 | 不涉後端 |
| 子元件按鈕把資料交給父層（`onSave`／`onSubmit`），由父層 `try/await` 決定成敗 | 7 | `VenuesPage.jsx:66`、`CourseIntrosPage.jsx:40`、`RagicZ01Modal.jsx:53,197`、`RagicZ02Modal.jsx:63,208`、`CoachProfilePage.jsx:698` |
| 簽到結果 callback（失敗時帶 `error`，成功才顯示「簽到完成」） | 3 | `SelfCheckinModal.jsx:76,85`、`MyCoursesPage.jsx:395`、`MyLessonsPage.jsx:273`（簽到相關頁，未改） |
| websocket 事件通知 | 1 | `admin/CheckinPage.jsx:103`「新報到」：由後端已寫入的事件觸發（簽到頁，未改） |
| 手動建檔頁暫存提示 | 2 | `ManualEnrollPage.jsx:401,409`「已連結家長（暫存）」「已加入學員（隨報名單送出）」：文字本身就說是暫存、尚未送出（凍結檔，未改） |
| **有問題 → 已修** | 4 | 見 3.2 |

### 3.2 已修

| 位置 | 問題 | 修法 |
|---|---|---|
| `client/admin/src/pages/ReconcilePage.jsx:372,390` | 對帳成功一律「已記錄並推播家長／並分別推播」，不看通知結果。 | 依後端 `notify` 顯示：全部寄出 → success「已寄出 Email 通知家長」；有家庭沒 Email／寄送失敗／演練模式 → warning 逐項說明；舊後端沒有 `notify` → 只說「對帳通過」，不宣稱已通知。 |
| `client/admin/src/pages/StaffPage.jsx:208` | H01 同步輪詢只看 `in_progress`（單一行程記憶體旗標）。輪詢打到別台實例、或背景還沒開始時是 `false`，就把**上一輪**的結果當成這一輪顯示「已同步 N 筆」。 | 只認 `last_run_at ≥ accepted_at` 的那一筆；等不到就照實說「仍在背景執行中」。 |
| `client/admin/src/pages/StaffPage.jsx:138` | 重設密碼成功但 LINE 通知沒送到，用的是成功綠色，跟「已通知」長得一樣。 | 改警告色，並區分「發送失敗」與「未綁定 LINE 或無場館」。 |
| `client/liff/src/pages/CoachProfilePage.jsx:291`（B2） | 媒體排序先畫後存，存失敗只跳「排序失敗」，畫面停在新順序（教練以為改好了）。 | 失敗時退回原順序，顯示後端錯誤（含新的 409 `MEDIA_REORDER_STALE`）。 |
| `client/admin/src/pages/CustomerStudentsPage.jsx:39`、`CustomerParentsPage.jsx:66`（B2） | 篩選變動重抓失敗只清成空清單，沒有任何提示——跟「查無資料」一模一樣，會誘發重複建檔。 | 失敗時明確提示「空清單不代表查無資料」。 |
| `client/admin/src/pages/MgmStatsPage.jsx:68`（B2） | 統計讀取失敗 → `data=null` 無提示，看起來像「這段期間沒有推薦」。 | 失敗提示。 |
| `client/liff/src/pages/CoachHistoryPage.jsx:77`（B2） | 學員下拉讀取失敗無提示，看起來像名下沒有學員。 | 失敗提示。 |

（B 已修 4 處＝ReconcilePage 兩處、StaffPage 兩處；B2 已修 5 處＝CoachProfilePage、CustomerStudentsPage、CustomerParentsPage、MgmStatsPage、CoachHistoryPage。）

### 3.3 B2 可接受（19 處：次要下拉／輔助資料讀取失敗只清空，主要資料仍會報錯）

`StaffPage.jsx:146`、`CustomerParentsPage.jsx:46`、`ReportsPage.jsx:37,39`（場館／教練下拉）、
`CourseTypesPage.jsx:235`（加成級距欄，註解已說明）、`EditEnrollmentModal.jsx:72,97`、`CoachDetailModal.jsx:29,33`、
`ProfilePage.jsx:188`、`GroupOrdersPage.jsx:56`、`IncompleteGroupOrdersBanner.jsx:51`（首頁提示列）、
`GroupCreatePage.jsx:155,178`（草稿暫存／清除）。這些失敗時只是少一個選項或一段輔助資訊，不會讓使用者以為某個動作成功。
（手動建檔頁 `ManualEnrollPage.jsx:187,196,209` 與簽到頁 `CheckinPage.jsx:53` 同類，屬凍結檔，未改。）

---

## 4. 重複／不明確路由（C）

| 檢查 | 結果 | 狀態 |
|---|---|---|
| 同 method+path 重複註冊 | 307 條中 0 條 | 無發現；測試鎖住 |
| 參數路由遮蔽後面的固定路由（如 `/:id` 擋掉 `/stats`） | 0 條 | 無發現；測試鎖住 |
| 未知 `/api/*` | 掉到 Express 內建 404，回 HTML「Cannot GET …」，前端拿不到 `.error`／`.code` | **已修**：`server/index.js:105` 掛 `apiNotFound`（`server/middlewares/spaFallback.js`），一律 JSON 404 `API_NOT_FOUND` |
| SPA fallback `/admin/*`、`/liff/*` | 任何子路徑都回 `index.html` 200：舊 bundle 要已刪除的 `/admin/assets/index-舊hash.js` 拿到 200 + HTML → 白畫面但 log 全是 200；`/liff/api/...` 誤打也「成功」拿到 HTML | **已修**：`server/index.js:279-280` 改用 `spaFallback()`：`/assets/*`、帶靜態副檔名者回 404，`/admin/api/*`、`/liff/api/*` 回 JSON 404；真正的頁面路徑照舊回 `index.html` |
| `/health` | DB 掛了仍 200 ok | **已修**（§2） |
| `server/routes/admin.js:51`、`server/routes/auth.js:1724`、`server/routes/parents.js:903` 的 `router.all('*')` | 各自回 JSON 404 | 可接受 |
| `server/routes/ragicWebhook.js:57` 非 POST | 405 + 記錄 | 可接受 |
| `/auth/line/callback`（舊 LINE Console 相容入口）、`/r/:token`（MGM 短連結）、`/` | 明確 303/302 導向 | 可接受 |
| `/mcp` | 獨立 router（MCP 工作區），不在 `/api` 下 | 可接受（本次未動） |
| `server/routes/courses.js:966` 的 `router.all('*')` | 未知 `/api/courses/*` 回 **501 Not implemented**，而不是 404。正式環境下訊息錯（不是「沒實作」而是「打錯路徑」）；dev 下 `callApi` 遇 501 會退回 mock，等於 dev 假成功。 | **凍結區，需 Owner 同意**：`courses.js` 列在凍結令「涉及檔案」中。建議改成 404 `{ error, code:'API_NOT_FOUND' }`，風險極低（只影響本來就不存在的路徑）。 |

---

## 5. 凍結區清單（需 Owner）

| 位置 | 建議改什麼 | 為什麼 |
|---|---|---|
| `server/routes/courses.js:966` | `res.status(501)` → `res.status(404)`，加 `code:'API_NOT_FOUND'` | 未知路徑誤報為「未實作」；dev 下觸發 mock 退回造成假成功 |

其餘落在凍結檔內的項目（簽到廣播、手動扣課冪等重放、簽到頁 toast、手動建檔頁暫存提示與下拉載入）判定為可接受，不需修改。

---

## 6. 前端 build

本次改了 `client/admin/src`（ReconcilePage、StaffPage、CustomerStudentsPage、CustomerParentsPage、MgmStatsPage）
與 `client/liff/src`（CoachProfilePage、CoachHistoryPage），`server/public/{admin,liff}` 需要重新 build；
重建結果另以獨立 commit 提交（見交付說明）。部署時 `scripts/build-frontends.sh` 也會重建。
