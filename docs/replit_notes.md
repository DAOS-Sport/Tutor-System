# Replit 開發注意事項

## 1. 必備設定

### Replit Secrets（環境變數）
在 Replit 左側 🔒 Secrets 面板設定所有 `.env.example` 中的變數。
**不要**將 `.env` 檔案提交至版本控制。

### PostgreSQL
Replit 提供內建 PostgreSQL。在 Replit 中：
1. 點選左側「Database」建立 PostgreSQL 資料庫
2. 複製 `DATABASE_URL` 至 Secrets
3. 初次／變更 schema 前先備份並審核 migration；production 不可在每次部署盲跑
   `npm run db:migrate`（現有 runner 會重跑目錄中的 SQL）

### Replit Object Storage（媒體檔案）
1. 在 Replit 中啟用 Object Storage
2. 設定 `REPLIT_OBJECT_STORAGE_BUCKET` Secrets
3. production 未覆寫時會自動選 Replit driver，並在 listen 前執行 SDK bucket probe；若明確設成 `local`，startup 會 fail closed
4. 使用 `@replit/object-storage` npm 套件上傳媒體

> Autoscale 的本機檔案系統不會跨實例或重部署保存。正式付款證明、聊天媒體與教練圖片不可依賴 `server/uploads/`；發布前需實際測試 upload → reload → read。

```js
const { Client } = require('@replit/object-storage');
const client = new Client();
const result = await client.uploadFromBytes('filename.jpg', buffer);
if (!result.ok) throw new Error('object upload failed');
```

## 2. PORT 設定
Replit 自動分配 PORT，確保 server 使用：
```js
const PORT = process.env.PORT || 3000;
```

## 3. Always On（保持服務運行）
- 免費版 Replit 會在閒置後休眠
- 建議申請 Replit Core 或使用 UptimeRobot 每5分鐘 ping 一次
- Cron Job 需要 Always On 才能正常運作

## 4. LIFF 開發注意

### LIFF 必須在 HTTPS 環境
Replit 自動提供 HTTPS 域名。本專案正式網址：
`https://daos-tutoring-courses.replit.app`

### LINE LIFF URL 設定
在 LINE Developers Console 設定 **2 個** LIFF App（家長端 + 教練端，掛在同一個 LINE Login Channel 下）：
- 兩個 LIFF 的 Endpoint URL 都設 `https://daos-tutoring-courses.replit.app/liff/`（注意：沒有 `#`，前端用 BrowserRouter）
- 家長端 → Replit secret 直接命名為 `VITE_LIFF_ID_PARENT`（Vite build 時自動撿到）
- 教練端 → Replit secret 直接命名為 `VITE_LIFF_ID_COACH`

家長／教練分享連結（兩個獨立 LIFF_ID，前端依路徑自動 init 對應 LIFF）：
- 家長：`https://liff.line.me/<LIFF_ID_PARENT>`
- 教練：`https://liff.line.me/<LIFF_ID_COACH>/coach`

### 本地開發測試 LIFF
使用 `liff.init` 時加上 `liff.isInClient()` 判斷：
```js
if (!liff.isInClient()) {
  // 本地開發模式，使用假資料
}
```

## 5. WebSocket 注意事項
Replit 支援 WebSocket，但注意：
- WebSocket URL 需使用 `wss://`（HTTPS 環境下）
- 部分免費版有連線數限制
- 前端連線範例：
```js
const ws = new WebSocket(
  `wss://daos-tutoring-courses.replit.app/ws?token=${jwt}&room=${chatRoomId}`
);
```

## 6. Ragic API 呼叫限制
- Ragic API 有 rate limit，建議每次呼叫加入 try/catch
- 教練在職狀態、場館清單每次進入系統即時查詢，不快取
- 若 Ragic API 回應慢，考慮加入 5 秒 timeout

## 7. Node-cron 在 Replit
- 需要 Always On 才能持續執行定時任務
- 部署時確認 cron jobs 在 server 啟動時初始化：
```js
const { initCronJobs } = require('./cron');
initCronJobs(); // 在 server/index.js 的最後
```

## 8. 檔案上傳大小限制
Express 預設 100kb，已調整為 50mb：
```js
app.use(express.json({ limit: '50mb' }));
```
Multer 設定建議：
```js
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });
```

## 9. 多前端同時開發
Replit 只能跑一個 web 服務（監聽一個 PORT）。
建議架構：
- 後端 Express 同時 serve 兩個前端的 build 結果
- `/` → 後台 admin 靜態檔
- `/liff` → LIFF 靜態檔
- `/api` → API routes

## 10. 常見錯誤排除
| 錯誤 | 原因 | 解法 |
|---|---|---|
| LIFF 無法啟動 | URL 不是 HTTPS | 使用 Replit 提供的 HTTPS URL |
| WebSocket 連線失敗 | 使用 ws:// 而非 wss:// | 改用 wss:// |
| Ragic API 403 | API Key 錯誤 | 檢查 RAGIC_API_KEY Secret |
| DB 連線失敗 | DATABASE_URL 格式錯誤 | 確認 Replit Database 已建立 |
| Cron 不執行 | 服務休眠 | 申請 Always On 或設定 ping |
