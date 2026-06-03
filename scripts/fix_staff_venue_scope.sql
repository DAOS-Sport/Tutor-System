-- ============================================================================
-- #2 修復：正式環境 F-M02 待對帳清單（與今日課程／簽到／團購審核）看不到
-- ----------------------------------------------------------------------------
-- 根因：後端對 manager/staff 依「所屬場館(venue scope)」過濾資料；若帳號沒有任何
--      場館，getScopedVenueIds 回 fail-closed（清單全空）。預覽環境的 seed 帳號
--      (manager/staff) 有場館 'B' 所以正常；正式環境的真實帳號（手動建立或 Ragic
--      同步、建立時沒選場館）可能沒場館 → 全空。
--
-- 用法：在「Production DB」的 SQL console 執行。先跑【步驟一】診斷，確認受影響帳號，
--      再依帳號型態跑【步驟二 A 或 B】補場館。皆為 idempotent，不破壞既有資料。
--      請把 '你的場館ID' 換成該帳號實際所屬場館（venues.id，例如 'B'）。
-- ============================================================================

-- 【步驟一】診斷：列出所有 manager/staff 及其場館來源
--   sv_venues = 透過 admin_staff_venues（以 staff_id 關聯）拿到的場館
--   venue_id  = admin_users 自身的 fallback 場館
--   兩者皆空 → 就是看不到清單的帳號
SELECT u.id, u.username, u.role, u.staff_id, u.venue_id,
       (SELECT array_agg(sv.venue_id) FROM admin_staff_venues sv WHERE sv.staff_id = u.staff_id) AS sv_venues
FROM admin_users u
WHERE u.role IN ('manager','staff')
ORDER BY u.role, u.username;

-- 可用場館清單（補場館時挑這裡的 id）
SELECT id, name, is_active FROM venues ORDER BY id;

-- ----------------------------------------------------------------------------
-- 【步驟二 A】帳號「有」staff_id（對應 admin_staff 員工）：補 admin_staff_venues
--   （也可改用後台「F-A02 員工帳號管理」勾選場館，效果相同）
-- INSERT INTO admin_staff_venues (staff_id, venue_id)
--   SELECT u.staff_id, '你的場館ID'
--   FROM admin_users u WHERE u.username = '受影響帳號'
-- ON CONFLICT DO NOTHING;

-- 【步驟二 B】帳號「沒有」staff_id（純登入帳號）：改補 admin_users.venue_id
--   （此時不能寫 admin_staff_venues，登入查詢 join 不到）
-- UPDATE admin_users SET venue_id = '你的場館ID'
--  WHERE username = '受影響帳號' AND (staff_id IS NULL);

-- ----------------------------------------------------------------------------
-- 補完後：請該帳號「重新登入」（場館範圍寫在登入發的 JWT 內，舊 token 不會更新）。
-- 之後 F-M02 待對帳、今日課程、簽到、團購審核等清單即會出現。
-- ============================================================================
