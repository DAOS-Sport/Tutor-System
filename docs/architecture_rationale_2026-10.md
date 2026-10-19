# 架構決策紀錄：三端效能與可靠性（GitHub #15）

- 日期：2026-10-19
- 狀態：**提案中**（決策方向已定；SLO 數值待正式環境基線確認）
- 範圍：Express 單體（`server/`）＋ 兩支 React/Vite 前端（`client/admin`、`client/liff`），由 `server/index.js` 以靜態檔供應
- 原則：**以量測為準**。本文件中任何「達標」都必須附證據；沒有證據的一律標「未量測」。
  100 ms 是「互動回饋」與「暖機後本機 API」的挑戰目標，**不是**冷開 LIFF 整頁載入的目標。

---

## 1. 現況（2026-10-19 量測，本機沙盒）

| 項目 | 現況 | 證據 |
|---|---|---|
| 部署形態 | 單一 Node 程序；Replit Autoscale；PostgreSQL；Ragic 為外部主檔 | `.replit`、`server/index.js` |
| 前端路由 | 兩支 `App.jsx` 全部頁面靜態 import → 每支只有一個 JS bundle | `client/*/src/App.jsx`（改版前） |
| LIFF 首屏 | `main.jsx` 先 `await liff.init()` 才 mount | `client/liff/src/main.jsx` |
| 後台 bundle（已提交產物） | 1,309,232 B raw／393,930 B gzip／316,472 B br | `server/public/admin/assets/index-BbJ0qmkZ.js` |
| 家長端 bundle（已提交產物） | 863,814 B raw／260,921 B gzip／207,421 B br | `server/public/liff/assets/index-DpKO7jAD.js` |
| 靜態資產快取 | `Cache-Control: public, max-age=0`（每次開頁都要條件請求） | `curl -I`，見 `docs/perf_baseline.md` 2026-10-19 節 |
| 靜態資產壓縮 | **無**（1.3 MB 原樣送出） | 同上 |
| 缺檔行為 | `/admin/assets/舊hash.js` 回 **index.html + 200**（#12 已修為 404） | 同上 |
| 暖機 API（10 連線，小資料） | 4 條核心路徑 p50 8–17 ms、p97.5 17–38 ms | `docs/perf_baseline.md` |
| 暖機 API（5,000 筆報名） | `GET /api/admin/enrollments` 單連線 p50 231 ms；10 連線 p50 1,362 ms、p99 6,902 ms；單次回應 4.3 MB | 同上 |

**觀察**：目前最大的效能問題不在架構分層，而在「送太多位元組」（前端單一 bundle、無壓縮、無長快取；報名清單一次回傳全部資料列）。這些都能在不動架構的前提下修掉。

---

## 2. 候選方案

### 方案 A：漸進式模組化單體（**採用**）

保持單一 Express 程序與單一資料庫，依業務切「垂直切片」，只在**確實有第二個實作或需要隔離外部系統**的地方加 port／adapter。

```
server/
  routes/            ← HTTP 邊界（維持現狀，逐步變薄）
  services/          ← 業務邏輯（已存在，按切片歸位）
  middlewares/       ← 橫切：auth、rate limit、靜態檔（staticFrontend.js）、SPA 兜底（spaFallback.js）
```

| 切片 | 目前主要檔案 | A 方案下的做法 |
|---|---|---|
| **Enrollment / Checkout**（報名、付款、對帳、退款、團報） | `routes/enrollments.js`、`routes/checkout.js`、`routes/groupOrders.js`、`routes/reconciliation.js`、`services/checkouts.js`、`services/enrollmentRules.js`、`services/coursePricing.js`、`services/groupOrderSubmit.js`、`routes/admin/enrollments.js`（含 🧊 手動建檔凍結區） | 規則已集中在 `enrollmentRules`／`coursePricing`；下一步只做「清單分頁＋欄位裁切」，不搬檔案。手動建檔凍結區不動。 |
| **Scheduling / Attendance**（課期、時段、簽到、扣課） | `routes/slots.js`、`services/slots.js`、`routes/checkins.js`、`routes/sessions.js`、`services/usageSync.js`、`services/deductionRevival.js`、`routes/admin/manualDeductions.js` | **🧊 全區凍結**（CLAUDE.md 2026-07-16／08-10）。A 方案在此區**零改動**；任何效能調整都需 Owner 先同意。 |
| **Identity / Ragic**（家長身分、Z01/Z02/Z03、同步 outbox） | `services/ragic.js`、`services/ragicAdmin.js`（5,135 行）、`services/ragicSyncOutbox.js`、`services/parentSync.js`、`services/z03IdentityClaim.js`、`routes/ragicWebhook.js` | 這是**唯一值得加 port 的地方**：Ragic 是外部系統、已有 stub 測試需求、且有 shadow/replay 雙路徑。做法是把 `ragicAdmin.js` 依「讀／寫／對帳」拆檔，對外介面不變。 |
| **Notification**（LINE 推播、Email、站內） | `services/line.js`、`services/mailer.js`、`services/pushGate.js`、`services/*Notify.js` | 已經是 adapter 形狀（`pushGate` 做 dry-run／限流）。維持現狀。 |
| **Admin**（後台設定、權限、報表） | `routes/admin/*.js`、`services/rolePermissions.js`、`services/permissionAudit.js` | 報表查詢若在正式量測中超標，再加索引或物化，不先動結構。 |

