# 效能基線報告（Phase 8）

## 目標（spec 8-4）
- 核心 API 回應時間 < 500ms（P95）
- WebSocket 訊息延遲 < 200ms（P95）
- 圖片 / 媒體上傳成功率 > 99%

## 量測工具
- HTTP 基線：`autocannon`（已加入 devDependency；如未安裝可改用 `npx autocannon`）
- WebSocket：手工腳本 `tests/perf/ws_latency.js`
- 上傳：`tests/perf/upload_smoke.js`（連續 100 次模擬上傳）

## 測試方法
本機（Replit Reserved-VM workspace，1 vCPU / 2GB）。執行：

```bash
# 預備：填入有效 JWT
export ADMIN_JWT="$(node tests/perf/login_admin.js)"
export PARENT_JWT="$(node tests/perf/login_parent.js)"

# 1. HTTP 基線（10 連線、30 秒、4 條核心路徑）
bash tests/perf/run_http_baseline.sh

# 2. WebSocket
node tests/perf/ws_latency.js

# 3. 上傳
node tests/perf/upload_smoke.js
```

## 結果（首次基線：2026-05-03，本機 Replit workspace、autocannon 10s/10conn）

### HTTP（autocannon, 10s, 10 conn, manager JWT）

| Endpoint | P50 (ms) | P95 (ms) | P99 (ms) | Avg RPS | 通過 |
|---|---|---|---|---|---|
| `GET /api/admin/enrollments` | 109 | 158 | 164 | 87.7 | ✅ P95<500 |
| `GET /api/admin/reports/revenue` | 4 | 7 | 8 | 2152 | ✅ P95<500 |
| `GET /api/admin/reports/sessions` | 4 | 8 | 9 | 2044 | ✅ P95<500 |
| `GET /api/admin/courseIntros` | 1 | 3 | 4 | 5135 | ⚠ 此路由不需 admin auth；以實際路由的 latency 為準 |

> 驗收：每列 P95 < 500ms — **PASS**（最慢一條 158ms，遠低於門檻）。

### WebSocket（handshake roundtrip，本機）

| 場景 | P50 (ms) | P95 (ms) | 通過 |
|---|---|---|---|
| `/ws` handshake (匿名連線即 close) | 2 | 5 | ✅ P95<200 |
| 1v1 chat ping→pong（20 次, parent JWT 自動 mint） | 0 | 2 | ✅ P95<200 |

> 驗收：P95 < 200ms — handshake + ping/pong 皆 **PASS**。
> ping/pong 工具：`tests/perf/ws_message_latency.js`，自動以 `JWT_SECRET` 簽 parent token + 從 DB 取一筆 `chat_room.id`，與生產 verify 路徑完全一致。

### 媒體上傳

| 檔案大小 | 成功 / 100 次 | 備註 |
|---|---|---|
| 200KB JPG | 待 UAT 用真 COACH_JWT 量測 | 已備好 `tests/perf/upload_smoke.js`，缺 token 時 exit 2 (fail-loud) |

> 驗收：成功率 > 99%。需 UAT 階段以教練 LIFF 取得 JWT 後跑 100 次量測；本機自動化跑會缺 token 而明顯失敗（不會誤判 PASS）。

## Ragic 快取 + 高併發實測
為避免高併發打爆 Ragic，`server/services/ragic.js` 已加入 in-process LRU + TTL 快取：
- `getActiveCoaches()` / `getCounterStaff()` / `getAllStaff()` / `getActiveVenues()`：TTL = 5 分鐘
- 寫回（`upsertParent`/`upsertStudent`）後會 invalidate 對應 key
- 失敗仍 fallthrough 到實際 Ragic API（不裝 Redis）

**壓測結果（`tests/perf/ragic_concurrency.js`，2026-05-03）**

| 情境 | requests | 外部 axios.get 實際呼叫 | 命中率 |
|---|---|---|---|
| 4 條熱讀函數 × 100 次並發 | 400 | 0（暖機後）/ 4（含暖機） | **100.0%**（門檻 ≥ 95%）|

> 驗收：高併發下 Ragic 對外呼叫被快取吸收 → ✅ PASS。
> 跑法：`node tests/perf/ragic_concurrency.js`（內建 axios stub，可離線跑）

## 持續監控建議
- Replit Deployment Metrics 開啟，留意 P99 latency 與 5xx
- 每月跑一次本套件，數據累積在本檔案下方歷史區

---

## 2026-10-19 本機沙盒基線（GitHub #15 第 2、4 步）——**不是正式環境數字**

> 環境：Claude Code 雲端沙盒，4 vCPU，Node v22.22.0，本機 PostgreSQL 16（拋棄式測試庫）。
> 伺服器以 `PREVIEW_SAFE_MODE=1`（排程關閉）、`NODE_ENV` 未設（dev）啟動，未設定 Ragic／LINE／SMTP。
> 客戶端與伺服器在同一台機器（無網路延遲、無 Replit 前端 proxy）。**這些數字只能拿來做前後對照，
> 不能拿來宣稱正式環境達標。** autocannon 不輸出 P95，以下如實列 P90／P97.5（見 `tests/perf/assert_autocannon.js`）。

### 量測腳本修正

`tests/perf/run_http_baseline.sh` 的第一條原本打 `/api/admin/courseIntros`，實際路由是 `/api/admin/course-intros`
（`server/routes/admin.js`）—— 這條一直是 404。第 0 步（`a061fbc`）讓失敗不再被回報成成功之後才看得出來，本次已修正。

