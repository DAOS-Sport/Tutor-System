# Resume Prompt

你正在續作 `/home/runner/workspace` 的 DAOS 場館系統發布修復。先完整閱讀：

1. `docs/release_handover_2026-07-12.md`
2. `README.md`、`docs/`、`.replit`、`server/package.json`
3. `git status --short` 與 `git diff --check`

目前狀態是 **PAUSED_NOT_PUBLISHED**。不要把未 commit 的工作區視為可丟棄，也不要使用 `git reset --hard`、`git checkout --` 或全域 `npm run db:migrate`。既有回滾基準是 tag `pre-release-20260712-1048`（commit `94ca71b42a4fd8635a73733afa71fb1ecf04dbc8`）。Production 尚未發布。

你的目標是完成並驗證這次既定的 1–9 項修復，但先處理交接文件中的 release blockers：

- 補齊 `/api/enrollments` 的強制 request-id、parent/request advisory lock 與副作用前既有 checkout 回傳，修復試上／TRIAL50 retry 與雙送。
- 將 Replit object storage proof existence 改成 async、真實存在檢查；所有 proof 路由要 await 並 fail closed；production 不可靜默使用 local proof storage。
- 為手動扣課補隔離 E2E：成功、idempotent retry、已排未簽到容量、共享課期拒絕、越權與 slot 並發；保持 legacy `checked_in_by_student_id` 相容。
- 以 read-only query 驗證 production 的 group-period 複合 unique index；不得在這個 additive-only release 中 drop/rebuild legacy index。若 production 無法驗證，維持 BLOCKED。

所有修改必須保守、向下相容、可回滾。不得恢復身分證字號驗證、不得擴大櫃檯跨館權限、不得硬刪歷史資料或附件。完成後必須跑 lint（若無設定要明確記錄）、typecheck（若無 TypeScript 要明確記錄）、syntax、unit/integration/E2E、兩個前端 build、migration preflight，以及 production health/log/smoke。只有有真實 Replit deploy 權限且 post-deploy 驗證通過，才能宣告 `PUBLISH_SUCCESS`；否則如實回報 `BLOCKED`。
