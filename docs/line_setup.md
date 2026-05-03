# LINE 整合設定指南

## 需要建立的 LINE 元件

### 1. LINE Login Channel（所有場館共用一個）
**用途**：所有場館的 LIFF App 共用，確保同一用戶 LINE UID 唯一一致

設定步驟：
1. 進入 LINE Developers Console → 建立新 Provider（若無）
2. 建立 LINE Login Channel
3. 在 Channel 設定頁：
   - Callback URL：`https://daos-tutoring-courses.replit.app/api/auth/line/callback`
4. 記錄 Channel ID 與 Channel Secret → 存入 Secrets

### 2. LIFF App（掛在 LINE Login Channel 下）
建議建立兩個 LIFF App：家長端與教練端各一，方便分開分享連結與統計。

設定步驟：
1. 在 LINE Login Channel → LIFF → Add
2. Size：Full（全螢幕）
3. Endpoint URL（**正式網域**）：
   - 家長端：`https://daos-tutoring-courses.replit.app/liff/#/`
   - 教練端：`https://daos-tutoring-courses.replit.app/liff/#/coach`
4. Module mode：開啟
5. 記錄 LIFF ID（格式：`1234567890-xxxxxxxx`）→ 存入 Secrets

**LIFF URL 帶 venue 參數使用方式**（給 LINE 推播 / 官方帳號選單用）：
```
https://liff.line.me/{LIFF_ID}?venue=B   ← B 場館（新北高中）
https://liff.line.me/{LIFF_ID}?venue=C   ← C 場館（松山國小）
```
各場館的 LINE@ 官方帳號將對應的 LIFF URL 設為選單連結。

> 注意：`liff.line.me/{LIFF_ID}` 是 LINE 內自動登入入口（會回傳 id_token），程式裡 `LIFF_URL` 環境變數要保留這個格式；`daos-tutoring-courses.replit.app` 則是 LIFF Endpoint URL，給 LINE Developers Console 設定用。

### 3. LINE Messaging API Channel（各場館各一個）
**用途**：發送 LINE Flex Message，訊息從「各場館帳號」發出

為每個場館建立：
1. 建立 Messaging API Channel
2. 取得 Channel Access Token（Long-lived）
3. 存入 `venue_line_tokens` 資料表（後台介面設定）

**環境變數格式**：
```json
LINE_MESSAGING_TOKENS={"B":"token_for_B","C":"token_for_C","E":"token_for_E"}
```

**Webhook URL**：
本系統僅做 LINE 推播（push），不消費 LINE 端的 webhook 事件，因此每個場館的 Messaging API Channel 在 LINE Developers Console → Messaging API → Webhook settings 內：
- **Use webhook：關閉**（OFF）
- 若你之後要啟用（例如要接 follow / message 事件），Webhook URL 請設為：
  `https://daos-tutoring-courses.replit.app/api/line/webhook/{venue_id}`
  （目前 server 尚未實作對應路由，啟用前需先補 handler。）

## Flex Message 測試工具
LINE Flex Message Simulator：
https://developers.line.biz/flex-simulator/

品牌色系套用：
- Header 背景：`#15316a`
- 主要按鈕：`#31aeab`
- 成功狀態：`#97bf36`
- 警示狀態：`#e8a020`
- 資深教練：`#c9a84c`

## LINE Login 流程
```
用戶點擊 LIFF 連結
  → LINE Login 取得 Access Token
  → 呼叫 /api/auth/line（帶 access token + venue 參數）
  → 後端驗證 token，取得 LINE UID 與 profile
  → 比對本地 DB（parents / coaches）
  → 回傳 JWT Token
  → 前端儲存 JWT，後續 API 呼叫帶 Authorization header
```
