-- 010_customer_family_base.sql
-- ─────────────────────────────────────────────────────────────────────────
-- 「客戶資料管理」(Z01 家長&學員關係 / Z02 學員資料) 的後端基底。
--
-- 1) 家庭/邀請基底（Replit-only overlay；前台暫不露出）
--    設計討論定案：被邀請的家庭成員可能「沒有電話、沒有 Ragic 記錄」，塞不進
--    parents(phone NOT NULL UNIQUE)，故 family_members 獨立成表，以 line_uid 為登入身分。
--    Ragic 不建模家庭概念 → 此層永不回寫 Ragic。
--
-- 2) 順手收掉先前 introspect 發現、且會影響同步正確性的兩個漂移：
--    - students.id_number / ragic_record_id 在線上為「可空、非 UNIQUE」，但同步比對
--      與認領驗證都依賴它 → 補 partial unique（NULL 不受限）。
--    - parents.ragic_record_id 同理。
--
-- 注意：db/migrate.js 會「每次重跑所有 .sql」，故本檔所有 DDL 必須冪等
--      （IF NOT EXISTS / 條件式建立）。唯一索引在資料尚有重複時會建失敗，故以
--      DO 區塊先檢查重複，有重複則只建一般索引並 RAISE NOTICE，不讓 migration 中斷。
-- ─────────────────────────────────────────────────────────────────────────

-- 1) 家庭層 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS families (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
  name            VARCHAR(100),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS family_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  -- 被邀請成員可能尚無 parents row（沒電話/沒 Ragic 記錄）→ 以 line_uid 為登入身分。
  line_uid    VARCHAR(100) UNIQUE,
  parent_id   UUID REFERENCES parents(id) ON DELETE SET NULL,
  role        VARCHAR(20) NOT NULL DEFAULT 'member',   -- owner | member
  status      VARCHAR(20) NOT NULL DEFAULT 'active',   -- active | invited | revoked
  invited_by  UUID REFERENCES parents(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_family_members_family ON family_members(family_id);

-- parents / students 預留 family_id（nullable；前台不露出）
ALTER TABLE parents  ADD COLUMN IF NOT EXISTS family_id UUID REFERENCES families(id) ON DELETE SET NULL;
ALTER TABLE students ADD COLUMN IF NOT EXISTS family_id UUID REFERENCES families(id) ON DELETE SET NULL;

-- 2) 完整性修補（資料尚未清洗 → 有重複時安全降級為一般索引） ──────────────────
DO $$
BEGIN
  -- students.id_number：唯一性限定在「同一家長底下」，不可做全域 UNIQUE。
  --   原因：家庭共享模型下，同一個孩子（同身分證）可能同時掛在父、母兩筆家長記錄下，
  --   全域 UNIQUE 會擋掉這個合法情境，也會讓既有登入同步在這種資料上拋 23505。
  --   清掉先前可能存在的全域 UNIQUE，改為 (parent_id, id_number) 複合唯一。
  --   注意：001_initial_schema.sql 用 "id_number NOT NULL UNIQUE" 建表時，Postgres 會建一個
  --   「約束」students_id_number_key（非單純索引）→ 必須用 DROP CONSTRAINT 才移得掉；
  --   coreSchema bootstrap 路徑則沒有全域 UNIQUE，DROP 皆為 no-op。兩條路徑都安全。
  ALTER TABLE students DROP CONSTRAINT IF EXISTS students_id_number_key;
  DROP INDEX IF EXISTS uq_students_id_number;
  IF EXISTS (
    SELECT parent_id, id_number FROM students WHERE id_number IS NOT NULL
    GROUP BY parent_id, id_number HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE '[010] (parent_id,id_number) 有重複，暫以一般索引取代 UNIQUE（清洗後可改 UNIQUE）';
    DROP INDEX IF EXISTS uq_students_parent_idnum;
    CREATE INDEX IF NOT EXISTS ix_students_parent_idnum ON students(parent_id, id_number) WHERE id_number IS NOT NULL;
  ELSE
    DROP INDEX IF EXISTS ix_students_parent_idnum;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_students_parent_idnum ON students(parent_id, id_number) WHERE id_number IS NOT NULL;
  END IF;

  -- parents.ragic_record_id（全域唯一：一筆 Ragic 對一筆本地鏡像）
  IF EXISTS (
    SELECT ragic_record_id FROM parents WHERE ragic_record_id IS NOT NULL
    GROUP BY ragic_record_id HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE '[010] parents.ragic_record_id 有重複，暫以一般索引取代 UNIQUE';
    DROP INDEX IF EXISTS uq_parents_ragic_record_id;
    CREATE INDEX IF NOT EXISTS ix_parents_ragic_record_id ON parents(ragic_record_id) WHERE ragic_record_id IS NOT NULL;
  ELSE
    DROP INDEX IF EXISTS ix_parents_ragic_record_id;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_parents_ragic_record_id ON parents(ragic_record_id) WHERE ragic_record_id IS NOT NULL;
  END IF;

  -- students.ragic_record_id（全域唯一）
  IF EXISTS (
    SELECT ragic_record_id FROM students WHERE ragic_record_id IS NOT NULL
    GROUP BY ragic_record_id HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE '[010] students.ragic_record_id 有重複，暫以一般索引取代 UNIQUE';
    DROP INDEX IF EXISTS uq_students_ragic_record_id;
    CREATE INDEX IF NOT EXISTS ix_students_ragic_record_id ON students(ragic_record_id) WHERE ragic_record_id IS NOT NULL;
  ELSE
    DROP INDEX IF EXISTS ix_students_ragic_record_id;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_students_ragic_record_id ON students(ragic_record_id) WHERE ragic_record_id IS NOT NULL;
  END IF;
END $$;
