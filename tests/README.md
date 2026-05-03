# Tests

Phase 8 測試套件。所有測試皆以 **本機 Node + curl + node-fetch** 為主，
不引入 Playwright / Jest 等重量級框架（Replit 環境跑得不順、上線前不需要 CI matrix）。

```
tests/
├── e2e/          # spec 8 條 E2E 路徑（A~H）的可重入腳本
├── perf/         # 效能基線：autocannon HTTP、WS latency、上傳成功率
└── flex/         # 18 種 Flex Message 觸發小工具（搭配 docs/flex_message_checklist.md）
```

## 跑法
```bash
# 預備：先確保 server 在跑
cd server && npm start &

# 預備：env 內提供測試帳號
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=...
export PARENT_PHONE=0900000000
export BASE_URL=http://localhost:3000

# 1. 全部 E2E
node tests/e2e/run_all.js

# 2. 個別路徑
node tests/e2e/path_a_purchase.js

# 3. 效能
bash tests/perf/run_http_baseline.sh

# 4. Flex 觸發
node tests/flex/trigger_all.js   # 互動式選單
```

> 本資料夾的腳本以「煙霧 / smoke」為設計目標：
> 每條腳本應在 < 60 秒內執行完，回傳 exit 0 / 1。
