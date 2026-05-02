# DAOS 家教課程系統 — Replit 開發筆記

## 專案概要
- 公司：駿斯運動事業股份有限公司 — 夢想體育學院
- 系統：個家教課程系統（DAOS Tutoring System）
- 主要使用者：教練、家長／學員（透過 LINE LIFF）、行政後台
- 主要外部系統：Ragic（人事／場館／家長學員資料來源）、LINE（Login + Messaging）

## 架構與目錄
- `server/` — Node.js + Express API
  - `routes/`、`services/`（含 `ragic.js`、`line.js`、`promotions.js`、`slots.js`、`websocket.js`）、`models/`、`middlewares/`、`cron/`
- `client/`
  - `liff/` — 學員／教練 LIFF Web App（React）
  - `admin/` — 後台 Web App（React）
- `db/migrations`、`db/seeds`
- `docs/` — 完整需求／規格文件（見 README 文件索引）

## 環境變數
- 主要 Key 都在 `.env.example`，正式部署時請放 Replit Secrets。
- Ragic 相關：`RAGIC_API_KEY`、`RAGIC_BASE_URL`、`RAGIC_FORM_H01/H05/Z01/Z02`。
- 注意 H01 與 H05/Z01/Z02 的 Ragic AP_Name 不同（H01 用 `standardzhtw`，其餘用 `xinsheng`），表單路徑前綴各自獨立。

## 文件
- 文件索引以 `README.md` 為主。
- `docs/ragic_api.md`：Ragic 整合手冊（含完整欄位對照表 + Field ID）。
- 其他規格：`architecture_v7.md`、`schema_v2.sql`、`dev_schedule.md`、`brand_colors.md`、`replit_notes.md`、`line_setup.md`、`flex_messages.md`。

## 部署設定
- Target：`autoscale`（單一服務）
- Build：依序 `npm install` server、admin、liff，並把兩個前端 build 到 `server/public/{admin,liff}`。LIFF build 階段會把 `LIFF_ID` 透過 `VITE_LIFF_ID` 注入給 Vite，前端用 `import.meta.env.VITE_LIFF_ID` 初始化 LIFF SDK。
- Run：`cd server && npm start`（`node index.js`）
- 由 Express 同時提供：
  - `/api/*` → 後端 API
  - `/admin/*` → 後台 SPA（含 React Router fallback）
  - `/liff/*` → LIFF SPA（含 React Router fallback）
  - `/` → 預設 302 轉到 `/admin/`；若 query 帶有 `liff.*` 參數（LINE 開啟 LIFF 時會附），則改導到 `/liff/` 並保留 query
  - `/health` → 健康檢查
- WebSocket 透過同一個 HTTP server 啟動（`initWebSocket(server)`）。

## 變更紀錄
- 2026-05-02：補完 `docs/ragic_api.md` 的 H01／H05／Z01／Z02 欄位對照（含 Field ID、表單 metadata、API Key 環境變數說明）。Z02 段落標註附件來源欄位疑似與 Z01 重複，待使用者確認真實欄位後再行更新。
- 2026-05-02：修復部署。將 `.replit` 部署目標從 `cloudrun` 改為 `autoscale`，新增 build 指令同時建置 server / admin / liff。`server/index.js` 加入靜態檔案服務（`/admin`、`/liff`）與 SPA fallback、根路徑轉址，並把 listen 綁到 `0.0.0.0`。為 `client/admin/` 補齊 `index.html`、`src/main.jsx`、`src/App.jsx`、`src/index.css` 最小骨架；為 `server/routes/` 19 個尚未實作的 route 建立暫時 stub（回傳 501 Not Implemented），讓 server 能正常啟動。
