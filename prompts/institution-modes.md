# Prompt: institution modes - self-guided and institution-managed

> Status: phases 1 to 4 were built on 2026-10-02 (see "Institution modes" in
> README.md and HANDOFF.md). Phase 5's tests from uploads and AI followed the
> same day, for managed academies only; its private bank screen and phase 6
> are not wanted for now.

You are working in `/Users/br0k3r/workspace/vantedge/satify` (the product is
called **insat**; internal names, the repo, packages, the default institution's
slug and the saved-login key stay `satify`). Its parent folder also holds
`../primeTesting`, the app this one was cloned from. Read this whole prompt,
then `README.md` and `HANDOFF.md`, before changing anything.

## The goal

When the platform owner creates an institution, they choose one of two modes:

- **Self-guided** - exactly what insat does today: students learn on their
  own (diagnostic test, a 29-skill map, practice sets built from their weakest
  skills, full tests and sections they start themselves).
- **Institution-managed** - what primeTesting does today, but on insat's
  question pool and insat's interface: the institution's admin assigns tests
  to students (the same test to many students or whole groups; every attempt
  is still a unique form), views each student's results, and assigns practice
  topics to a student based on those results.

Multiple institutions of either mode live side by side, as they already can.

## What is already true (verified - do not re-derive)

- insat's server is a **strict superset** of primeTesting's: all 42 admin
  routes (users, groups, blueprints, exams incl. generate/upload/manual,
  exam folders, assignments, results, analytics, results.csv) and all student
  assignment routes (`GET /assignments`, `POST /assignments/:id/start`,
  sessions) exist in `functions/routes/admin.js` and `functions/routes/student.js`,
  plus insat's own (`/profile`, `/practice`). The database schema is a
  superset too (insat adds `accepted`, `hidden_at`, `practice`, `realism`,
  `timing_mode`, `title`, `variant_of`); nothing exists only in primeTesting.
- What insat dropped when it was cloned is the **admin client** for managed
  work. primeTesting has `web/src/admin/{Assignments,Bank,BankActions,
  Exams,Groups,QuestionEditor}.jsx` and a student dashboard of assigned exams
  (`web/src/student/StudentApp.jsx`: group filter, locked exams with a
  scheduled release, an exam hidden within a group). insat's admin has only
  Students, Progress (results) and Settings.
- primeTesting has no commits since the clone; its working tree is clean. Its
  local database (`localhost:5433`, db `primetesting`) holds 2 institutions,
  27 users, 6 exams and 1 session. Whether a production copy exists is not
  known - ask before migrating anything (phase 6).
- Relevant schema today: `pa_assignments(exam_id NOT NULL, target_type user|
  group, user_id, group_id, assigned_by, due_at, institution_id, hidden)`;
  `pa_exams(kind, form, blueprint_id, active, locked, unlocks_at, ...)`;
  `pa_sessions(kind 'exam'|'practice', practice JSONB, assignment_id, title,
  timing_mode, hidden_at, ...)`. Migrations live in `db/migrate.sql`
  (idempotent: `ADD COLUMN IF NOT EXISTS`) and are applied on every API boot.
- Practice logic is in `functions/lib/practice.js`: `skillProfile(userId,
  { institutionId, creds })`, `skillsSpec(skillNames, profile, { perSkill,
  difficulty })`, `practiceTitle(...)`, `PRACTICE_MODES`. Unique forms come
  from `functions/lib/assembly.js`, drawing on the shared pool (the institution's
  bank, the global pool, math templates, verified variants).

## Decisions (made; keep them unless the user says otherwise)

1. **One app.** Build managed mode inside insat. Do not restyle primeTesting
   or keep two copies of the same features: everything primeTesting does
   moves here, in insat's interface, and primeTesting is retired once its
   academies (if any must carry over) are imported.
2. **Mode is a column**: `pa_institutions.mode TEXT NOT NULL DEFAULT
   'self_guided' CHECK (mode IN ('self_guided', 'managed'))`. Existing
   institutions, including the default one (`insat`, slug `satify`), stay
   self-guided. The superadmin picks the mode at creation and can change it
   later (with a confirmation that says what changes; no data is deleted).
3. **One question pool.** Managed exams and assigned practice assemble from
   the same pool and the same `assembly.js` as self-guided practice. No
   satGen service; generation stays in-app with the institution's own key.
