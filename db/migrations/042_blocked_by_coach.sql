-- 042：區分「教練自己關的時段」與「產生器沿用關閉而建立的時段」
--
-- 智慧記憶（carry-forward）原本讀的是「最近 lookbackDays 天內所有 status='blocked'
-- 的時段」。但產生器自己就會依記憶把新格子直接建成 blocked，而那些格子也在
-- 查詢範圍內（該查詢只有下界沒有上界），於是下一輪又把它們讀回去當記憶來源——
-- 讀取自己的輸出。結果是關班只進不出：教練關掉「這一次」的某個時段，會被自我
-- 複製成每週永久關閉，解封在正常操作節奏下也收不回來（解封的那一格變成
-- available，但更外緣早就又被建成 blocked 了）。
--
-- 加一個明確的來源標記：只有教練透過 PATCH /:id/block 關的才寫入時間戳，
-- 解封時清空。carry-forward 只認這個欄位，不再認 status。
ALTER TABLE coach_availability_slots
  ADD COLUMN IF NOT EXISTS blocked_by_coach_at TIMESTAMPTZ;

-- 既有資料回填：042 之前所有 blocked 的時段都是教練自己關的
-- （產生器的 carry-forward 尚未在正式庫跑過，旗標一直是關的），
-- 一律視為教練關閉，避免升級後既有的關班設定憑空失效。
UPDATE coach_availability_slots
   SET blocked_by_coach_at = COALESCE(blocked_by_coach_at, updated_at, created_at, NOW())
 WHERE status = 'blocked' AND blocked_by_coach_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cas_blocked_by_coach
  ON coach_availability_slots(coach_id, blocked_by_coach_at)
  WHERE blocked_by_coach_at IS NOT NULL;