### 暖機 API：`tests/perf/run_http_baseline.sh`（30 秒、10 連線、admin JWT）

資料 A：bootstrap + `DEMO_SEED=seed`（24 筆報名、4 位家長、8 位學員）

| Endpoint | 2xx | 錯誤 | 約 RPS | P50 | P90 | P97.5 | P99 |
|---|---|---|---|---|---|---|---|
| `GET /api/admin/course-intros` | 30,484 | 0 | 1,016 | 8 ms | 15 ms | 23 ms | 29 ms |
| `GET /api/admin/enrollments` | 15,067 | 0 | 502 | 17 ms | 29 ms | 38 ms | 45 ms |
| `GET /api/admin/reports/revenue` | 26,071 | 0 | 869 | 10 ms | 16 ms | 23 ms | 26 ms |
| `GET /api/admin/reports/sessions` | 23,444 | 0 | 781 | 11 ms | 19 ms | 26 ms | 30 ms |

資料 B：資料 A ＋ 5,040 筆合成報名（複製既有列、改 id／姓名／電話，總計 5,064 筆）

| Endpoint | 2xx | 錯誤 | 約 RPS | P50 | P90 | P97.5 | P99 |
|---|---|---|---|---|---|---|---|
| `GET /api/admin/course-intros` | 33,466 | 0 | 1,116 | 8 ms | 13 ms | 17 ms | 20 ms |
| `GET /api/admin/enrollments` | 162 | 0 | 5.4 | **1,362 ms** | **2,125 ms** | **6,264 ms** | **6,902 ms** |
| `GET /api/admin/reports/revenue` | 21,187 | 0 | 706 | 13 ms | 21 ms | 28 ms | 33 ms |
| `GET /api/admin/reports/sessions` | 20,685 | 0 | 690 | 13 ms | 22 ms | 30 ms | 35 ms |

> 判讀：報名清單沒有分頁，5,064 筆時單次回應 **4.3 MB**（未壓縮），10 連線下 P97.5 超過 6 秒，
> 不符 spec 8-4 的 P95 < 500 ms。其他三條不受資料量影響。

### 單連線暖機延遲（10 秒、1 連線；最接近「一次點擊等多久」）

| Endpoint | 資料 | P50 | P90 | P97.5 | P99 |
|---|---|---|---|---|---|
| `GET /api/admin/enrollments` | A | 4 ms | 5 ms | 7 ms | 9 ms |
| `GET /api/admin/reports/revenue` | A | 3 ms | 4 ms | 6 ms | 9 ms |
| `GET /api/admin/course-intros` | A | 1 ms | 2 ms | 4 ms | 6 ms |
| `GET /api/admin/enrollments` | B | **231 ms** | 277 ms | 291 ms | 300 ms |
| `GET /health`（10 連線，含 DB 探測） | A | 17 ms | 29 ms | 38 ms | 44 ms |

### 靜態資產（第 2 步）前後對照

| 請求 | 改版前 | 改版後 |
|---|---|---|
| `/admin/`、`/admin/dashboard`（HTML） | 200，`no-store` | 200，`no-store`（不變） |
| `/admin/assets/index-<hash>.js` | 200，`public, max-age=0`，**未壓縮 1,309,232 B** | 200，`public, max-age=31536000, immutable`，`Content-Encoding: br` **348,290 B**（同一份舊 bundle） |
| `/admin/assets/index-<不存在>.js` | **200 + index.html**（`text/html`） | 404 `text/plain`，`no-store` |
| `/liff/assets/index-<hash>.js` | 200，`max-age=0`，未壓縮 863,814 B | 200，immutable，br 230,205 B |
| `/liff/assets/nope-XXXX.css` | **200 + index.html** | 404，`no-store` |
| 切分後後台入口 chunk | — | br 84,176 B（raw 265,049 B） |
| 切分後 LIFF 入口 chunk | — | br 174,928 B（raw 588,153 B） |
| 本機傳送 1.3 MB 入口（單請求） | 9.4 ms（未壓縮） | 2.2 ms（br，已預壓） |
| 後台入口 chunk，10 連線 10 秒（br） | — | P50 15 ms／P99 40 ms，5,531 次 2xx |

- 壓縮用 Node 內建 zlib（**沒有新增 npm 依賴**）：brotli q6／gzip 9，每個檔案只壓一次、結果留在記憶體，
  開機後背景依序預壓（切分後兩支前端合計約 0.5 秒；舊的 27 個殘檔目錄約 2.6＋1.8 秒）。
  品質選 q6 是因為本機實測 1.3 MB bundle：q6 約 95 ms／348 KB、q9 約 330 ms／342 KB、q11 約 3.2 秒／316 KB，
  q11 在 Autoscale 冷啟動時太貴。
- 缺檔 404 由 #12 的 `server/middlewares/spaFallback.js` 負責；快取／壓縮在 `server/middlewares/staticFrontend.js`。
- **尚未驗證**：Replit 正式環境前面的 proxy 是否原樣轉送 `Cache-Control`／`Content-Encoding`，需在正式環境用 `curl -I` 確認。

### 重跑方式

```bash
# 拋棄式測試庫 + 排程關閉
PORT=3915 PREVIEW_SAFE_MODE=1 JWT_SECRET=<本機用> DATABASE_URL=<拋棄式測試庫> DEMO_SEED=seed node server/index.js
# dev bootstrap 的 admin/admin 帳號登入取得 token
ADMIN_JWT=<token> BASE_URL=http://localhost:3915 bash tests/perf/run_http_baseline.sh
```
