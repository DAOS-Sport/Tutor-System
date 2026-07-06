-- 013_z03_deleted_tombstones.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Z03 強制刪除 tombstone：ragic_z03_records 是靠 z01_ragic_record_id 當唯一鍵、
-- 由每次 Z01→Z03 拉回同步（_upsertZ03Record，ON CONFLICT (z01_ragic_record_id)
-- DO UPDATE）持續維護的衍生佇列——只要來源 Ragic Z01 記錄還在、還「不完整」，
-- 下一次同步（cron 每 10 分鐘或手動觸發）就會重新把它 upsert 回來。單純
-- DELETE FROM ragic_z03_records 不會真的清除，下次同步就復活。
--
-- 本表記錄「管理員已強制刪除、之後任何同步都不得再重建」的 Z01 記錄 id：
-- _upsertZ03Record 在 upsert 前先查本表，命中就整筆跳過。只影響本 app 的
-- Z03 衍生資料，Ragic 平台本身的原始 Z01 記錄完全不受影響（Ragic 是權威來源，
-- 本 app 不寫回）。
--
-- 注意：db/migrate.js 每次重跑所有 .sql，故全部 DDL 必須冪等（CREATE TABLE
--       IF NOT EXISTS）。本檔內容同時加進 server/bootstrap/coreSchema.js
--       （線上 runtime 權威），否則正式環境不會生效。
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ragic_z03_deleted_tombstones (
  z01_ragic_record_id TEXT PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by TEXT,
  reason TEXT
);
