# 個家教課程系統（DAOS Tutoring System）
**駿斯運動事業股份有限公司 — 夢想體育學院**

## 快速開始（Replit）

### 1. 環境變數設定
複製 `.env.example` → `.env`，填入所有必要的 Key：
```
cp .env.example .env
```

### 2. 安裝依賴
```bash
cd server && npm install
cd ../client/liff && npm install
cd ../admin && npm install
```

### 3. 資料庫初始化
```bash
cd server
npm run db:migrate    # 執行所有 migration
npm run db:seed       # 插入預設資料
```

### 4. 啟動開發伺服器
```bash
# 後端
cd server && npm run dev

# LIFF 前端（另開終端機）
cd client/liff && npm run dev

# 後台前端（另開終端機）
cd client/admin && npm run dev
```

## 專案結構
```
/server             Node.js + Express API Server
  /routes           API 路由
  /services         業務邏輯（Ragic、LINE、優惠計算等）
  /models           資料庫查詢
  /middlewares      認證、權限驗證
  /cron             定時任務
/client
  /liff             學員、教練 LIFF Web App（React）
  /admin            後台 Web App（React）
/db
  /migrations       SQL Migration 檔案
  /seeds            預設資料
/docs               完整需求文件
```

## 文件索引
| 文件 | 說明 |
|---|---|
| `docs/architecture_v7.md` | 系統需求架構書 v7.0（完整版）|
| `docs/schema_v2.sql` | 資料庫 Schema（含 v7 更新）|
| `docs/dev_schedule.md` | 開發優先順序排程 |
| `docs/brand_colors.md` | 品牌色系規範 |
| `docs/replit_notes.md` | Replit 開發注意事項 |
| `docs/line_setup.md` | LINE 整合設定指南 |
| `docs/ragic_api.md` | Ragic API 整合說明 |
| `docs/flex_messages.md` | LINE Flex Message 通知規格 |
