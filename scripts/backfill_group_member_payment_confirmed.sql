-- U10 修補配套 backfill：把「對應 admin_enrollment 已 confirmed，但 group_order_members.payment_confirmed
-- 仍為 FALSE」的團報成員補標為已確認。對應修法見 server/routes/admin/enrollments.js 的 reconcile（U10 回寫）。
--
-- 為什麼需要：reconcile 的回寫只對「之後新對帳」生效；歷史上在修法前就已對帳的團報成員不會被回填，
-- 家長端團報狀態頁會持續顯示「已上傳，待確認」。本 backfill 一次補齊。
-- 冪等：payment_confirmed = FALSE 守門 → 重跑不會重複動列、不覆寫既有 confirmed_at。
-- 用法：先跑 \echo 的 SELECT 確認筆數，再跑 UPDATE。Production DB 需另行執行（預覽/正式為不同顆）。

-- 1) 乾跑：看會影響哪些成員
SELECT gom.id AS member_id, go.id AS group_order_id, p.name AS parent_name,
       gom.student_names, ae.status AS enrollment_status
  FROM group_order_members gom
  JOIN parents p           ON p.id = gom.parent_id
  JOIN group_orders go     ON go.id = gom.group_order_id
  JOIN admin_enrollments ae ON ae.group_order_id = gom.group_order_id
                            AND ae.parent_phone = p.phone
 WHERE ae.status = 'confirmed'
   AND gom.payment_confirmed = FALSE;

-- 2) 實際 backfill
UPDATE group_order_members gom
   SET payment_confirmed    = TRUE,
       payment_confirmed_at = NOW(),
       payment_confirmed_by = 'backfill-U10'
  FROM admin_enrollments ae
  JOIN parents p ON p.phone = ae.parent_phone
 WHERE ae.group_order_id = gom.group_order_id
   AND p.id = gom.parent_id
   AND ae.status = 'confirmed'
   AND gom.payment_confirmed = FALSE;
