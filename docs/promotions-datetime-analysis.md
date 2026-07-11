# 優惠檔期：加入「時間」欄位 + 修正「16:00 / 差一天」問題

## 背景與症狀
後台優惠列表的起迄日顯示成類似 `2026-07-10T16:00:00.000Z`（出現下午 16:00，且比實際少一天），且沒有可設定「時間」的欄位。

## 根本原因（已實測確認）
`promotions.start_date` / `end_date` 為 **`DATE`** 型別（無時間）。正式環境 `server/index.js` 設 `process.env.TZ='Asia/Taipei'`：

```
DB 的 DATE 2026-07-11
  → node-postgres 依進程時區解析為「台灣午夜」
  → JSON 序列化成 UTC = "2026-07-10T16:00:00.000Z"   ← 16:00 + 差一天
```

影響面：
1. 列表顯示（`PromotionsPage` / `PromotionsActivePage` 直接印 `{p.start_date}`）→ 醜時間戳、16:00。
2. 編輯回填（表單 `toISODate` 切前 10 碼）→ 日期少一天。
3. Service 端 `isWithinWindow`（JS 字串比較）→ 邊界差一天（潛在）。

實際「啟用/檔期」判定走 DB 端（`recordUsage` 用 `CURRENT_DATE`、`listActivePromotions` 用 SQL 日期比較），以曆日為單位大致正確；壞的主要是顯示、回填、JS preview 邊界。

## 目標
- 起迄要有「時間」欄位。
- 起日預設時間 `00:00`、迄日預設時間 `23:59`（台灣時間）。

## 決策（本次採用）
- **型別**：`DATE → TIMESTAMPTZ`。**保留欄位名 `start_date` / `end_date`**（不改名）——改動面最小、不會漏改引用點，也一樣根治 16:00；語意上「date」欄位改存時刻的小瑕疵可接受。
- **時區**：固定台灣（UI 標註），不開放選擇。
- **迄日端點**：迄日存到當日 `23:59:59`（含整分），比較採 **inclusive**（`end_date >= NOW()`）。
- **比較基準**：一律以 `NOW()`（絕對時刻）比較，取代 `CURRENT_DATE` / JS 字串比較。

## 改動清單（依檔案）

### Schema
- 新 migration `db/migrations/019_promotion_datetime.sql`：`SET TIME ZONE 'Asia/Taipei'`；以 `information_schema` 判斷仍為 `date` 時才 `ALTER COLUMN ... TYPE TIMESTAMPTZ`，backfill：start→當日 `00:00`、end→當日 `23:59:59`。
- `server/bootstrap/coreSchema.js`：`CREATE TABLE` 兩欄改 `TIMESTAMPTZ`；加同上的 idempotent `DO $$ ... $$` 供既有 DB 升級。

### 後端
- `server/services/promotions.js`：
  - `isWithinWindow` 改用時刻比較（`new Date(start) <= now <= new Date(end)`）。
  - `listActivePromotions`：`WHERE start_date <= NOW() AND end_date >= NOW()`（移除 `todayTaipei` 字串比較）。
  - `recordUsage` FOR UPDATE 覆核：`start_date <= NOW()`、`end_date >= NOW()`。
- `server/routes/admin/promotions.js`：`validatePayload` 起迄改以 `Date` 比較（`end < start` 擋）；`/active` SQL `CURRENT_DATE → NOW()`。（`PROMO_FIELDS` 名稱不變）
- `server/services/referrals.js`：MGM 券 `CURRENT_DATE` / `CURRENT_DATE + INTERVAL '60 days'` → `NOW()` / `NOW() + INTERVAL '60 days'`。
- `server/routes/promotions.js`（LIFF）：`expires_at: p.end_date` 名稱不變（值改為時刻）。

### 前端（後台表單）
- `client/admin/src/pages/promotions/PromotionFormModal.jsx`：
  - 起、迄各拆成「日期 + 時間」輸入；時間預設 start `00:00`、end `23:59`。
  - 編輯載入：把 ISO 時刻用台灣時區拆回日期/時間。
  - 送出：組成帶 `+08:00` 的 ISO（start 秒 `:00`、end 秒 `:59`）。
  - 重疊偵測維持日級（已 `slice(0,10)`，不需改）。

### 顯示層
- `PromotionsPage` / `PromotionsActivePage`：以 `formatTWDateTime()`（`client/admin/src/utils/format.js` 既有）呈現起迄。

### 跟進（低風險）
- `client/admin/src/api/mock.js`、`client/liff/src/api/mock.js`、`tests/e2e/path_e_promotion.js`：欄位語意跟進（多為 dev/測試用，型別可相容）。

## 驗證
1. 對 DB 套 `019` migration，確認 `start_date`/`end_date` 型別為 `timestamp with time zone`，既有資料 backfill 正確（start 00:00、end 23:59:59 台灣）。
2. 後台建一筆優惠、設起 09:00 迄 18:00，查 DB 時刻正確；列表顯示不再有 16:00。
3. 於檔期時刻前後各測一次 preview / 報名，確認啟用視窗以時刻為準（含 23:59:59 邊界）。
4. 既有 e2e `path_e_promotion` 通過。

## 風險
中型改動、動到啟用視窗核心；`ALTER COLUMN TYPE` 需無相依 view（已確認 promotions 起迄無 view 依賴）。閉/半開區間規則須 DB 與 JS 一致（本次採 inclusive + end 存 23:59:59）。
