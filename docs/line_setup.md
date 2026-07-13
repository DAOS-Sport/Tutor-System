# LINE 整合設定指南

## 登入流程總覽（LINE-first / LINE-only）

### 家長 LIFF（LINE-first）
LIFF 一開即拿 `id_token`，無手動輸入登入：
1. `LINE id_token` → `POST /api/auth/parent-line-login`
   - 後端 verify id_token (LINE_LOGIN_CHANNEL_ID 當 aud) → 拿 `line_uid`
   - 查 Ragic Z01「家教系統uid」(`1006846`) → 找到家長 → 簽 JWT → `logged_in`
   - 找不到 → 回 `need_phone_binding`，前端顯示手機綁定畫面
2. 手機綁定 → `POST /api/auth/parent-bind-phone { id_token, phone }`
   - Ragic Z01 用手機查 → 命中：寫回 Z01.家教系統uid + 本地 parents.line_uid，回 `bound_and_logged_in`
   - 沒命中：回 `need_registration`，前端導 `/register?phone=…`
3. 註冊 → `POST /api/auth/parent-register-line { id_token, parent, students, ref_token? }`
   - 寫 Z01 主表 + 子表格學生 → 本地 upsert → 回 `registered_and_logged_in`
   - `ref_token` (MGM 推薦) 與註冊同 endpoint 串入；失敗只記 `ref_error`，不 rollback 註冊

### 教練 LIFF（LINE-only）
僅憑 `id_token` 自動登入，**不接受手動輸入手機首次綁定**：
1. `LINE id_token` → `GET /api/coaches/by-line-uid?id_token=…`
2. 後端 verify id_token → 拿 `line_uid`
3. 查 Ragic H01「個人LINE ID」(`1003633`) 對應 coach → 簽 JWT 回傳
4. 沒命中：回 404 `LINE_UID_NOT_BOUND`，前端顯示
   > 尚未完成綁定，請截圖傳送結果至 400 官方帳號
5. 由管理員在 Ragic H01 補綁 LINE UID 後再登入

> production 必須 `REQUIRE_LINE_ID_TOKEN=1`：教練 `by-phone` endpoint 不再接受首次綁定（dev 才接受）。

---


## 需要建立的 LINE 元件

### 1. LINE Login Channel（家長 + 教練共用 1 個）
**用途**：兩個 LIFF App 都掛在這個 Login Channel 下，確保同一用戶 LINE UID 唯一一致；後端只用這一個 Channel ID 驗 id_token。

設定步驟：
1. 進入 LINE Developers Console → 建立新 Provider（若無）
2. 建立 LINE Login Channel
3. 家長綁定走 LIFF SDK 的 `id_token`，**不是** server-side OAuth callback：
   - 對外綁定入口：`https://liff.line.me/<LIFF_ID_PARENT>/bind`
   - 不要把家長 callback 設成 `/api/auth/line/callback` 或 `/auth/line/callback` 來交換 code；系統不會用 code 建立／綁定帳號。
   - 為了不讓已發出的舊連結白頁，這兩個舊路徑只會以 `Cache-Control: no-store`、`Referrer-Policy: no-referrer` 的 303 回 `/liff/bind`，且會丟棄所有 `code`、`state`、token 與 UID query；真正驗證仍由 LIFF + `POST /api/auth/parent-line-login` 的 id_token audience/sub 驗證完成。
4. 教練 web OAuth 才使用 callback；以 `GET /api/coach-portal/auth/line/status` 回傳的 `redirectUri` 為 LINE Console 唯一設定值（通常為 `https://<repl-domain>/api/coach-portal/auth/line/callback`）。
5. 記錄 Channel ID 與 Channel Secret → 存入 Secrets

### 2. LIFF App（建立 2 個：家長端 + 教練端）
家長端跟教練端**各建一個 LIFF**，掛在同一個 LINE Login Channel 下。前端會根據 URL path 自動挑要 init 哪個 LIFF。