前端同樣維持兩支 Vite app，只做**路由層級切分**（本次第 3 步），不重寫、不換框架、不轉 TypeScript。

### 方案 B：完整六角形架構（僅作比較，**不採用**）

每個切片都拆成 `domain/`、`application/`（use case）、`ports/`、`adapters/`（http、pg、ragic、line），domain 不得依賴 Express 或 `pg`。

```
server/modules/enrollment/
  domain/        Enrollment, PricingPolicy
  application/   SubmitEnrollment, ConfirmPayment
  ports/         EnrollmentRepo, PaymentGateway, Notifier
  adapters/      http/, pg/, ragic/, line/
```

| 面向 | A | B |
|---|---|---|
| 對效能（#15 目標）的直接幫助 | 中性；效能來自位元組與查詢，不來自分層 | 中性；多一層呼叫幾乎不影響延遲，但也沒有幫助 |
| 改動量 | 小、可逐檔進行 | 大；幾乎每支 route 都要改寫 |
| 與凍結令的衝突 | 無（凍結區不動） | **直接衝突**：簽到／扣課與手動建檔都必須搬進新結構 |
| 測試 | 沿用既有腳本式測試 | 需重寫大量測試的載入路徑 |
| 風險 | 低 | 高；雙路徑並存期間容易出現「改一邊漏一邊」 |

---

## 3. 紅旗檢查

對兩案各自檢查三種已知會讓分層變成負資產的徵兆：

| 紅旗 | 說明 | A | B |
|---|---|---|---|
| **穿透層（pass-through layers）** | 一層只把參數原封不動轉給下一層 | 不新增層；只有 Ragic 加 port（真的有兩種實作：正式 API 與測試 stub／shadow） | ⚠️ 多數切片只有一個 DB、一個 HTTP 入口，`ports/` 與 `application/` 會大量變成純轉發 |
| **所有權分裂（split ownership）** | 同一條業務規則散在兩個以上模組，改一處要同步改另一處 | 規則留在既有 service（如 `enrollmentRules`、`usageSync` 唯一入口），不拆 | ⚠️ 搬遷期 domain 與舊 service 會同時持有規則 |
| **雙路徑（dual paths）** | 同一件事有新舊兩條路並存 | 只在前端 chunk 載入多了一條「重試 → 重新整理」的處理（`client/shared/chunkRetry.js`），有測試鎖住 | ⚠️ 遷移期必然新舊並存；簽到／扣課的「`usageSync` 唯一入口」原則會被破壞 |

結論：B 在三項都亮紅燈，且與凍結令正面衝突；A 都過。

---

## 4. 決策與停止條件

**決策**：採用 **方案 A**。不做微服務、不重寫、不轉 TypeScript、不上 Kubernetes。

**Redis**：Owner 允許，但**目前沒有證據需要**。Ragic 熱讀已有 in-process LRU（`services/ragic.js`，命中率 100%，見 perf_baseline）；暖機 API 的延遲瓶頸是資料量而非重複計算。只有在下列任一條成立時才重新評估：
1. Autoscale 多實例下，in-process 快取的不一致造成可重現的錯誤；或
2. 正式環境量測顯示同一查詢在多實例間重複計算，且佔 p95 一半以上。

**停止條件**（任一成立就停下來回報，不繼續往下做）：
- 某一步改動需要碰 CLAUDE.md 列出的凍結檔案（簽到／扣課、手動建檔）→ 停，列出要改什麼與為什麼，等 Owner 同意。
- 某一步改完後量測**沒有改善**（同條件下 p50／位元組數沒有變好）→ 回退，不留「也許有用」的改動。
- 某一步需要新增 npm 依賴才能完成 → 先寫建議、不加。
- 本機量測與正式環境的差距大到無法推論（例如正式環境前面有會改寫標頭的 proxy）→ 先補正式量測，再做下一步。

---

## 5. SLO（**提案值，待正式環境基線確認**）

下表數值是依本機沙盒量測與產品體感目標**提出**的，尚未經正式環境驗證。正式基線出來前，任何一列都不得宣稱「達標」。

