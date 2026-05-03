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
**只建立 1 個 LIFF App**。前端 build 時只注入一個 `VITE_LIFF_ID`，家長／教練都用同一個 LIFF App，靠「同 LIFF_ID + 不同路徑」分流。

設定步驟：
1. 在 LINE Login Channel → LIFF → Add
2. Size：Full（全螢幕）
3. Endpoint URL（**正式網域，注意結尾斜線、沒有 `#`**）：
   `https://daos-tutoring-courses.replit.app/liff/`
4. Scope：勾 `profile`、`openid`（取得 LINE id_token，教練登入需要）
5. Module mode：開啟
6. Bot link feature：依需求（建議 `On (Aggressive)`，加場館官方帳號好友）
7. 點 Add → LINE 會給你 **LIFF ID**（格式 `1234567890-xxxxxxxx`）

### 取得 LIFF ID 後設到 Replit Secrets
| Secret | 值 | 用途 |
|---|---|---|
| `LIFF_ID` | LINE Console 給的 LIFF ID | 後端 verify id_token、組推播深連結 |
| `LIFF_URL` | `https://liff.line.me/<LIFF_ID>` | 推播 Flex Message 的 base URL（程式會自動接 `/my-courses`、`/evaluation/:id` 等路徑） |

設好 Secrets 後，重新部署一次 → Build 階段會把 `LIFF_ID` 注入給前端 `VITE_LIFF_ID`。

### 對外分享連結（給家長／教練）
| 對象 | 分享連結 | 開啟後落點 |
|---|---|---|
| 家長 | `https://liff.line.me/<LIFF_ID>` | `/liff/`（家長首頁） |
| 教練 | `https://liff.line.me/<LIFF_ID>/coach` | `/liff/coach`（教練今日） |

LIFF SDK 會自動把 `liff.line.me/{LIFF_ID}/coach` 後面的 `/coach` 拼到 Endpoint URL 後送給前端，BrowserRouter 看到 `/liff/coach` 就由 `<RequireCoach>` 接手。

**LIFF URL 帶 venue 參數**（給場館官方帳號選單）：
```
https://liff.line.me/<LIFF_ID>?venue=B   ← B 場館（新北高中）
https://liff.line.me/<LIFF_ID>?venue=C   ← C 場館（松山國小）
https://liff.line.me/<LIFF_ID>/coach?venue=B   ← 教練端 + venue
```

> 重要：絕對不要在 Endpoint URL 或分享連結用 `#/`。前端用 `BrowserRouter`（純路徑），`#` 後面的東西會被當成瀏覽器錨點，**不會**送到 React Router，會導致教練永遠落到家長首頁或登入頁。

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
