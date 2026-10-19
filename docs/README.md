# 文件索引

程式碼註解或測試會用路徑引用的文件，都留在 `docs/` 根目錄；搬走會讓那些引用失效，其中有些在 CLAUDE.md 凍結範圍內不能改。

## 根目錄：仍在使用的規格與決策

| 文件 | 內容 |
| --- | --- |
| `architecture_v7.md` | 系統需求架構書 v7.0（原始需求，2026/07–10 的凍結政策以 CLAUDE.md 與最新合約為準） |
| `architecture_rationale_2026-10.md` | 三端效能與可靠性的架構決策（GitHub #15） |
| `perf_baseline.md` | 效能基線與量測方式 |
| `family_accounts_spec_2026-09-23.md` | 家庭帳號規格 |
| `parent_account_business_logic_2026-09-22.md` | 家長帳號業務邏輯 |
| `adr_phase4_chat.md` | 聊天室決策紀錄 |
| `ragic_api.md`、`ragic_sync_audit.md`、`ragic_history_import_plan.md` | Ragic 整合手冊、同步稽核、歷史匯入計畫 |
| `ragic-recon-investigation-20260707.md` | Ragic 對帳調查（程式註解引用） |
| `business_rules_audit_2026-10.md`、`false_success_audit_2026-10.md`、`timezone_audit_2026-10.md`、`scheduling_capacity_2026-10.md` | 2026-10 工單 #10–#13 稽核 |
| `route-map-audit.md`、`路由.md` | 路由對照 |
| `flex_messages.md`、`flex_message_checklist.md`、`line_setup.md` | LINE 通知與設定 |
| `brand_colors.md`、`replit_notes.md`、`dev_schedule.md`、`phase_history.md` | 品牌色、Replit 注意事項、開發排程、歷史紀錄 |

## 子目錄

| 目錄 | 內容 |
| --- | --- |
| `audits/` | 一次性的稽核、調查與修復報告 |
| `release/` | 發布、交接、回滾、驗收清單 |
| `specs/` | 匯入格式、欄位對照、路由凍結盤點等規格頁（HTML） |
| `manuals/` | 各角色操作手冊 |
| `eval/` | 技術評估 |
| `ragic-field-ids/` | Ragic 欄位 ID |
| `images/` | 截圖與圖片素材 |
| `archive/` | 已過時、只留作紀錄的文件（例如早期的 `project_structure.md`） |

資料庫 schema 以 `server/bootstrap/` 與 `db/migrations/` 為準。
