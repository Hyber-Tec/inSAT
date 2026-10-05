-- ============================================================================
-- insat - application schema (PostgreSQL 14+)
-- ----------------------------------------------------------------------------
-- All application tables are prefixed `pa_` so they never collide with the
-- legacy scaffolding tables (users, tests, items, …) that shipped in earlier
-- versions of this repo and were never wired up. This file is idempotent
-- (CREATE … IF NOT EXISTS); the API applies it on first boot when `pa_users`
-- is absent, and never re-runs destructively. Seeding of the admin user and
-- the default blueprints happens in the API bootstrap (needs bcrypt), not here.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- Identity ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS pa_users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT UNIQUE NOT NULL,            -- stored lowercased by the app
  password_hash         TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('admin', 'student')),
  must_change_password  BOOLEAN NOT NULL DEFAULT false,
  active                BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pa_users_role ON pa_users(role);

-- ---------- Groups (e.g. "GA Summer SAT") ------------------------------------

CREATE TABLE IF NOT EXISTS pa_groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pa_group_members (
  group_id   UUID NOT NULL REFERENCES pa_groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES pa_users(id)  ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pa_group_members_user ON pa_group_members(user_id);

-- ---------- Figure assets (PNGs imported from satGen) ------------------------

CREATE TABLE IF NOT EXISTS pa_assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mime        TEXT NOT NULL DEFAULT 'image/png',
  bytes       BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Item bank (the source of truth, normalized from satGen) ----------

CREATE TABLE IF NOT EXISTS pa_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash  TEXT UNIQUE,                                  -- dedupe key
  section       TEXT NOT NULL CHECK (section IN ('rw', 'math')),
  domain        TEXT NOT NULL DEFAULT '',                     -- taxonomy id: algebra, info-ideas, …
  skill         TEXT NOT NULL DEFAULT '',                     -- subcategory / satGen skill_tag
  difficulty    TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  passage       TEXT,                                         -- rw passage / stimulus (null for math)
  question      TEXT NOT NULL,                                -- the stem
  choices       JSONB NOT NULL,                               -- ["A text","B text","C text","D text"]
  correct_idx   SMALLINT NOT NULL DEFAULT 0 CHECK (correct_idx BETWEEN 0 AND 3),
  answer_type   TEXT NOT NULL DEFAULT 'multiple-choice',
  rationale     JSONB NOT NULL DEFAULT '{}'::jsonb,           -- {correct, A, B, C, D}
  figure        JSONB,                                        -- {type, description, data, bbox}
  asset_id      UUID REFERENCES pa_assets(id) ON DELETE SET NULL,
  source        TEXT NOT NULL DEFAULT 'manual',               -- ai-generated | extracted-from-upload | manual
  verified      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pa_items_pick
  ON pa_items(section, domain, difficulty) WHERE retired_at IS NULL;

-- ---------- Blueprints (College-Board test structure) ------------------------

CREATE TABLE IF NOT EXISTS pa_blueprints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  spec          JSONB NOT NULL,                               -- sections -> modules -> domain/difficulty quotas
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Exams (a named, assignable instance of a blueprint) --------------

CREATE TABLE IF NOT EXISTS pa_exams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  code          TEXT UNIQUE,
  blueprint_id  UUID NOT NULL REFERENCES pa_blueprints(id) ON DELETE RESTRICT,
  timing_mode   TEXT NOT NULL DEFAULT 'full' CHECK (timing_mode IN ('full', 'demo', 'untimed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Exam folders (institution-scoped grouping of exams) --------------
-- Named containers so admins can organize exams instead of one flat list.
-- Many-to-many: an exam may belong to several folders (none = "Ungrouped").

CREATE TABLE IF NOT EXISTS pa_exam_folders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  parent_id     UUID REFERENCES pa_exam_folders(id) ON DELETE CASCADE,  -- one level of nesting
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pa_exam_folder_members (
  folder_id  UUID NOT NULL REFERENCES pa_exam_folders(id) ON DELETE CASCADE,
  exam_id    UUID NOT NULL REFERENCES pa_exams(id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, exam_id)
);

-- ---------- Assignments (exam -> a student OR a whole group) -----------------

CREATE TABLE IF NOT EXISTS pa_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id       UUID NOT NULL REFERENCES pa_exams(id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL CHECK (target_type IN ('user', 'group')),
  user_id       UUID REFERENCES pa_users(id)  ON DELETE CASCADE,
  group_id      UUID REFERENCES pa_groups(id) ON DELETE CASCADE,
  assigned_by   UUID REFERENCES pa_users(id)  ON DELETE SET NULL,
  due_at        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (target_type = 'user'  AND user_id  IS NOT NULL AND group_id IS NULL) OR
    (target_type = 'group' AND group_id IS NOT NULL AND user_id  IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_pa_assignments_user  ON pa_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_pa_assignments_group ON pa_assignments(group_id);

-- ---------- Sessions (one student's attempt; holds the unique form) ----------
-- `form` is the materialized, per-attempt question set (this is what makes
-- every exam differ). It contains the correct answers + rationales and is
-- NEVER sent to the client verbatim — the API sanitizes it for delivery and
-- scores submissions server-side.

CREATE TABLE IF NOT EXISTS pa_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   UUID REFERENCES pa_assignments(id) ON DELETE SET NULL,
  exam_id         UUID NOT NULL REFERENCES pa_exams(id) ON DELETE RESTRICT,
  user_id         UUID NOT NULL REFERENCES pa_users(id) ON DELETE CASCADE,
  form            JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  state           JSONB NOT NULL DEFAULT '{}'::jsonb,        -- resume state: answers / marked / crossed / position
  routing         JSONB NOT NULL DEFAULT '{}'::jsonb,        -- {rw:'easy'|'hard', math:'easy'|'hard'}
  rw_scaled       INT,
  math_scaled     INT,
  total_scaled    INT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pa_sessions_user ON pa_sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pa_sessions_exam ON pa_sessions(exam_id);

-- ---------- Responses (per-question record, written at module submit) --------

CREATE TABLE IF NOT EXISTS pa_responses (
  session_id      UUID NOT NULL REFERENCES pa_sessions(id) ON DELETE CASCADE,
  q_instance_id   TEXT NOT NULL,                             -- per-form question instance id
  item_id         UUID,                                      -- underlying bank item (nullable)
  module_key      TEXT NOT NULL,                             -- 'rw:1' | 'rw:2' | 'math:1' | 'math:2'
  selected_idx    SMALLINT,
  correct         BOOLEAN,
  is_marked       BOOLEAN NOT NULL DEFAULT false,
  time_spent_ms   INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, q_instance_id)
);

-- ---------- Convenience view: completed results ------------------------------

CREATE OR REPLACE VIEW pa_v_results AS
SELECT
  s.id            AS session_id,
  u.id            AS user_id,
  u.email,
  u.display_name,
  e.title         AS exam_title,
  e.code          AS exam_code,
  s.started_at,
  s.completed_at,
  s.rw_scaled,
  s.math_scaled,
  s.total_scaled
FROM pa_sessions s
  JOIN pa_users u ON u.id = s.user_id
  JOIN pa_exams e ON e.id = s.exam_id
WHERE s.status = 'completed';
