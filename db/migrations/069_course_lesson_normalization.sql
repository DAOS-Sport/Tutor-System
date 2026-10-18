-- Stored physical-class identity. Raw attendance, per-student entitlements and
-- deductions are retained. This migration creates schema only; no data repair.
CREATE TABLE IF NOT EXISTS course_lesson_normalizations (
  lesson_key TEXT PRIMARY KEY CHECK (lesson_key ~ '^[0-9a-f]{32}$'),
  representative_session_id UUID NOT NULL REFERENCES course_sessions(id) ON DELETE RESTRICT,
  source_session_count INTEGER NOT NULL CHECK (source_session_count >= 2),
  source_period_count INTEGER NOT NULL CHECK (source_period_count >= 2),
  purchase_kind TEXT NOT NULL CHECK (purchase_kind IN ('group','batch')),
  purchase_id UUID NOT NULL,
  period_number INTEGER NOT NULL CHECK (period_number > 0),
  class_date DATE NOT NULL,
  venue_id TEXT NOT NULL,
  coach_id UUID NOT NULL,
  course_type INTEGER NOT NULL,
  is_experience_course BOOLEAN NOT NULL DEFAULT false,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  roster_student_ids UUID[] NOT NULL CHECK (cardinality(roster_student_ids) > 1),
  policy TEXT NOT NULL CHECK (policy = 'WHOLE_CLASS_ANY_ATTENDED_V1'),
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{32}$'),
  before_snapshot JSONB NOT NULL,
  task_id TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT
);
CREATE TABLE IF NOT EXISTS course_lesson_normalization_members (
  source_session_id UUID PRIMARY KEY REFERENCES course_sessions(id) ON DELETE RESTRICT,
  lesson_key TEXT NOT NULL REFERENCES course_lesson_normalizations(lesson_key) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_lesson_normalization_members_key
  ON course_lesson_normalization_members(lesson_key);

CREATE OR REPLACE VIEW v_course_lesson_payroll AS
WITH source AS (
  SELECT cs.id AS source_session_id,cs.course_period_id,
    COALESCE(n.lesson_key,cs.id::text) AS canonical_lesson_id,
    n.lesson_key AS normalization_id,n.roster_student_ids,n.policy,
    cp.course_type,cp.venue_id::text AS venue_id,COALESCE(cs.coach_id,cp.coach_id) AS coach_id,
    (cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date AS class_date,
    COALESCE(cp.is_experience_course,false) AS is_experience_course,
    COALESCE(cs.duration_minutes,60) AS duration_minutes,
    EXISTS (SELECT 1 FROM checkin_records cr WHERE cr.course_session_id=cs.id
      AND cr.attendance_status='ATTENDED') AND cs.status::text NOT LIKE 'cancelled%' AS attended,
    (SELECT min(cr.checked_in_at) FROM checkin_records cr WHERE cr.course_session_id=cs.id
      AND cr.attendance_status='ATTENDED' AND cs.status::text NOT LIKE 'cancelled%') AS checkin_at,
    CASE WHEN n.lesson_key IS NULL THEN true ELSE
      cp.course_type=n.course_type AND cp.venue_id::text=n.venue_id
      AND COALESCE(cs.coach_id,cp.coach_id)=n.coach_id
      AND (cs.scheduled_at AT TIME ZONE 'Asia/Taipei')::date=n.class_date
      AND COALESCE(ae.period_number,cp.period_number,1)=n.period_number
      AND COALESCE(cp.group_order_id,ae.group_order_id,cp.enrollment_batch_id,ae.enrollment_batch_id)=n.purchase_id
      AND COALESCE(cp.is_experience_course,false)=n.is_experience_course
      AND COALESCE(cs.duration_minutes,60)=n.duration_minutes
      AND (SELECT count(*) FROM course_lesson_normalization_members nm WHERE nm.lesson_key=n.lesson_key)=n.source_session_count
    END AS source_valid
  FROM course_sessions cs JOIN course_periods cp ON cp.id=cs.course_period_id
  LEFT JOIN admin_enrollments ae ON ae.id=cp.admin_enrollment_id
  LEFT JOIN course_lesson_normalization_members m ON m.source_session_id=cs.id
  LEFT JOIN course_lesson_normalizations n ON n.lesson_key=m.lesson_key AND n.active
), classes AS (
  SELECT canonical_lesson_id,min(normalization_id) AS normalization_id,
    array_agg(source_session_id ORDER BY source_session_id) AS source_session_ids,
    array_agg(DISTINCT course_period_id ORDER BY course_period_id) AS source_period_ids,
    min(course_type) AS course_type,min(venue_id) AS venue_id,
    (array_agg(coach_id ORDER BY source_session_id))[1] AS coach_id,min(class_date) AS class_date,
    bool_or(is_experience_course) AS is_experience_course,min(duration_minutes) AS duration_minutes,
    bool_and(COALESCE(source_valid,false)) AS source_valid,bool_or(attended) AS consumed,
    min(checkin_at) AS checkin_at,min(policy) AS policy
  FROM source GROUP BY canonical_lesson_id
)
SELECT c.*,
  CASE WHEN c.consumed AND c.source_valid THEN 1 ELSE 0 END::integer AS payroll_lesson_count,
  CASE WHEN c.normalization_id IS NOT NULL THEN n.roster_student_ids ELSE
    ARRAY(SELECT DISTINCT ce.student_id FROM course_period_enrollments ce
      WHERE ce.course_period_id=ANY(c.source_period_ids) AND ce.status='active' ORDER BY ce.student_id)
  END AS roster_student_ids
FROM classes c LEFT JOIN course_lesson_normalizations n ON n.lesson_key=c.normalization_id;
