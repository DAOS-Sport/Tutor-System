-- Emits only duplicate group / row counts; never emits phone strings or IDs.
WITH canonical AS (
  SELECT CASE
    WHEN regexp_replace(normalize(COALESCE(phone, ''), NFKC), '\D', '', 'g') LIKE '8869%'
    THEN '0' || SUBSTRING(regexp_replace(normalize(COALESCE(phone, ''), NFKC), '\D', '', 'g') FROM 4)
    ELSE regexp_replace(normalize(COALESCE(phone, ''), NFKC), '\D', '', 'g')
  END AS phone_key
  FROM parents
  WHERE COALESCE(is_active, TRUE) = TRUE
)
SELECT COUNT(*)::int AS duplicate_group_count,
       COALESCE(SUM(rows_per_key - 1), 0)::int AS excess_rows
FROM (
  SELECT phone_key, COUNT(*)::int AS rows_per_key
  FROM canonical
  WHERE phone_key ~ '^09[0-9]{8}$'
  GROUP BY phone_key
  HAVING COUNT(*) > 1
) duplicates;
