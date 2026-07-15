-- 團報／家庭共班共享簽到正式啟用。
-- 任一有效家長或教練為同一堂簽到時，完整 active roster 共用該堂 attendance；
-- 一堂只以 DISTINCT course_session 扣一次，不按學員或家庭數倍增。
INSERT INTO application_feature_flags (key, enabled, allowed_phones, updated_at)
VALUES ('SHARED_CHECKIN_USAGE_V2', TRUE, '{}'::text[], NOW())
ON CONFLICT (key) DO UPDATE
  SET enabled = TRUE,
      allowed_phones = '{}'::text[],
      updated_at = NOW();
