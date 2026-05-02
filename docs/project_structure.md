# 專案結構說明

```
daos_project/
├── .env.example          ← 環境變數範本（複製為 .env 後填入真實值）
├── .replit               ← Replit 執行設定
├── replit.nix            ← Replit 環境依賴（Node.js 20 + PostgreSQL）
├── README.md             ← 快速開始指南
│
├── server/               ← Node.js + Express API Server
│   ├── index.js          ← 入口點（routes + WebSocket + Cron 初始化）
│   ├── package.json      ← 後端依賴清單
│   ├── routes/           ← API 路由（每個功能模組一個檔案）
│   │   ├── auth.js       ← LINE Login、JWT 認證
│   │   ├── venues.js     ← 場館資料（Ragic H05）
│   │   ├── coaches.js    ← 教練資料（Ragic H01）
│   │   ├── parents.js    ← 家長帳號（Ragic Z01 雙向）
│   │   ├── students.js   ← 學員資料（Ragic Z02 雙向）
│   │   ├── courses.js    ← 課程期、報名、對帳
│   │   ├── slots.js      ← 教練可用時段（★ v7 核心）
│   │   ├── sessions.js   ← 課程時段、選槽、取消
│   │   ├── checkins.js   ← 簽到
│   │   ├── payments.js   ← 付款對帳歷史
│   │   ├── promotions.js ← 優惠活動
│   │   ├── referrals.js  ← MGM 推薦裂變
│   │   ├── transfers.js  ← 課程轉讓
│   │   ├── refunds.js    ← 退課
│   │   ├── chat.js       ← 聊天室（WebSocket 協作）
│   │   ├── learn.js      ← 學習歷程（課前規劃 + 授課記錄）
│   │   ├── evaluations.js← 期末評鑑
│   │   ├── admin.js      ← 系統設定、員工管理、後台功能
│   │   └── notifications.js ← 推播通知記錄查詢
│   │
│   ├── services/         ← 業務邏輯層
│   │   ├── ragic.js      ← Ragic API 封裝（讀取 + 雙向同步）
│   │   ├── line.js       ← LINE Messaging API + Flex Message 模板
│   │   ├── websocket.js  ← WebSocket Server（聊天室）
│   │   ├── promotions.js ← 優惠計算邏輯（資料隔離）
│   │   └── slots.js      ← 教練開槽 + 衝突偵測 + 選槽邏輯
│   │
│   ├── models/
│   │   └── db.js         ← PostgreSQL 連線池
│   │
│   ├── middlewares/
│   │   └── auth.js       ← JWT 認證 + 角色權限 middleware
│   │
│   └── cron/
│       └── index.js      ← 所有定時任務（提醒、逾時自動確認等）
│
├── client/
│   ├── liff/             ← 學員、教練 LIFF Web App（React）
│   │   ├── index.html
│   │   ├── vite.config.js
│   │   ├── tailwind.config.js  ← 品牌色系設定
│   │   ├── package.json
│   │   └── src/
│   │       ├── main.jsx  ← LIFF init + React 掛載
│   │       ├── App.jsx   ← 路由定義
│   │       └── index.css ← 品牌色 CSS 變數
│   │
│   └── admin/            ← 後台 Web App（React）
│       ├── index.html
│       ├── vite.config.js
│       ├── tailwind.config.js
│       ├── package.json
│       └── src/
│
├── db/
│   ├── migrate.js        ← Migration 執行腳本
│   ├── seed.js           ← Seed 執行腳本
│   ├── migrations/
│   │   └── 001_initial_schema.sql ← 完整 Schema（31 張資料表 + 4 Views）
│   └── seeds/
│       └── 001_defaults.sql       ← 系統預設參數、關鍵字、標籤
│
└── docs/                 ← 完整文件
    ├── architecture_v7.md   ← 系統需求架構書 v7.0
    ├── dev_schedule.md      ← 開發優先順序排程
    ├── brand_colors.md      ← 品牌色系規範
    ├── replit_notes.md      ← Replit 開發注意事項
    ├── line_setup.md        ← LINE 整合設定指南
    ├── ragic_api.md         ← Ragic API 整合說明
    ├── flex_messages.md     ← LINE Flex Message 通知規格
    └── project_structure.md ← 本文件
```