| # | 指標 | 量測方式 | 提案目標 | 目前狀態 |
|---|---|---|---|---|
| S1 | 互動回饋（按下 → 畫面有反應：loading、按鈕 disabled、樂觀更新） | 瀏覽器 Performance／INP | p75 ≤ 100 ms | 未量測（需 RUM） |
| S2 | 暖機核心 API（單連線，正式資料量） | autocannon `-c 1` 或伺服器端 `Server-Timing` | p95 ≤ 100 ms | 本機小資料 PASS（p97.5 4–7 ms）；**本機 5,000 筆報名清單不達標（p50 231 ms）**；正式未量測 |
| S3 | 核心 API 併發（10 連線） | `tests/perf/run_http_baseline.sh` | p95 ≤ 500 ms（沿用 Phase 8 spec 8-4） | 本機小資料 PASS；5,000 筆報名清單 **FAIL**（p97.5 6,264 ms）；正式未量測 |
| S4 | 後台首屏可互動（暖快取，4G） | Lighthouse／WebPageTest | ≤ 2.5 s | 未量測 |
| S5 | LIFF 冷開首屏（含 `liff.init`） | LINE 內建瀏覽器實機 | ≤ 4 s（**非** 100 ms 目標） | 未量測 |
| S6 | 首屏 JS 傳輸量（壓縮後） | build 產物 + 伺服器 `Content-Encoding` | 後台 ≤ 120 KB、LIFF ≤ 200 KB | 本機 PASS：後台 84 KB br、LIFF 175 KB br（見第 6 節第 2、3 步） |
| S7 | 可用性 | `/health` 200 比例（DB 掛了回 503，#12） | 月 ≥ 99.5% | 未量測 |
| S8 | 5xx 比例 | Replit Deployment Metrics | 日 ≤ 0.1% | 未量測 |

---

## 6. Epic 七個步驟的狀態

狀態定義：**PASS** = 已完成且有量測證據；**PARTIAL** = 已做部分、或只有本機證據；**NOT_RUN** = 尚未開始。

| 步驟 | 內容 | 狀態 | 證據／備註 |
|---|---|---|---|
| 0 | 量測腳本不再把失敗回報成成功 | **PASS** | commit `a061fbc`（`|| true` 移除）；本次另修正腳本裡錯誤的 `/api/admin/courseIntros`（實為 `/course-intros`，一直回 404） |
| 1 | 架構決策紀錄（本文件） | **PASS** | 本文件 |
| 2 | 靜態資產傳送：長快取、HTML no-store、缺檔 404、壓縮 | **PARTIAL** | 本機前後對照見 `docs/perf_baseline.md`；`tests/static_frontend_headers_test.js`。正式環境前面的 proxy 是否保留／改寫這些標頭**尚未驗證** |
| 3 | 前端路由層級切分＋chunk 載入失敗處理 | **PARTIAL** | 本機 build 前後對照如下；`tests/route_code_splitting_test.js`。尚未在實機 LINE 內建瀏覽器驗證部署換版時的重整行為；產物由 lead 統一重建 |
| 4 | 暖機本機 API 基線 | **PARTIAL** | `docs/perf_baseline.md` 2026-10-19 本機沙盒節；**不是正式環境數字** |
| 5 | 正式環境基線（RUM／Deployment Metrics） | **NOT_RUN** | 需要正式環境存取 |
| 6 | 依基線修熱點（報名清單分頁、API 壓縮等） | **NOT_RUN** | 候選見第 7 節 |
| 7 | SLO 監控與回歸門檻 | **NOT_RUN** | 依第 5 節確認後設定 |

### 第 3 步 bundle 前後對照（本機 `vite build`，`VITE_USE_MOCK=false`；位元組數為實際檔案）

| | 改版前（同一份原始碼不切分） | 改版後 入口 chunk | 改版後 全部 JS 合計 |
|---|---|---|---|
| 後台 raw | 1,288.8 kB（vite 報告）／已提交產物 1,309,232 B | **265,049 B** | 1,357,574 B（53 個 JS chunk） |
| 後台 gzip | 406.2 kB（vite）／已提交 393,930 B | **88,824 B** | 449,869 B |
| 後台 br（q11） | 已提交 316,472 B | **77,222 B** | 382,003 B |
| LIFF raw | 860.1 kB（vite）／已提交 863,814 B | **588,153 B** | 919,652 B（46 個 JS chunk） |
| LIFF gzip | 276.3 kB（vite）／已提交 260,921 B | **190,493 B** | 314,454 B |
| LIFF br（q11） | 已提交 207,421 B | **159,450 B** | 264,605 B |

