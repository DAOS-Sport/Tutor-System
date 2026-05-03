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

## 結果（樣板）

> 第一次跑完請把以下表格的 `__TBD__` 換成實測值，commit 進來作為基線。

### HTTP（autocannon, 30s, 10 conn）

| Endpoint | P50 | P95 | P99 | RPS | 錯誤率 |
|---|---|---|---|---|---|
| `GET /api/courses` (parent) | __TBD__ | __TBD__ | __TBD__ | __TBD__ | __TBD__ |
| `GET /api/admin/enrollments` | __TBD__ | __TBD__ | __TBD__ | __TBD__ | __TBD__ |
| `GET /api/admin/reports/revenue` | __TBD__ | __TBD__ | __TBD__ | __TBD__ | __TBD__ |
| `GET /api/courses/lessons` | __TBD__ | __TBD__ | __TBD__ | __TBD__ | __TBD__ |

驗收：每列 P95 < 500ms。

### WebSocket
| 場景 | P50 | P95 |
|---|---|---|
| 1v1 chat broadcast | __TBD__ | __TBD__ |
| 1vN slot confirm push | __TBD__ | __TBD__ |

驗收：P95 < 200ms。

### 媒體上傳
| 檔案大小 | 成功 / 100 次 | 平均耗時 |
|---|---|---|
| 200KB JPG | __TBD__ | __TBD__ |
| 2MB JPG   | __TBD__ | __TBD__ |

驗收：成功率 > 99%。

## Ragic 快取
為避免高併發打爆 Ragic，`server/services/ragic.js` 已加入 in-process LRU + TTL 快取：
- `getActiveCoaches()` / `getCounterStaff()` / `getAllStaff()` / `getActiveVenues()`：TTL = 5 分鐘
- 寫回（`upsertParent`/`upsertStudent`）後會 invalidate 對應 key
- 失敗仍 fallthrough 到實際 Ragic API（不裝 Redis）

## 持續監控建議
- Replit Deployment Metrics 開啟，留意 P99 latency 與 5xx
- 每月跑一次本套件，數據累積在本檔案下方歷史區