4. **The API enforces the mode**, not just the UI: managed-only admin routes
   (groups, exams, folders, assignments) answer 403 for a self-guided
   institution, and a managed institution's students cannot start
   self-directed practice (`POST /api/student/practice` answers 403; they
   start assigned work only).
5. **Topic assignments are assignments.** Extend `pa_assignments` with
   `kind TEXT NOT NULL DEFAULT 'exam' CHECK (kind IN ('exam', 'practice'))`
   and `practice JSONB` (`{ skills: [...], difficulty: null|easy|medium|hard,
   perSkill }`), make `exam_id` nullable, and add a CHECK that an exam
   assignment has an `exam_id` and a practice assignment has `practice`.
   Starting a practice assignment builds the set exactly as `POST /practice`
   does today (`skillsSpec` + assembly) and records a `kind = 'practice'`
   session linked by `assignment_id`.

## Build it in this order

Each phase ends working and verified (see "Verification").

### Phase 1 - the mode

- Migration for `pa_institutions.mode`; return it from `GET /api/auth/me`
  (`institutionMode`) and from the super routes.
- Super console (`web/src/super/SuperAdminApp.jsx`): the New institution
  dialog gets a choice of two cards, "Self-guided" (students practise on their
  own: diagnostic, skill map, practice sets) and "Institution-managed" (admins
  assign tests and practice topics and follow each student's results). Each
  institution card shows its mode as a badge and has a Change mode action.
  Add `PATCH /api/super/institutions/:id` for the mode.
- A `requireMode('managed')` guard for managed-only admin routes, and the
  403 on self-started practice for managed students.

### Phase 2 - managed admin console

- `web/src/admin/AdminApp.jsx` picks its sections by mode. Self-guided:
  Students, Progress, Settings (unchanged). Managed: Students, Groups, Exams,
  Assignments, Progress, Settings.
- **Groups**: port primeTesting's `Groups.jsx` (create, rename, delete,
  members with the searchable multi-select student picker).
- **Exams**: an exam is a College Board blueprint (full SAT, Reading and
  Writing, or Math), timed or untimed, assembled into a unique form per
  attempt from the pool. Keep primeTesting's lock and scheduled release
  (`locked`, `unlocks_at`) and exam folders. Exam authoring from uploads,
  manual entry and AI generation is phase 5.
- **Assignments**: assign one exam to any number of students and groups at
  once, with an optional due date; list assignments with completion per
  student; hide an exam within a group (`hidden`); delete.
- Port behavior, not markup: primeTesting's screens use its old navy theme
  and inline styles. Rebuild them with insat's components (see "Interface").

### Phase 3 - each student's results, and topics from them

- **Student page** (managed admins; open it from Students and from Progress):
  name, email, groups; the student's 29-skill map read-only (the same
  `skillProfile` and the same look as the student dashboard's "Your skills");
  their test history with scores (each opens the existing result detail);
  their assigned work with status.
- **Assign practice** from that page: skills pre-selected from the student's
  weakest ("Focus") skills and editable, difficulty (adaptive by default, or
  easy/medium/hard), questions per skill (default `perSkillFor`), optional
  due date. Assign to this student, or pick more students or a group.
- Server: `GET /api/admin/students/:id/profile` (institution-scoped),
  a user filter on the results list if it lacks one, and
  `POST /api/admin/assignments` accepting `{ kind: 'exam', examId, userIds,
  groupIds, dueAt }` and `{ kind: 'practice', practice, userIds, groupIds,
  dueAt }` (one row per target, as now).

### Phase 4 - managed student app

- `web/src/student/StudentApp.jsx` picks the home by mode. Self-guided:
  today's `Practice.jsx`. Managed: an **Assigned to you** home: assigned
  tests and practice topics with their status (to do, in progress, done),
  due dates, locked tests with their release time, and primeTesting's group
  filter; Start, Resume, Review. Below it, the student's own skill map
  (read-only, no practice buttons) and their history.
- The test runner, results and answer review are the same components as now.
- Port the dashboard behavior from primeTesting's `StudentApp.jsx`.

### Phase 5 - exam authoring and the private bank (primeTesting parity)

- Fixed exams from an uploaded practice-test PDF or images, manual entry,
  and AI generation with the institution's key; the institution's private
  bank screen with the question editor. Port `Exams.jsx`, `Bank.jsx`,
  `BankActions.jsx` and `QuestionEditor.jsx` behavior into insat's
  interface. Items added this way land in that institution's bank and render
  through `MathText.jsx` like every other question (run the rendering audit).
