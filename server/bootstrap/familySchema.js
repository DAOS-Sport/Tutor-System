/**
 * 家庭帳號的資料表（docs/family_accounts_spec_2026-09-23.md §3、§14）。
 *
 * families／family_members 最早由 db/migrations/010 建立，但 010 從沒接進開機流程：
 * 正式庫有這兩張表（0 筆），乾淨資料庫開機時卻沒有。所以這裡「完整 CREATE（給乾淨庫）
 * ＋ ADD COLUMN IF NOT EXISTS（給已經有 010 的庫）」。
 *
 * 必須在 bootstrapCore 之後跑（要參照 parents／students；bootstrapAdmin 比 core 早，放不進去）。
 * 開機失敗會拒絕接流量，所以每一句都要可重跑、約束一律先查再加。
 * 刻意不拿掉 010 的 UNIQUE(line_uid)：新設計不用 line_uid（一律 NULL，UNIQUE 允許多個 NULL），
 * 拿掉反而會讓 Replit 發布對話框多出一個 DROP。
 * 發布前要先在 dev 庫跑過，否則下次發布會把正式庫改回 dev 的樣子。
 */
const { pool } = require('../models/db');

// 成員相對於家裡孩子的關係（§1）
const RELATIONSHIPS = [
  'father', 'mother', 'grandfather', 'grandmother',
  'maternal_grandfather', 'maternal_grandmother', 'guardian',
];

// 加 CHECK 約束：已存在就跳過；既有資料不符合時只警告、不讓開機失敗
function addCheck(table, name, expr) {
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
    BEGIN
      ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr});
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING '[familySchema] ${name} 既有資料不符，暫不加約束（需人工排查）';
    END;
  END IF;
END $$;`;
}

const relationshipList = RELATIONSHIPS.map((r) => `'${r}'`).join(',');

const SQL = `
CREATE TABLE IF NOT EXISTS families (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  name            VARCHAR(100),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE families ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE families ADD COLUMN IF NOT EXISTS created_by TEXT;
${addCheck('families', 'families_status_check', "status IN ('active','frozen')")}

CREATE TABLE IF NOT EXISTS family_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  line_uid    VARCHAR(100) UNIQUE,
  parent_id   UUID REFERENCES parents(id) ON DELETE SET NULL,
  role        VARCHAR(20) NOT NULL DEFAULT 'member',
  status      VARCHAR(20) NOT NULL DEFAULT 'active',
  invited_by  UUID REFERENCES parents(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS relationship TEXT;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS linked_by TEXT;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS revoked_by TEXT;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS note TEXT;
${addCheck('family_members', 'family_members_role_check', "role IN ('owner','member')")}
${addCheck('family_members', 'family_members_status_check', "status IN ('active','revoked')")}
${addCheck('family_members', 'family_members_relationship_check', `relationship IS NULL OR relationship IN (${relationshipList})`)}
CREATE INDEX IF NOT EXISTS idx_family_members_family ON family_members(family_id);
-- 決策 3：一個帳號同一時間只屬於一個家庭（退出後可以再加入別的家庭，所以只鎖 active）
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_members_active_parent
  ON family_members(parent_id) WHERE status = 'active' AND parent_id IS NOT NULL;
-- 一個家庭同一時間只有一位擁有者
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_members_active_owner
  ON family_members(family_id) WHERE role = 'owner' AND status = 'active';

CREATE TABLE IF NOT EXISTS family_audit_logs (
  id               BIGSERIAL PRIMARY KEY,
  family_id        UUID REFERENCES families(id) ON DELETE CASCADE,
  action           TEXT NOT NULL,
  actor            TEXT,
  target_parent_id UUID,
  detail           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_family_audit_logs_family ON family_audit_logs(family_id, created_at DESC);

-- §14 家長自助合併申請
CREATE TABLE IF NOT EXISTS family_join_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_parent_id  UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  target_student_id    UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  duplicate_student_id UUID REFERENCES students(id) ON DELETE SET NULL,
  relationship         TEXT NOT NULL,
  note                 TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',
  reviewed_by          TEXT,
  reviewed_at          TIMESTAMPTZ,
  reject_reason        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
${addCheck('family_join_requests', 'family_join_requests_status_check', "status IN ('pending','approved','rejected','cancelled')")}
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_join_requests_pending
  ON family_join_requests(applicant_parent_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_family_join_requests_status ON family_join_requests(status, created_at DESC);

-- 申請的嘗試次數（含身分證／生日不符的），防止拿申請功能試身分證
CREATE TABLE IF NOT EXISTS family_join_attempts (
  id         BIGSERIAL PRIMARY KEY,
  parent_id  UUID NOT NULL,
  matched    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_family_join_attempts_parent ON family_join_attempts(parent_id, created_at DESC);

-- 第二階段：櫃台先登記家人手機，對方註冊時自動加入家庭
CREATE TABLE IF NOT EXISTS family_pending_members (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  phone_canonical   TEXT NOT NULL,
  relationship      TEXT NOT NULL,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  claimed_parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  claimed_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_pending_members_phone
  ON family_pending_members(phone_canonical) WHERE claimed_parent_id IS NULL;
`;

async function bootstrap(db = pool) {
  await db.query(SQL);
}

module.exports = { bootstrap, SQL, RELATIONSHIPS };
