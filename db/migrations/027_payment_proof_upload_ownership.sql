-- 家長匯款證明上傳 ownership ledger（additive）。
-- 檔案落地與付款資料送出是兩個 HTTP request；此表在第一個 request 就保存
-- parent + target，避免第二個 request 失敗後只剩無主 storage object。
CREATE TABLE IF NOT EXISTS payment_proof_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL DEFAULT 'unassigned'
    CHECK (target_type IN ('checkout','enrollment','group_order','unassigned')),
  target_id TEXT,
  original_url TEXT NOT NULL,
  preview_url TEXT,
  thumbnail_url TEXT,
  checksum CHAR(64) NOT NULL,
  actual_mime_type TEXT,
  conversion_status TEXT NOT NULL DEFAULT 'ready',
  linked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_proof_target_shape CHECK (
    (target_type = 'unassigned' AND target_id IS NULL)
    OR (target_type <> 'unassigned' AND target_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_proof_upload_preview
  ON payment_proof_uploads(preview_url) WHERE preview_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_proof_upload_original
  ON payment_proof_uploads(original_url);
CREATE INDEX IF NOT EXISTS idx_payment_proof_upload_target
  ON payment_proof_uploads(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_proof_upload_parent
  ON payment_proof_uploads(parent_id, created_at DESC);