| LIFF App | 名稱建議 | Endpoint URL | 用途 |
|---|---|---|---|
| 家長端 | 夢想體育學院-家教系統（家長端） | `https://<repl-domain>/liff/` | 家長 / 學員端（`/bind` 為綁定成功頁） |
| 教練端 | 夢想體育學院-家教系統（教練端） | `https://<repl-domain>/liff/coach-portal` | 教練端 web OAuth 入口 |

家長 BrowserRouter mount 在 `/liff/`；`/bind` 是可直接分享的家長綁定入口。教練入口與家長綁定流程分離，請勿把家長連結導到教練 OAuth callback。

設定步驟（兩個 LIFF 都這樣設）：
1. 在 LINE Login Channel → LIFF → Add
2. Size：Full（全螢幕）
3. Endpoint URL（**結尾的 `/` 不能漏，沒有 `#`**）：
   `https://<repl-domain>/liff/`（家長端）
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
| 家長綁定 | `https://liff.line.me/<LIFF_ID_PARENT>/bind` | `/liff/bind`（已綁定／綁定成功提示） |
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

## 家長 LINE Login／綁定安全流程
```
用戶點擊家長 LIFF 或 /bind 連結
  → LIFF SDK 建立登入 state 並取得 id_token
  → POST /api/auth/parent-line-login（後端驗 aud + sub）
  → UID 命中：登入；未命中：手機比對 → 學員姓名認領 → 舊資料認領或新註冊
  → 成功後才簽發本系統 JWT
```

不得把 access token、id_token、LINE UID 或 callback `code/state` 放到分享 URL、前端 console 或使用者可見錯誤訊息。`/api/auth/line/callback` 僅為舊連結相容 redirect，並非 OAuth token endpoint。

## 教練端登入（LINE-only，不可手機首次綁定）

教練端與家長端不同：教練端**只能**透過事先綁定的 LINE 帳號登入。

### 綁定來源（二擇一，由管理員操作）
1. **Ragic H01「個人LINE ID」欄位**（Field ID `1003633`）
   - 由 HR / 員工自助填寫 LINE userId
   - 系統只讀 Field ID `1003633`，不讀「400Line訊息」或任何 LINE 訊息 / 狀態欄位
   - uid 必須是 LINE Login userId（格式 `U` + 32 hex），不是 message id 或對話 id
   - 每輪同步會把該值帶入 `coaches.line_uid`（透過 ragic_staging_changes 經管理員核准後 apply）
   - 寫入規則：本地空 → 補；本地已有 → 不被空值覆蓋；本地與 Ragic 不同 → 保留本地 + console.warn
2. **後台員工管理頁手動編輯**
   - 管理員可直接在後台 staff 編輯彈窗填入 LINE userId

### 登入流程
- 教練在 LINE App 內開啟 `https://liff.line.me/<LIFF_ID_COACH>/coach`
- 前端 LIFF：`liff.getProfile().userId` + `liff.getIDToken()`
- 後端：`GET /api/coaches/by-line-uid?lineUid=Uxxx` + header `X-Line-Id-Token: <id_token>`
- 驗證通過 → 回 coach + JWT；找不到 → 403/404 `COACH_LINE_NOT_BOUND`

### production / `REQUIRE_LINE_ID_TOKEN=1` 規則
- **不可** 透過 `/api/coaches/by-phone` 做首次綁定（即便驗證了 id_token 也不寫入空的 `line_uid`）
- by-phone 端點維持比對用：
  - 手機找到 + `line_uid` 為空 → 403 `COACH_LINE_NOT_BOUND`
  - `line_uid` 與 verified sub 不符 → 403 `COACH_LINE_MISMATCH`

### LIFF 未綁定提示文字（前端固定文案）
```
尚未完成綁定
請截圖傳送結果至 400 官方帳號
```
畫面同時顯示「LINE 身分已驗證，僅尚未對應到教練資料」副標，引導教練聯絡管理員協助綁定。

### 開發環境（`NODE_ENV !== 'production'` 且 `REQUIRE_LINE_ID_TOKEN !== '1'`）
- 保留 `by-phone` 的 phone-only fallback（無 id_token 也能登入），每次登入會 `console.warn`
- 方便本地測試教練流程；正式環境**不會**走到這條路徑
