-- 009_coach_portal.sql
-- 教練端 LINE OAuth 登入模組（/api/coach-portal）所需資料表。
-- 身分仍重用既有 coaches 表（H01 同步含 name / line_uid / is_active），此處只加：
--   1) coach_portal_sessions — 30 天 DB 持久化 session（重開 App / server 重啟免重走授權）
--   2) coach_oauth_states    — OAuth CSRF state + callback 後一次性 handoff（DB-backed）
-- 與 server/bootstrap/coreSchema.js 內容一致，皆 idempotent。

CREATE TABLE IF NOT EXISTS coach_portal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token VARCHAR(128) NOT NULL UNIQUE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  line_uid VARCHAR(100) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coach_portal_sessions_coach_id ON coach_portal_sessions(coach_id);
CREATE INDEX IF NOT EXISTS idx_coach_portal_sessions_expires_at ON coach_portal_sessions(expires_at);

CREATE TABLE IF NOT EXISTS coach_oauth_states (
  token VARCHAR(128) PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,          -- 'csrf' | 'handoff'
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coach_oauth_states_expires_at ON coach_oauth_states(expires_at);