- 後台首屏 JS 降約 **80%**（gzip 394 KB → 89 KB）；LIFF 首屏降約 **27%**（剩下主要是 `@line/liff` SDK 與 React）。
- 後台 `csvExport` chunk（`xlsx` 函式庫）447 KB raw／150 KB gzip，只在有匯出功能的頁面才下載。
- 已提交的 `server/public` 產物與目前原始碼 build 結果不一致（後台差約 20 KB），代表產物落後於原始碼；正式部署時 `scripts/build-frontends.sh` 會重建，所以不影響線上，但比對時要注意。

---

## 7. 下一步候選（依預期效益排序，皆需先量測再動手）

1. **`GET /api/admin/enrollments` 分頁＋欄位裁切**：5,000 筆時單次回應 4.3 MB、單連線 p50 231 ms。GET 清單不在手動建檔凍結區（凍結區只含 `POST /api/admin/enrollments`），但改回應形狀會牽動 `EnrollmentsPage`，需一起改。
2. **API JSON 壓縮**：目前 API 回應未壓縮。若要用 `compression` 套件需新增依賴 → 依停止條件先提建議；替代方案是僅對 >64 KB 的 JSON 以內建 zlib 壓縮。
3. **`xlsx` 改為點擊匯出時才動態載入**：`client/admin/src/utils/csvExport.js` 改成 `await import('xlsx')`；呼叫端需改為 async。注意 `SessionsPage` 屬凍結區頁面。
4. **LIFF 首屏**：`@line/liff` 佔入口 chunk 大宗；教練路徑與 demo 路徑根本不 init LIFF，可評估在 `main.jsx` 動態載入 SDK（需實機驗證）。
5. **品牌 favicon**：`/brand/company-1b122f0a.png` 992 KB，每個頁面都會載入當 favicon；換成小尺寸圖檔即可，零風險。

### 7.1 處理狀態（2026-10-19 更新）

| # | 候選 | 狀態 |
| --- | --- | --- |
| 1 | 報名清單分頁 | 不改：手機版已經每批 50 筆；桌機版刻意一次載全部（篩選、匯出要用）。傳輸量交給 #2 處理 |
| 2 | API JSON 壓縮 | PR #30：只壓縮 ≥64 KB 的 JSON，用內建 zlib，沒有新增套件。本機 1,038,562 B → 34,282 B |
| 3 | xlsx 改成按下匯出才載入 | PR #29：5 頁改成動態載入（首屏 gzip 約少 130–150 KB）；凍結的 `SessionsPage` 不動 |
| 4 | LIFF SDK 動態載入 | **評估後暫不做**，原因見下 |
| 5 | favicon | PR #28：992 KB 換成 2.8 KB／13.8 KB 小圖 |

**#4 評估（`@line/liff` ^2.23）**

- 量測：SDK 單獨 minify 後 123,540 B，gzip 34,249 B。LIFF 入口檔（`index-*.js`）共 588,912 B，gzip 189,755 B，SDK 約占 18%。
- 誰會受益：只有教練端（`/liff/coach*`）與 demo 路徑，因為這兩條不會 init LIFF。家長端是主要使用者，一進來就要 `liff.init`，SDK 一樣得先下載，沒有省到。
- 要改哪裡：有 5 個檔案靜態 `import liff`。只有 `GroupStatusPage` 是 lazy chunk；另外 4 個都在入口檔裡，都得改：
  - `main.jsx`：家長端啟動時要 `liff.init`，改成先 `await import('@line/liff')`。
  - `api/client.js`：只有在 request 回 401、要靜默重新驗證時（`silentReauthParent()`，本身已是 async）才呼叫 `liff.getIDToken()`，一般 request 只帶 localStorage 裡的 JWT。在這裡動態載入，不影響其他 API 呼叫。
  - `LoginPage`、`RegisterPage`（`App.jsx` 同步 import）：要改成 lazy 頁面，或把裡面的 `liff.*` 呼叫改成動態取得。`LoginPage` 有「只刷一次 token」守衛，屬登入核心流程。
- 代價：家長端是主要使用者，首屏會多一段「入口檔下載完 → 再下載 SDK chunk → 才能 `liff.init`」的串接等待。在 LINE 內建瀏覽器加行動網路下，這通常比省下的 34 KB 還慢。
- 風險：LINE 內建瀏覽器的 init 與 redirect 時序只能靠實機驗證，本機沙盒做不到。
- 結論：教練端與 demo 省約 34 KB gzip，代價是家長端首屏多一段等待，暫不做。若之後教練端首屏變成瓶頸，可以照上面 4 個檔案的做法改，並在 LINE 實機量家長端首屏有沒有變慢再決定；或把教練端拆成獨立入口。

