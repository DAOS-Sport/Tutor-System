function cleanVenueText(value) {
  return String(value == null ? '' : value).trim();
}

function venueItems(values) {
  if (Array.isArray(values)) return values;
  if (typeof values === 'string') {
    const text = values.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* fall through */ }
    }
    return text.split(/[,\n、，;；]+/);
  }
  return values == null ? [] : [values];
}

function cleanVenueList(values) {
  return Array.from(new Set(venueItems(values)
    .map(cleanVenueText)
    .filter(Boolean)));
}

// Requires outer aliases:
//   c = coaches
//   s = admin_staff, joined by s.id = c.ragic_employee_id
const COACH_VENUE_SOURCE_SQL = `
  SELECT DISTINCT venue_id
    FROM (
      SELECT TRIM(sv.venue_id) AS venue_id
        FROM admin_staff_venues sv
       WHERE sv.staff_id = c.ragic_employee_id
      UNION
      SELECT TRIM(s.venue_id) AS venue_id
       WHERE s.venue_id IS NOT NULL AND TRIM(s.venue_id) <> ''
      UNION
      SELECT TRIM(cv.venue_id) AS venue_id
        FROM coach_venues cv
       WHERE cv.coach_id = c.id
         AND s.id IS NULL
    ) raw_venues
   WHERE venue_id IS NOT NULL AND venue_id <> ''
`;

const COACH_VENUE_IDS_SELECT = `COALESCE(
  (SELECT array_agg(v.venue_id ORDER BY v.venue_id)
     FROM (${COACH_VENUE_SOURCE_SQL}) v),
  ARRAY[]::text[]
)`;

// Requires outer aliases:
//   c = coaches
//   s = admin_staff, joined by s.id = c.ragic_employee_id
// Coach app-facing identity fields are sourced from F-A02 admin_staff first.
const COACH_STAFF_PROFILE_SELECT = `
  c.id,
  c.ragic_employee_id,
  COALESCE(NULLIF(TRIM(s.name), ''), c.name) AS name,
  COALESCE(NULLIF(TRIM(s.phone), ''), c.phone) AS phone,
  COALESCE(NULLIF(TRIM(c.line_uid), ''), NULLIF(TRIM(s.line_uid), '')) AS line_uid,
  c.email,
  c.specialties,
  -- H23/Ragic 課程係數是分類的唯一真相：倍率不是 1 即為資深教練。
  -- 不讀歷史 is_senior，避免倍率已同步但布林欄位仍停在舊值時家長端分類錯誤。
  (COALESCE(s.multiplier, c.pricing_multiplier, 1.00) <> 1.00) AS is_senior,
  COALESCE(s.multiplier, c.pricing_multiplier, 1.00) AS pricing_multiplier,
  c.bio_rich_text,
  -- 大頭照（相對路徑）。加進白名單 PUBLIC_COACH_FIELDS 還不夠：publicCoach 只複製
  -- 「不是 undefined」的欄位，這裡沒 SELECT 的欄位在那邊就是 undefined，會被無聲
  -- 跳過 —— 上傳成功、DB 有值、家長端永遠看不到。實測踩過。
  -- 註：這整段是 JS 模板字串，註解裡不可以出現反引號，會把字串提前關掉。
  c.avatar_url,
  c.intro_review_status,
  c.intro_review_note,
  c.intro_submitted_at,
  c.intro_reviewed_at,
  c.intro_reviewed_by,
  c.ragic_record_id,
  c.ragic_data_no,
  c.created_at,
  c.updated_at,
  COALESCE(c.is_placeholder, FALSE) AS is_placeholder,
  c.is_active AS coach_profile_active,
  s.active AS staff_active,
  (COALESCE(s.active, FALSE) AND COALESCE(c.is_active, FALSE)) AS is_active,
  ${COACH_VENUE_IDS_SELECT} AS venue_ids
`;

// Requires outer alias:
//   s = admin_staff
const STAFF_VENUE_SOURCE_SQL = `
  SELECT DISTINCT venue_id
    FROM (
      SELECT TRIM(sv.venue_id) AS venue_id
        FROM admin_staff_venues sv
       WHERE sv.staff_id = s.id
      UNION
      SELECT TRIM(s.venue_id) AS venue_id
       WHERE s.venue_id IS NOT NULL AND TRIM(s.venue_id) <> ''
    ) raw_venues
   WHERE venue_id IS NOT NULL AND venue_id <> ''
`;

const STAFF_VENUE_IDS_SELECT = `COALESCE(
  (SELECT array_agg(v.venue_id ORDER BY v.venue_id)
     FROM (${STAFF_VENUE_SOURCE_SQL}) v),
  ARRAY[]::text[]
)`;

// Requires outer aliases:
//   u = admin_users
//   s = admin_staff, joined from u.staff_id
const ADMIN_USER_VENUE_SOURCE_SQL = `
  SELECT DISTINCT venue_id
    FROM (
      SELECT TRIM(sv.venue_id) AS venue_id
        FROM admin_staff_venues sv
       WHERE sv.staff_id = COALESCE(s.id, u.staff_id)
      UNION
      SELECT TRIM(s.venue_id) AS venue_id
       WHERE s.venue_id IS NOT NULL AND TRIM(s.venue_id) <> ''
      UNION
      SELECT TRIM(u.venue_id) AS venue_id
       WHERE u.venue_id IS NOT NULL AND TRIM(u.venue_id) <> ''
    ) raw_venues
   WHERE venue_id IS NOT NULL AND venue_id <> ''
`;

const ADMIN_USER_VENUE_IDS_SELECT = `COALESCE(
  (SELECT array_agg(v.venue_id ORDER BY v.venue_id)
     FROM (${ADMIN_USER_VENUE_SOURCE_SQL}) v),
  ARRAY[]::text[]
)`;

module.exports = {
  cleanVenueText,
  cleanVenueList,
  COACH_VENUE_SOURCE_SQL,
  COACH_VENUE_IDS_SELECT,
  COACH_STAFF_PROFILE_SELECT,
  STAFF_VENUE_SOURCE_SQL,
  STAFF_VENUE_IDS_SELECT,
  ADMIN_USER_VENUE_SOURCE_SQL,
  ADMIN_USER_VENUE_IDS_SELECT,
};
