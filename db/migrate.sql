-- ============================================================================
-- insat - multi-tenancy migration (idempotent, runs every boot).
-- ----------------------------------------------------------------------------
-- Adds institutions and an institution_id scope to every tenant table, plus
-- the 'superadmin' role. Safe to run repeatedly: ADD COLUMN IF NOT EXISTS,
-- CREATE ... IF NOT EXISTS, and constraint drop+recreate are all no-ops once
-- applied. The API backfills legacy rows into a default institution at boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pa_institutions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each institution's own LLM API key (encrypted at rest) + a display hint
-- (provider + last 4 chars). Never returned to the client.
ALTER TABLE pa_institutions ADD COLUMN IF NOT EXISTS llm_api_key_enc TEXT;
ALTER TABLE pa_institutions ADD COLUMN IF NOT EXISTS llm_key_hint TEXT;
-- Which provider the key belongs to (anthropic | openai | gemini | xai |
-- deepseek) and an optional model override. NULL provider => anthropic (legacy).
ALTER TABLE pa_institutions ADD COLUMN IF NOT EXISTS llm_provider TEXT;
ALTER TABLE pa_institutions ADD COLUMN IF NOT EXISTS llm_model    TEXT;

-- institution_id scope on every tenant table (NULL allowed for legacy/global rows)
ALTER TABLE pa_users       ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES pa_institutions(id) ON DELETE CASCADE;
ALTER TABLE pa_groups      ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES pa_institutions(id) ON DELETE CASCADE;
ALTER TABLE pa_items       ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES pa_institutions(id) ON DELETE CASCADE;
ALTER TABLE pa_blueprints  ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES pa_institutions(id) ON DELETE CASCADE;
ALTER TABLE pa_exams       ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES pa_institutions(id) ON DELETE CASCADE;
ALTER TABLE pa_assignments ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES pa_institutions(id) ON DELETE CASCADE;
ALTER TABLE pa_sessions    ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES pa_institutions(id) ON DELETE CASCADE;

-- Allow the superadmin role.
ALTER TABLE pa_users DROP CONSTRAINT IF EXISTS pa_users_role_check;
ALTER TABLE pa_users ADD CONSTRAINT pa_users_role_check CHECK (role IN ('superadmin', 'admin', 'student'));

-- Items dedupe is now PER institution (two academies may hold the same question).
ALTER TABLE pa_items DROP CONSTRAINT IF EXISTS pa_items_content_hash_key;
CREATE UNIQUE INDEX IF NOT EXISTS pa_items_inst_hash ON pa_items(institution_id, content_hash);

-- Exam codes are unique PER institution.
ALTER TABLE pa_exams DROP CONSTRAINT IF EXISTS pa_exams_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS pa_exams_inst_code ON pa_exams(institution_id, code);

-- Grid-in (student-produced response) support: the correct free-response value
-- on items, and the student's typed value on responses.
ALTER TABLE pa_items     ADD COLUMN IF NOT EXISTS answer_text   TEXT;
ALTER TABLE pa_responses ADD COLUMN IF NOT EXISTS selected_text TEXT;

-- Per-institution branding: an uploaded logo and an accent colour.
ALTER TABLE pa_institutions ADD COLUMN IF NOT EXISTS logo_asset_id UUID REFERENCES pa_assets(id) ON DELETE SET NULL;
ALTER TABLE pa_institutions ADD COLUMN IF NOT EXISTS accent        TEXT;

-- Scoping indexes.
CREATE INDEX IF NOT EXISTS idx_pa_users_inst       ON pa_users(institution_id);
CREATE INDEX IF NOT EXISTS idx_pa_groups_inst      ON pa_groups(institution_id);
CREATE INDEX IF NOT EXISTS idx_pa_items_inst       ON pa_items(institution_id, section, domain, difficulty) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pa_exams_inst       ON pa_exams(institution_id);
CREATE INDEX IF NOT EXISTS idx_pa_assignments_inst ON pa_assignments(institution_id);
CREATE INDEX IF NOT EXISTS idx_pa_sessions_inst    ON pa_sessions(institution_id);

