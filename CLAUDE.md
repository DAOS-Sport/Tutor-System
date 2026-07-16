# DAOS 家教課程系統 — Agent 守則

專案背景、架構與部署細節見 `replit.md`（開發筆記主檔）與 `README.md`。

## 🧊 凍結令（2026-07-16 起，由專案擁有者下達）

**「簽到／扣課」路線已凍結為 2026-07 政策版，任何 agent 不得擅自修改。**
若判斷需要修改凍結範圍內的行為或程式，必須**先向使用者嚴格詢問、明確列出要改什麼與為什麼，取得同意後才能動手**。沒有同意＝不改。

凍結範圍（政策細節見 `replit.md` 的「簽到／扣課政策（2026-07 改版）」節）：

1. **團報預約免同組確認**：一律 `bookSlot1v1` 即時 confirmed；`pending_group_confirm` 流程不得復活（含 `bookSlot1vN`、逾時自動確認 cron、任何「同意/確認」關卡）。
2. **一方簽到＝整組生效＋揭露簽到方家長全名**（`checked_in_by_name` / `partner_checkin_name`，僅團報期、僅姓名）。
3. **櫃台手動扣課＝整班簽到語意**：共享課期不得重新加回 `SHARED_PERIOD_REQUIRES_CHECKIN` 之類的硬擋；一筆 session＋整班出席＝共扣 1 堂。
4. **扣課復活全量開放**：`DEDUCTION_REVIVAL_V2` 維持 `allowed_phones='{}'`，不得縮回 canary。
5. **`SHARED_CHECKIN_USAGE_V2` 維持全量**，不得縮窄。
6. `services/usageSync.js` 為 used_sessions 鏡射唯一同步入口；相關鎖序（coach advisory → `FOR UPDATE OF cp`）不得改動。

涉及檔案（改到即觸發詢問義務）：`server/routes/slots.js`、`server/services/slots.js`、`server/cron/index.js`、`server/routes/checkins.js`、`server/routes/sessions.js`、`server/routes/courses.js`（簽到欄位）、`server/routes/admin/manualDeductions.js`、`server/routes/admin/checkins.js`、`server/routes/admin/sessions.js`（cancelled/revive）、`server/services/usageSync.js`、`server/services/deductionRevival.js`、`server/bootstrap/coreSchema.js`（遷移與 feature flag seed 區塊）、對應 LIFF/admin 前端頁與 `tests/e2e/`（path_c、admin_manual_deduction、group_partner_checkin）。

⚠️ `PROMPT_NEXT_SESSION.md` 為 2026-07-12 的舊交接文件，其中與上述衝突的指令（如「共享課期拒絕」e2e）已被本政策取代，不得依其回滾行為。
