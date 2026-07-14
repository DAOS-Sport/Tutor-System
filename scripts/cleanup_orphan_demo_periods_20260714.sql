-- 2026-07-14 上架前家長端資料健檢 — 清除 7 個「無學員掛載」的孤兒/demo 課程期。
-- 健檢證據（見 replit.md 變更紀錄）：
--   * 7 期全部 0 名學員掛載（家長端本來就看不到、也無法簽到）
--   * 0 筆簽到、0 筆轉讓、0 筆手動扣課（無任何帳務依附）
--   * 其中 5 期的 anchor 報名單已不存在（測試清理殘留）、1 期 anchor 是 demo 測試帳號、
--     1 期（ba4c...）完全無 anchor 且僅有 6 則 demo 聊天訊息
--   * 若不清除，會出現在新版後台「簽到模式管理」清單造成混淆
-- 守門：僅刪「至今仍無 active 學員掛載」者；CASCADE 一併清 demo sessions/空聊天室。
BEGIN;
-- 先釋放這些 demo 課堂占用的教練時段（fk_slot_session 會擋 CASCADE 刪除）
UPDATE coach_availability_slots
   SET status = 'available', booked_session_id = NULL, updated_at = NOW()
 WHERE booked_session_id IN (
   SELECT cs.id FROM course_sessions cs
    WHERE cs.course_period_id IN ('e3000000-0000-4000-8000-00000000c004','e3000000-0000-4000-8000-0000000e0007',
                                  '5f69d4b7-d8a4-4e1f-bae3-ffdc35ae7f39','ca047420-09eb-42c1-b905-b8e667e2beab',
                                  'd18491e0-f0e0-4d23-9fc1-0c2621f01f68','e2542773-12b8-46ac-bfbc-9abefccac049',
                                  'ba4c1d34-3c34-42da-b195-abb25c69f530')
      AND NOT EXISTS (SELECT 1 FROM course_period_enrollments cpe
                       WHERE cpe.course_period_id = cs.course_period_id AND cpe.status='active'));
DELETE FROM course_periods
 WHERE id IN ('e3000000-0000-4000-8000-00000000c004','e3000000-0000-4000-8000-0000000e0007',
              '5f69d4b7-d8a4-4e1f-bae3-ffdc35ae7f39','ca047420-09eb-42c1-b905-b8e667e2beab',
              'd18491e0-f0e0-4d23-9fc1-0c2621f01f68','e2542773-12b8-46ac-bfbc-9abefccac049',
              'ba4c1d34-3c34-42da-b195-abb25c69f530')
   AND NOT EXISTS (SELECT 1 FROM course_period_enrollments cpe
                    WHERE cpe.course_period_id = course_periods.id AND cpe.status='active');
COMMIT;
