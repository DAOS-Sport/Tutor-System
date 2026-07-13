# 上線前部署檢查清單

> 適用環境：Replit Autoscale Deployment（`.replit` 已設定 `deploymentTarget = "autoscale"`）。
> 流程：本機/Repl 開發 → 通過本清單 → Publish → 監控前 24 小時。

## 1. Replit Secrets（生產環境必填）

| Secret 名稱                 | 用途                                  | 來源 / 取得方式 |
|----------------------------|---------------------------------------|-----------------|
| `DATABASE_URL`             | 主資料庫 PostgreSQL 連線              | Replit DB 自動注入 |
| `JWT_SECRET`               | Admin / LIFF JWT 簽章                 | 32 字以上隨機字串（`openssl rand -hex 32`） |
| `LINE_LOGIN_CHANNEL_ID`    | LINE Login 共用 channel id            | LINE Developers Console |
| `LINE_LOGIN_CHANNEL_SECRET`| LINE Login secret                     | 同上 |
| `LIFF_ID`                  | LIFF App ID                           | LINE LIFF console |
| `LINE_MESSAGING_TOKENS`    | 各場館 Messaging API token JSON       | 例：`{"B":"...","C":"..."}`，**含所有上線場館的 venue code → token** |
| `RAGIC_API_KEY`            | Ragic API key                         | Ragic 後台 → 個人設定 → API Key |
| `RAGIC_ACCOUNT`            | Ragic 帳號名稱                        | Ragic URL 中段 |
| `RAGIC_BASE_URL`           | Ragic API base URL                    | 預設 `https://www.ragic.com` |
| `RAGIC_FORM_H01`           | H01 人事表單路徑                      | 詳見 `docs/ragic_api.md` |
| `RAGIC_FORM_H05`           | H05 場館表單路徑                      | 同上 |
| `RAGIC_FORM_Z01`           | Z01 家長表單路徑                      | 同上 |
| `RAGIC_FORM_Z02`           | Z02 學員表單路徑                      | 同上 |
| `REPLIT_OBJECT_STORAGE_BUCKET` | 教練介紹 / 授課記錄媒體儲存桶     | Replit Object Storage 自動建立 |
| `OBJECT_STORAGE_DRIVER`    | 附件儲存 driver                       | production 未設時自動使用 `replit`；明確設 `local` 會拒絕啟動 |
| `OBJECT_STORAGE_BUCKET_ID` | 非預設 Replit bucket ID（選填）       | 未填時使用 Replit default bucket |

> ⚠ 切勿在程式碼內 commit secret；本清單只列名稱。

## 2. LINE 設定逐項確認
- [ ] 家長 LIFF：Endpoint URL = `https://<repl-domain>/liff/`，Scopes 勾 `profile`、`openid`；家長綁定分享連結使用 `https://liff.line.me/<LIFF_ID_PARENT>/bind`
- [ ] 家長綁定**不**設定 server OAuth callback；`/api/auth/line/callback` 與 `/auth/line/callback` 僅作舊連結 303 相容，會丟棄 `code/state` 後回 `/liff/bind`，不得當 token exchange endpoint
- [ ] 教練 OAuth：LINE Login Callback URL 與 `GET /api/coach-portal/auth/line/status` 回傳的 `redirectUri` 完全一致（通常為 `https://<repl-domain>/api/coach-portal/auth/line/callback`）
- [ ] LINE 內建瀏覽器驗證：未綁定→手機/學員認領、已綁定→「LINE 已綁定」、失效/拒絕→可讀錯誤與重新操作入口；URL/console/error 不含 id_token、access token 或完整 UID
- [ ] 各場館 Messaging API：Webhook URL = `https://<repl-domain>/api/line/webhook/{venueId}`，啟用 push api
- [ ] 18 種 Flex Message 全部依 `docs/flex_message_checklist.md` 通過驗證

## 3. Ragic 設定
- [ ] H01 / H05 / Z01 / Z02 表單 API 啟用、Field ID 與 `docs/ragic_api.md` 完全相符
- [ ] 進行 1 次 `getActiveCoaches()` / `getActiveVenues()` 真資料拉取，回應 < 2s
- [ ] Z01/Z02 寫回測試 1 筆（用沙箱帳號）

## 4. 資料庫
- [ ] 啟動 server，確認所有 bootstrap 完成、無 `ERROR` log
- [ ] 不要在 production 盲跑 `npm run db:migrate`：舊 migration runner 會重跑所有 SQL，需先確認現有 schema 與本次 migration 的相容性。
- [ ] 設定每日備份 cron：`scripts/backup_db.sh`（詳見 §6）
- [ ] 第一次手動跑 `bash scripts/backup_db.sh` 並確認 Object Storage 有檔案

## 5. 部署 / Build
- [ ] production build 的 admin / liff 安裝必須包含 devDependencies（Vite 位於 devDependencies；build script 已使用 `npm install --include=dev`）
- [ ] `cd client/admin && npm run build` 通過、bundle ≤ 400KB
- [ ] `cd client/liff && VITE_LIFF_ID=$LIFF_ID VITE_USE_MOCK=false npm run build` 通過、bundle ≤ 600KB
- [ ] Replit 「Publish」按下後，autoscale URL 可訪問 `/admin` 與 `/liff`
- [ ] 健康檢查：`GET /health` 回 200，且回傳 build SHA/time 與本次 release 一致
- [ ] 觀看 Deployment logs 至 `[admin bootstrap] ready` 與 `[core bootstrap] ready`；server 僅在 storage preflight 與 schema bootstrap 完成後 listen，`/health` green 才代表 schema ready
- [ ] 上傳一份測試附件後，確認重整與另一個請求仍可讀回；Autoscale production 不得使用 local disk driver

## 6. 備份策略
- 腳本：`scripts/backup_db.sh`
- 排程：建議在 Replit Scheduled Deployments 設每日 03:00（台北）執行一次
- 保留期：本地 30 天由 `scripts/backup_db.sh` 自行刪除；遠端（Object Storage）保留期由 bucket lifecycle policy 控制（建議 30~90 天），腳本端不主動刪除遠端
- 還原步驟：`pg_restore -d $DATABASE_URL <下載的 .sql.gz>`（先解壓 `gunzip`）

## 7. 監控與告警（建議）
- [ ] Workflow / Deployment logs 接 Replit 內建 alerting
- [ ] 每日凌晨確認 `notification_log` 有新增資料（cron 健康指標）
- [ ] 主管 / 行政 dashboard 加上「今日推播數」儀表板（後續任務 #25 已規劃）

## 8. 上線當天 Cutover
1. 凍結 Ragic 主檔修改 30 分鐘
2. 跑一次手動備份
3. Publish → 驗證 §5 健康檢查
4. 用 4 個 UAT 帳號（`docs/uat_playbook.md`）走 smoke 路徑 A / B / G
5. 解除凍結，宣布上線
