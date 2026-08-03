-- Migration 040: 逐筆同步失敗落庫（Phase 1 可觀測性）
--
-- 問題：_backupParentsStudentsImpl 的 catch 只做兩件事——
--   errors.push(msg) 與 console.warn。而 ragic_sync_log 最終只保存 errors[0]
--   （ragicAdmin.js:2265 的 `${errors.length} 筆同步失敗…${errors[0]}`），
--   於是「144 筆失敗」在資料庫裡只留下第 1 筆的訊息，其餘 143 筆的原因
--   只存在於 Replit console，事後無法還原、無法統計、無法證明。
--
--   Phase 0 因此只能用「重現 WHERE 條件 + 本地欄位檢查」推論失敗原因，
--   不能宣稱那就是 Ragic 實際拒絕的理由。本表把推論變成證據。
--
-- 本 migration 只新增一張表，不改任何既有資料、欄位或行為。
-- Idempotent — 與 server/bootstrap/coreSchema.js 保持一致；可在 prod 重跑。
-- Run: psql "$DATABASE_URL" -f db/migrations/040_ragic_sync_failures.sql

CREATE TABLE IF NOT EXISTS ragic_sync_failures (
  id              BIGSERIAL PRIMARY KEY,
  job_name        TEXT NOT NULL,                 -- 'backup' / 'pull' / …（沿用 ragic_sync_log 的 job_name）
  form_code       TEXT,                          -- 'Z01_Z02_BACKUP' 等
  entity_kind     TEXT NOT NULL CHECK (entity_kind IN ('parent', 'student')),
  local_id        UUID NOT NULL,                 -- parents.id / students.id
  ragic_record_id TEXT,                          -- 失敗當下本地已知的 Ragic 編號（可能為 NULL）
  error_code      TEXT,                          -- 正規化後的錯誤碼
  -- permanent：資料本身不合法，重試永遠失敗（例：必填欄位為空）
  -- transient：逾時／5xx／網路，重試有機會成功
  -- unknown  ：無法分類，需人工看 message
  error_kind      TEXT NOT NULL CHECK (error_kind IN ('permanent', 'transient', 'unknown')),
  message         TEXT,                          -- 已去識別化：不含 email／電話／身分證
  run_id          UUID,                          -- 對應 job_runs.id，可回溯是哪一輪
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 查「最近失敗了什麼」
CREATE INDEX IF NOT EXISTS idx_rsf_occurred ON ragic_sync_failures(occurred_at DESC);
-- 查「這一筆資料一直失敗嗎」——判斷是否該隔離（Phase 2 用）
CREATE INDEX IF NOT EXISTS idx_rsf_local ON ragic_sync_failures(local_id, occurred_at DESC);
-- 查「permanent 有幾筆」——這是 Phase 2 quarantine 的輸入
CREATE INDEX IF NOT EXISTS idx_rsf_kind ON ragic_sync_failures(error_kind, occurred_at DESC);