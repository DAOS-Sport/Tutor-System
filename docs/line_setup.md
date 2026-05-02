# LINE 整合設定指南

## 需要建立的 LINE 元件

### 1. LINE Login Channel（所有場館共用一個）
**用途**：所有場館的 LIFF App 共用，確保同一用戶 LINE UID 唯一一致

設定步驟：
1. 進入 LINE Developers Console → 建立新 Provider（若無）
2. 建立 LINE Login Channel
3. 在 Channel 設定頁：
   - Callback URL：`https://your-replit-url.repl.co/api/auth/line/callback`
4. 記錄 Channel ID 與 Channel Secret → 存入 Secrets

### 2. LIFF App（掛在 LINE Login Channel 下）
設定步驟：
1. 在 LINE Login Channel → LIFF → Add
2. Size：Full（全螢幕）
3. Endpoint URL：`https://your-replit-url.repl.co/liff`
4. Module mode：開啟
5. 記錄 LIFF ID（格式：`1234567890-xxxxxxxx`）→ 存入 Secrets

**LIFF URL 帶 venue 參數使用方式**：
```
https://liff.line.me/{LIFF_ID}?venue=B   ← B 場館（新北高中）
https://liff.line.me/{LIFF_ID}?venue=C   ← C 場館（松山國小）
```
各場館的 LINE@ 官方帳號將對應的 LIFF URL 設為選單連結。

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
