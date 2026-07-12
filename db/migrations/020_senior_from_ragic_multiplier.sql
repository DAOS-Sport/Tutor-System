-- H23/Ragic 課程係數為教練分類的唯一真相：倍率 != 1 即資深教練。
-- 同步程式會持續維護此 invariant；本 migration 修正既有歷史資料。
UPDATE admin_staff
   SET is_senior = (COALESCE(multiplier, 1.00) <> 1.00),
       updated_at = NOW()
 WHERE is_senior IS DISTINCT FROM (COALESCE(multiplier, 1.00) <> 1.00);

UPDATE coaches
   SET is_senior = (COALESCE(pricing_multiplier, 1.00) <> 1.00),
       updated_at = NOW()
 WHERE is_senior IS DISTINCT FROM (COALESCE(pricing_multiplier, 1.00) <> 1.00);
