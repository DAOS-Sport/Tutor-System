-- CANDIDATE ONLY. Run preflight first; do not apply remotely without root approval.
-- Keep this expression identical to PHONE_CANONICAL_SQL in admin/families.js.
BEGIN;
SET LOCAL lock_timeout = '3s';
CREATE UNIQUE INDEX uq_parents_phone_canonical_active
  ON parents ((
    CASE
      WHEN regexp_replace(normalize(COALESCE(phone, ''), NFKC), '\D', '', 'g') LIKE '8869%'
      THEN '0' || SUBSTRING(regexp_replace(normalize(COALESCE(phone, ''), NFKC), '\D', '', 'g') FROM 4)
      ELSE regexp_replace(normalize(COALESCE(phone, ''), NFKC), '\D', '', 'g')
    END
  ))
  WHERE COALESCE(is_active, TRUE) = TRUE
    AND (CASE
      WHEN regexp_replace(normalize(COALESCE(phone, ''), NFKC), '\D', '', 'g') LIKE '8869%'
      THEN '0' || SUBSTRING(regexp_replace(normalize(COALESCE(phone, ''), NFKC), '\D', '', 'g') FROM 4)
      ELSE regexp_replace(normalize(COALESCE(phone, ''), NFKC), '\D', '', 'g')
    END) ~ '^09[0-9]{8}$';
COMMIT;