- Confirm with the user that they want this before building it.

### Phase 6 - primeTesting's academies (only if the user confirms)

- A dry-run-first, idempotent script `functions/scripts/import-primetesting.js`
  that reads primeTesting's database and brings its institutions (as
  `managed`), users (password hashes as they are), groups, exams,
  assignments and sessions into insat, mapping ids and skipping blueprints
  that already exist. Ask what to do with primeTesting's private bank items
  before importing them. Back up first; report counts; never touch
  primeTesting's own database.

## Interface (the user's standing instructions - follow them exactly)

- shadcn/ui (radix-vega style) on Tailwind CSS v4, the **Mist** palette with
  **mist-700** as the primary color (`web/src/index.css`), icons only from
  `react-icons/lu` (never lucide-react). Add a shadcn component with
  `npx shadcn@latest add <name>` in `web/`, then switch its lucide imports
  to the same icon from `react-icons/lu`.
- Reuse what exists: `web/src/ui.jsx` (Wordmark, SectionHeading,
  StatusBadge, Meter, TONE, EmptyState, ConfirmDialog, HomeLink),
  `web/src/account.jsx` (the account menu), `web/src/admin/shared.jsx`,
  and the patterns in `admin/Students.jsx` (row lists, FormDialog, the trash
  icon with a tooltip) and `student/Practice.jsx` (the skill map).
- The insat logo kit (`web/brand/`) keeps its own purple and orange; the
  interface stays Mist. The logo leads home everywhere.
- Clean, modern, consistent; check desktop and phone. Tailwind gotchas met
  before: `duration-*` also sets a transition (use `animation-duration-*` on
  `animate-in`), `line-clamp-*` sets `display`, Card `size="sm"` resizes
  CardTitle text.

## House rules

- Never write the em dash character; use a plain "-".
- Commit or push only when the user asks; never add an AI co-author line.
  Never edit CHANGELOG files or generated files.
- Prefer quality, simplicity and robustness over development speed.
- For a bug, reproduce it end to end first, the way a user meets it.
- Be picky about the UI and fix lint, test failures and flaky tests you come
  across, even when unrelated.
- `private-data/` is never committed. Never use or store the user's
  ClassMarker login; never edit or delete their ClassMarker tests.
- Match the surrounding code: its comment density, naming and idioms.

## Running and verifying

- `./start.sh` brings up Postgres (`:5434`), the API (`:3002`) and the client
  (`:5174`). The API does not hot-reload: restart it to apply migrations and
  server changes. Do not edit files under `web/` while a Playwright check
  is running (Vite reloads the page and the run fails); after dependency
  changes, restart Vite with `rm -rf node_modules/.vite`.
- Every phase must pass, with the output read, not assumed:
  - server: every `npm run check:*` in `functions/`;
  - client: `npx vite build` with no warnings; `npm run check:screens`
    (extend it with the new screens, desktop and phone, and look at every
    screenshot); `npm run check:rendering -- --fixtures` and `--audit`;
    `npm run check:self-guided -- ../exports/verified-practice-2026-09-30`;
    `npm run check:variants -- ../exports/variants-2026-09-30`.
- Add an end-to-end check, `web/scripts/check-managed.mjs`, in the style
  of `check-screens.mjs` (temporary accounts, removed after): the superadmin
  creates a managed institution and its admin; the admin creates a group and
  a full-SAT exam and assigns it to two students and the group; a student
  takes it; the admin opens that student's page, sees the scores and skill
  map, and assigns practice on two weak skills; the student takes the
  practice; the admin sees both results. Also assert the guards: a
  self-guided institution's admin gets 403 on the managed routes, a managed
  student gets 403 on self-started practice, and the default self-guided
  institution behaves exactly as before.
- Update `README.md` (an "Institution modes" section) and `HANDOFF.md`.

## The user's answers (2026-10-02)

1. Managed students cannot practise on their own: assigned work only.
2. Exam authoring and the private bank (phase 5) wait. Later the same day:
   "creating tests from uploads or AI should be allowed only for private
   institutions", built as custom tests for institution-managed academies.
3. primeTesting's academies are not moved over: skip phase 6.
4. primeTesting does not need to keep running as its own app once managed
   mode works here.
5. The question pool is not to be changed.