-- Exam visibility: an admin can hide/disable an exam so students can't see or
-- take it, while the admin still sees it.
ALTER TABLE pa_exams ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- Standalone (fixed-form) exams built directly from an upload — a specific set
-- of questions, as opposed to blueprint-assembled exams. These carry their own
-- form and have no blueprint.
ALTER TABLE pa_exams ALTER COLUMN blueprint_id DROP NOT NULL;
ALTER TABLE pa_exams ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'blueprint';
ALTER TABLE pa_exams ADD COLUMN IF NOT EXISTS form JSONB;

-- Exam folders: institution-scoped named containers so admins can organize
-- exams into groups instead of one flat list. Many-to-many — an exam may live
-- in several folders; an exam in no folder is "Ungrouped". Deleting a folder
-- leaves its exams intact (only the membership rows cascade away); deleting an
-- exam drops its membership rows.
CREATE TABLE IF NOT EXISTS pa_exam_folders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pa_exam_folder_members (
  folder_id  UUID NOT NULL REFERENCES pa_exam_folders(id) ON DELETE CASCADE,
  exam_id    UUID NOT NULL REFERENCES pa_exams(id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, exam_id)
);

-- institution scope (added by ALTER like every other tenant table, so the column
-- exists whether the table came from schema.sql or this migration).
ALTER TABLE pa_exam_folders ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES pa_institutions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_pa_exam_folders_inst    ON pa_exam_folders(institution_id);
CREATE INDEX IF NOT EXISTS idx_pa_exam_folder_mem_exam ON pa_exam_folder_members(exam_id);

