# Tests

Phase 8 測試套件。所有測試皆以 **本機 Node + curl + node-fetch** 為主，
不引入 Playwright / Jest 等重量級框架（Replit 環境跑得不順、上線前不需要 CI matrix）。

```
tests/
├── e2e/          # spec 8 條 E2E 路徑（A~H）+ Flex 18 結構驗證（皆於 run_all.js 內）
└── perf/         # 效能基線：autocannon HTTP、WS handshake/ping-pong、Ragic 高併發、上傳成功率
```

## npm 入口（分層）

```bash
cd server
npm test          # unit：19 支零外部相依測試 + server/test 的 node:test；隨時可跑
npm run test:db   # 需 TEST_DATABASE_URL 指向拋棄式測試庫（含 DELETE，刻意不吃 DATABASE_URL）
npm run test:e2e  # 委派 tests/e2e/run_all.js：需 TEST_DATABASE_URL（與 DATABASE_URL 不同庫，否則拒絕），會自己用測試庫起 server
npm run test:server  # 只跑 server/test 的 node:test（原本的 npm test）
```

分層清單在 `scripts/run-tests.js`。**新增測試檔若未列入清單，`npm test` 會直接失敗**，
避免測試被靜默漏掉。

## 跑法（手動，個別執行）
```bash
# 預備：先確保 server 在跑
cd server && npm start &

# 預備：env 內提供測試帳號
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=...
export PARENT_PHONE=0900215261
# export BASE_URL=http://localhost:3000   # 只有打既有 server 時才設，並搭配 E2E_EXTERNAL_SERVER=1
export TEST_DATABASE_URL=postgres://...  # 拋棄式測試庫；沒設或與 DATABASE_URL 同庫時直接拒絕

# 1. 全部 E2E
node tests/e2e/run_all.js   # 自己用測試庫起 server（安全模式）；要打既有 server 需確認它連測試庫並加 E2E_EXTERNAL_SERVER=1

# 2. 個別路徑
E2E_EXTERNAL_SERVER=1 node tests/e2e/path_a_purchase.js   # 先確認 BASE_URL 的 server 連的是測試庫

# 3. 效能
bash tests/perf/run_http_baseline.sh

# 4. Flex 觸發
# Flex 結構：已併入 run_all.js (Flex18 步驟)
```

> 本資料夾的腳本以「煙霧 / smoke」為設計目標：
> 每條腳本應在 < 60 秒內執行完，回傳 exit 0 / 1。
