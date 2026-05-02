# ADR — Phase 4 聊天室實作偏離說明

最後更新：2026-05-02 · 對應 Task #15 · spec F-S09 / F-C03 / F-M03 / F-A07

本檔記錄 Phase 4 聊天室在實作期間相對於原始規格／步驟計畫的「有意」偏離，方便
後續 Phase 5（push 通知整合）與 audit 時快速對齊。

## 1. 訊息與附件 schema

- **計畫**：`chat_messages` + `chat_attachments` 兩張表（一對多）。
- **實作**：單表 `messages`，附件以 inline 欄位
  `media_url / media_filename / media_size_bytes / message_type` 表達。
- **理由**：MVP 只支援單檔附件且不做版本歷程；單表簡化 read 路徑、reduce JOIN，
  也讓 WS 廣播 payload 與 REST `_hydrate` 保持一致。
- **影響**：未來若要支援多檔，再轉 1:N 並 backfill；此處 schema 變更為
  附加欄位、不破壞既有資料。

## 2. Object Storage driver adapter

- **計畫**：直接接 Replit App Storage blueprint。
- **實作**：抽象 `services/objectStorage.js` driver pattern；目前 active driver 為
  `LocalDiskDriver`（寫到 `server/uploads/…`，搭配 `/uploads` 靜態 + 安全 headers），
  並保留 `ReplitDriver` placeholder，可由 `OBJECT_STORAGE_DRIVER` env 切換。
- **理由**：blueprint 安裝需使用者授權與 bucket 配置；driver pattern 在不阻塞
  P4 完成的前提下保留無痛切換空間。
- **影響**：切換 storage 時不需改任何 route／service，只需新增 `ReplitDriver`
  實作 + 設 env。

## 3. 期數 → active 立即建房

- **計畫**：DB trigger，「期數 status 改 active 即同 transaction 建 room」。
- **實作**：三層 safety net —
  1. service 入口 `chatRooms.transitionPeriodToActive(periodId)`（canonical 路徑）。
  2. admin 入口 `POST /api/admin/periods/:id/activate` 包同一 service。
  3. cron 每 5 分鐘 + bootstrap 啟動時 `backfillRoomsForActivePeriods()` 兜底。
- **理由**：保留所有狀態翻牌都可以靠 service／cron 兜回，不需引入 DB trigger。
- **影響**：若有人直接 `UPDATE course_periods SET status='active' …` 繞過 service，
  最遲 5 分鐘內由 cron 補上 room。要絕對即時可後續再加 trigger。

## 4. F-M03 聊天紀錄查閱角色

- **政策**：聊天紀錄屬「監察」性質的 PII（含家長／學員私訊），僅 admin / manager 可查閱；
  staff（場館行政）僅在自己場館的營運面工作，不得查閱聊天訊息。
- **實作**：`/api/admin/chat/rooms` + `/rooms/:id/messages` 加
  `requireAdminRole('admin', 'manager')`；admin Sidebar 「聊天紀錄」menu item 移除 staff。
- **F-A07 警示**：同樣僅 admin / manager；manager 限自己場館，無 venue_id 一律 fail closed。

## 5. 讀取回條（read receipt）語意

- **MVP 簡化**：`messages.read_by_peer` 表示「房間內非自己角色的另一方有人已讀」。
- **1vN（多家長共用一房）情境**：例如 1 教練 vs 多家長共讀房間，`read_by_peer=true`
  代表「教練 OR 任一其他家長」其中之一已讀，不會在 UI 區分是哪一位 peer 讀過。
  教練端看到 `read_by_peer=true` 時表示「至少有一位家長」已讀；家長端看到時表示
  「教練 OR 其他家長」其中之一已讀。
- **後續可演進**：若 PM 要求 1vN 房 per-peer 已讀清單，可改讀 `message_reads` 明細
  彙總（已存在），不需 schema 變更。