-- Subfolders: a folder may nest one level inside a parent folder, so admins can
-- keep e.g. "SAT Prep" → "Diagnostics" / "Full tests". Deleting a parent
-- cascades to its subfolders (their exams survive — only membership rows go).
ALTER TABLE pa_exam_folders ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES pa_exam_folders(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_pa_exam_folders_parent ON pa_exam_folders(parent_id);

-- Release control: a locked exam stays visible to its assignees but cannot be
-- started, so admins can assign work ahead of time without students doing it
-- early. unlocks_at optionally ends the lock automatically at a set moment
-- (NULL = locked until the admin unlocks it by hand).
ALTER TABLE pa_exams ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pa_exams ADD COLUMN IF NOT EXISTS unlocks_at TIMESTAMPTZ;

-- Per-assignment visibility: hide one exam from one group (or one student)
-- without touching the exam itself or its other assignments. Hidden
-- assignments vanish from the student dashboard and cannot be started.
ALTER TABLE pa_assignments ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;

-- Near-duplicate fingerprint (SimHash, 16 hex chars). Exact content_hash only
-- catches byte-identical items; this catches a reused Reading & Writing passage
-- or a math stem that came back reworded. Backfilled lazily on insert.
ALTER TABLE pa_items ADD COLUMN IF NOT EXISTS simhash TEXT;
CREATE INDEX IF NOT EXISTS idx_pa_items_simhash
  ON pa_items(institution_id, section, domain) WHERE simhash IS NOT NULL AND retired_at IS NULL;

-- Grid-in answers the source accepts, as printed ("7/6", "1.166", "1.167"), or
-- every value when a question has more than one solution ("30", "-30"). When
-- present, scoring matches against this list exactly (as the SAT does) instead
-- of the numeric tolerance used for items without one.
ALTER TABLE pa_items ADD COLUMN IF NOT EXISTS accepted JSONB;

-- Self-guided practice: a student starts a session with no exam behind it (a
-- full SAT, one section, or a set aimed at their weakest skills). Such a
-- session carries its own title and timing, and the request that built it.
ALTER TABLE pa_sessions ALTER COLUMN exam_id DROP NOT NULL;
ALTER TABLE pa_sessions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'assigned';
ALTER TABLE pa_sessions DROP CONSTRAINT IF EXISTS pa_sessions_kind_check;
ALTER TABLE pa_sessions ADD CONSTRAINT pa_sessions_kind_check CHECK (kind IN ('assigned', 'practice'));
ALTER TABLE pa_sessions ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE pa_sessions ADD COLUMN IF NOT EXISTS timing_mode TEXT;
ALTER TABLE pa_sessions ADD COLUMN IF NOT EXISTS practice JSONB;
CREATE INDEX IF NOT EXISTS idx_pa_sessions_practice ON pa_sessions(user_id, started_at DESC) WHERE kind = 'practice';

-- How closely an item reads like a question on a real digital SAT, 1-5, when it
-- was rated on import: 5 could appear unchanged on the test, 4 is exam-grade
-- with small departures, 3 is SAT-style practice off the exam's format. A full
-- practice test draws the most exam-like questions first. NULL is an item
-- written to the SAT's standard and verified blind, which counts as 4.
ALTER TABLE pa_items ADD COLUMN IF NOT EXISTS realism SMALLINT CHECK (realism BETWEEN 1 AND 5);

-- A question the variation engine made from another question in this bank
-- (functions/lib/variation): the source's wording and structure with new
-- numbers, solved exactly and checked again independently. Assembly never
-- serves a question and one of its variants in the same form, and prefers
-- questions whose source a student has not met yet.
ALTER TABLE pa_items ADD COLUMN IF NOT EXISTS variant_of UUID REFERENCES pa_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pa_items_variant_of ON pa_items(variant_of) WHERE variant_of IS NOT NULL;

-- A finished practice set the student discarded from their dashboard list. It
-- only leaves the list: the skill profile is built on it, the academy still
-- sees it in Progress, and its questions stay seen. (An unfinished set is
-- deleted outright when discarded.)
ALTER TABLE pa_sessions ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;

-- How an institution runs: 'self_guided' (its students practise on their own:
-- diagnostic, skill map, practice sets) or 'managed' (its admins assign tests
-- and practice topics and follow each student's results; students do assigned
-- work only). Chosen when the institution is created; the superadmin can change
-- it, and nothing is deleted when it changes.
ALTER TABLE pa_institutions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'self_guided';
ALTER TABLE pa_institutions DROP CONSTRAINT IF EXISTS pa_institutions_mode_check;
ALTER TABLE pa_institutions ADD CONSTRAINT pa_institutions_mode_check CHECK (mode IN ('self_guided', 'managed'));

-- A managed institution's SAT test (kind 'sat'): the whole digital SAT
-- ('full') or one section ('rw', 'math'), assembled anew for each attempt from
-- the same pool and the same specs as a self-guided test.
ALTER TABLE pa_exams ADD COLUMN IF NOT EXISTS scope TEXT;
ALTER TABLE pa_exams DROP CONSTRAINT IF EXISTS pa_exams_scope_check;
ALTER TABLE pa_exams ADD CONSTRAINT pa_exams_scope_check CHECK (scope IS NULL OR scope IN ('full', 'rw', 'math'));

-- An assignment gives a test (kind 'exam', with exam_id) or practice topics
-- (kind 'practice', practice = { skills, difficulty, perSkill }), built for
-- each student, like self-guided skill practice, when they start it.
ALTER TABLE pa_assignments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'exam';
ALTER TABLE pa_assignments ADD COLUMN IF NOT EXISTS practice JSONB;
ALTER TABLE pa_assignments ALTER COLUMN exam_id DROP NOT NULL;
ALTER TABLE pa_assignments DROP CONSTRAINT IF EXISTS pa_assignments_kind_check;
ALTER TABLE pa_assignments ADD CONSTRAINT pa_assignments_kind_check CHECK (
  (kind = 'exam' AND exam_id IS NOT NULL) OR (kind = 'practice' AND exam_id IS NULL AND practice IS NOT NULL)
);

-- The institution whose bank an institution's tests and practice draw on.
-- NULL, as it is for every real institution, is insat's question pool (the
-- bank of slug 'satify', functions/lib/pool.js); nothing in the app sets it. A
-- check that needs a bank of known questions points its throwaway institution
-- at itself.
ALTER TABLE pa_institutions ADD COLUMN IF NOT EXISTS pool_institution_id UUID REFERENCES pa_institutions(id) ON DELETE SET NULL;
