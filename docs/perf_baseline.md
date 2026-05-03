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
| 1v1 chat ping→pong | 待 UAT 用真 PARENT_JWT+ROOM_ID 量測 | — | — |

> 驗收：P95 < 200ms — handshake **PASS**；ping/pong 需 UAT 階段以真實 token 補測（已備好 `tests/perf/ws_latency.js`，提供 `PARENT_JWT`/`ROOM_ID` 即可）。

### 媒體上傳

| 檔案大小 | 成功 / 100 次 | 備註 |
|---|---|---|
| 200KB JPG | 待 UAT 用真 COACH_JWT 量測 | 已備好 `tests/perf/upload_smoke.js`，缺 token 時 exit 2 (fail-loud) |

> 驗收：成功率 > 99%。需 UAT 階段以教練 LIFF 取得 JWT 後跑 100 次量測；本機自動化跑會缺 token 而明顯失敗（不會誤判 PASS）。

## Ragic 快取
為避免高併發打爆 Ragic，`server/services/ragic.js` 已加入 in-process LRU + TTL 快取：
- `getActiveCoaches()` / `getCounterStaff()` / `getAllStaff()` / `getActiveVenues()`：TTL = 5 分鐘
- 寫回（`upsertParent`/`upsertStudent`）後會 invalidate 對應 key
- 失敗仍 fallthrough 到實際 Ragic API（不裝 Redis）

## 持續監控建議
- Replit Deployment Metrics 開啟，留意 P99 latency 與 5xx
- 每月跑一次本套件，數據累積在本檔案下方歷史區
