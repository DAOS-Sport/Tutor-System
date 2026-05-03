# LINE 整合設定指南

## 需要建立的 LINE 元件

### 1. LINE Login Channel（家長 + 教練共用 1 個）
**用途**：兩個 LIFF App 都掛在這個 Login Channel 下，確保同一用戶 LINE UID 唯一一致；後端只用這一個 Channel ID 驗 id_token。

設定步驟：
1. 進入 LINE Developers Console → 建立新 Provider（若無）
2. 建立 LINE Login Channel
3. 在 Channel 設定頁：
   - Callback URL：`https://daos-tutoring-courses.replit.app/api/auth/line/callback`
4. 記錄 Channel ID 與 Channel Secret → 存入 Secrets

### 2. LIFF App（建立 2 個：家長端 + 教練端）
家長端跟教練端**各建一個 LIFF**，掛在同一個 LINE Login Channel 下。前端會根據 URL path 自動挑要 init 哪個 LIFF。

| LIFF App | 名稱建議 | Endpoint URL | 用途 |
|---|---|---|---|
| 家長端 | 夢想體育學院-家教系統（家長端） | `https://daos-tutoring-courses.replit.app/liff/` | 家長 / 學員端 |
| 教練端 | 夢想體育學院-家教系統（教練端） | `https://daos-tutoring-courses.replit.app/liff/` | 教練端 |

**兩個 LIFF 的 Endpoint URL 完全一樣** — 前端 BrowserRouter mount 在 `/liff/` 底下，靠 path（`/coach` vs 其他）區分角色，後端用同一個 Login Channel 驗證 id_token，所以 `aud` 也一致。

設定步驟（兩個 LIFF 都這樣設）：
1. 在 LINE Login Channel → LIFF → Add
2. Size：Full（全螢幕）
3. Endpoint URL（**結尾的 `/` 不能漏，沒有 `#`**）：
   `https://daos-tutoring-courses.replit.app/liff/`
4. Scope：勾 `profile`、`openid`（教練登入需要 id_token）
5. Module mode：開啟
6. Bot link feature：依需求（建議 `On (Aggressive)`）
7. 點 Add → LINE 會給你 **LIFF ID**（格式 `1234567890-xxxxxxxx`）
8. 重複以上步驟建立第 2 個 LIFF

### 取得 2 個 LIFF ID 後設到 Replit Secrets
> **命名規則**：前端要看的 secret 必須以 `VITE_` 開頭，Vite build 時才會自動注入到瀏覽器 bundle。後端的 secret（cron / push 用）不用前綴。

| Secret 名稱 | 值 | 用途 |
|---|---|---|
| `VITE_LIFF_ID_PARENT` | 家長端 LIFF ID（如 `1234567890-abcdefgh`） | 前端家長路徑 `liff.init` 用 |
| `VITE_LIFF_ID_COACH`  | 教練端 LIFF ID（如 `1234567890-ijklmnop`） | 前端教練路徑 `/coach` `liff.init` 用 |
| `LIFF_URL_PARENT`     | `https://liff.line.me/<LIFF_ID_PARENT>` | 後端推播給家長的 base URL（cron / 學習歷程通知 / MGM 獎勵） |
| `LIFF_URL_COACH`      | `https://liff.line.me/<LIFF_ID_COACH>` | 保留供未來教練端推播 |

> 向後相容：若舊有 `LIFF_ID`（或 `VITE_LIFF_ID`）/ `LIFF_URL` 仍存在，前端會把它同時當 Parent 跟 Coach 用、後端會把 `LIFF_URL` 當 `LIFF_URL_PARENT` 的 fallback。建議切換完成後刪掉舊 secret。

設好 Secrets 後，重新部署一次 → Vite build 階段會自動撿到 `VITE_*` 開頭的環境變數寫進前端 bundle，不用改 `.replit`。

### 對外分享連結（給家長／教練）
| 對象 | 分享連結 | 開啟後落點 |
|---|---|---|
| 家長 | `https://liff.line.me/<LIFF_ID_PARENT>` | `/liff/`（家長首頁） |
| 教練 | `https://liff.line.me/<LIFF_ID_COACH>/coach` | `/liff/coach`（教練今日） |

LIFF SDK 會自動把 `liff.line.me/{LIFF_ID}/coach` 後面的 `/coach` 拼到 Endpoint URL 後送給前端，BrowserRouter 看到 `/liff/coach` 就由 `<RequireCoach>` 接手，`main.jsx` 也會偵測這條 path 並改用 `LIFF_ID_COACH` init。

**LIFF URL 帶 venue 參數**（給場館官方帳號選單）：
```
https://liff.line.me/<LIFF_ID_PARENT>?venue=B   ← B 場館（新北高中）家長
https://liff.line.me/<LIFF_ID_PARENT>?venue=C   ← C 場館（松山國小）家長
https://liff.line.me/<LIFF_ID_COACH>/coach?venue=B   ← B 場館教練
```

> 重要：絕對不要在 Endpoint URL 或分享連結加上 hash fragment（`#` 後接路徑的舊 HashRouter 寫法）。本前端用 `BrowserRouter`（純路徑），`#` 後面的東西會被當成瀏覽器錨點，**不會**送到 React Router，會導致教練永遠落到家長首頁或登入頁。

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
