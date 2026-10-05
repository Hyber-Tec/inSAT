# insat

A multi-tenant digital SAT practice platform. Each institution (academy) gets
its own admins, students and results, fully isolated, and runs one of two ways
(see "Institution modes"): **self-guided**, where the admin only creates
student accounts and the student drives (a diagnostic test, a skill-by-skill
analysis, and practice sets built from the weakest skills), or
**institution-managed**, where the admins assign tests and practice topics and
follow each student's results. Every answer has an explanation. Every test is
a College-Board-structured, **adaptive** form assembled fresh for that student
(no question is served twice) and scored server-side. Questions come from one
pool that every institution draws on: the platform's own original Reading and
Writing bank, verified variations of the bank's own math questions, and
deterministic math templates. An institution-managed academy can also make
tests of its own questions, from an upload or written by AI on its own LLM API
key; those stay private to it.

> Not affiliated with the College Board. All practice content is original.

## Architecture

```
web/   React + Vite SPA, Tailwind CSS + shadcn/ui (see "The interface")
  src/components/ui/  shadcn/ui components; src/ui.jsx  the app's shared pieces
  src/super/    superadmin console - provision institutions + their first admin
  src/admin/    institution admin - student accounts, progress, settings; when managed,
                groups, tests (SAT tests, and custom tests from uploads or AI), assignments
                and a page per student
  src/student/  student - diagnostic, skill profile, practice sets (self-guided) or assigned
                work (managed), the adaptive test runner, results
functions/   Node + Express API (ESM), Postgres via `pg`, JWT auth (bcrypt)
  lib/      db, auth, crypto, taxonomy, scoring, blueprints, assembly (unique forms),
            items (import/normalize), session (scoring), provision,
            practice (skill profile + practice specs), modes (self-guided / managed),
            pool (insat's shared question pool), examForm (custom tests)
            templates/  deterministic math item generators (no model, no cost)
            templateItems.js  template rows for the bank, built on demand or offline
            variation/  the variation engine: new verified questions from the bank's own
            itemChecks.js  what makes a generated item well formed (templates, variants)
            batch.js    Anthropic Message Batches - offline generation at half price
            similarity.js  SimHash near-duplicate detection for the bank
  routes/   auth, super, admin (+ bank, settings), student
db/       schema.sql (base) + migrate.sql (multi-tenant, idempotent)
```

**Roles:** `superadmin` (platform owner - creates institutions + admins) ·
`admin` (institution‑scoped) · `student` (belongs to one institution).

**Data model:** every tenant table carries an `institution_id`; the API scopes
every query by the caller's institution, so an academy only ever sees its own
data. Blueprints (the CB test structure) are global templates shared by all,
and every institution's tests and practice draw on insat's question pool
(`functions/lib/pool.js`).

## Run it

Prereqs: Docker (for local Postgres) and Node 22.12 or newer (or 20.19+). An
`ANTHROPIC_API_KEY` in `functions/.env` is optional: the platform fallback for a
managed academy's uploads and AI-written questions when it has no key of its
own.

```bash
./start.sh
```

This brings up Postgres (`:5434`), the API (`:3002`) and the client (`:5174`),
applies the schema + migrations, and seeds the accounts below.
Then open **http://localhost:5174**.

insat's question pool is the bank of the default institution (insat, slug
`satify`), and every institution's tests and practice draw on it. It is filled
by the original-question import and the math templates (see below); there is
nothing to seed before a student can start.

### Filling the pool ahead of time

Assembling a test never calls a model: it draws on what the pool holds, and a
math cell that runs short is built from the templates on the spot. The pool
can also be topped up offline:

```bash
cd functions
npm run pool:topup -- --math 40 --rw 25 --dry-run   # show the deficit, spend nothing
npm run pool:topup -- --math 40 --rw 25             # fill it
```

Math comes from templates in `lib/templates/` - computed in code, so they are
free, instant, and correct by construction. Reading & Writing goes through the
Batches API at half the per-token price, then through the same verification and
duplicate gates as everything else. Both checks run without a database:

```bash
npm run check:templates     # all 29 templates x 300 seeds, answers re-derived independently
npm run check:similarity    # measures the near-duplicate thresholds
npm run check:scoring       # grid-in scoring against the accepted-answer lists
npm run check:practice      # mastery levels and practice specs
npm run check:generation    # generation API, verification gate, classification into practice
npm run check:variation     # the variation engine: reading, solving, varying, independent checks
npm run check:text-repair   # repair of text damaged on import (lib/textRepair.js)
```

Generated questions carry a SAT section, canonical domain and skill, difficulty,
answer, and explanations. A separate model call solves each question without
seeing the draft's answer, explanations, or classification. The question enters
the bank only when the verifier explicitly confirms one correct answer and
agrees with both the answer and skill classification. Missing or conflicting
verdicts are held out. The same gate applies to a managed academy's AI-written
questions and to offline batch top-ups. Classification comes from the question
content; ClassMarker category ranges are not used by this gate.

insat's pool (`--institution satify` with `pool:topup`) serves only originals,
their variants and template questions, so top it up from the templates alone
(`--rw 0`); model-written questions added to it are never served. Without an
institution, the script fills the generation pool: the examples AI generation
imitates, which no test draws from.

To prepare a small math batch without a model key, independently solve each
rendered question, and export its classification and verification record:

```bash
cd functions
npm run pool:prepare -- --institution satify
# Add --import to also insert the verified batch into that institution's pool.
npm run pool:coverage -- satify
```

The batch contains 12 questions in each of four math skills by default. Its
manifest identifies the generation method, classifications, and imported item
IDs. Questions already in the institution's bank are excluded. This uses math
templates; fresh model-written Math or Reading and Writing needs a provider key
in Settings.

With the API and client running, exercise a real diagnostic, adaptive routing,
answer review, targeted follow-up, and a prepared batch in the browser:

```bash
cd web
npx playwright install chromium
npm run check:self-guided -- ../exports/verified-practice-2026-09-30
```

The check creates temporary students and an isolated institution for the new
batch (pointed at its own bank with `pool_institution_id`, so it is served the
batch and not insat's pool) and removes those fixtures afterward. It uses the local database and
writes screenshots and results to `.logs/self-guided-e2e/`. Normal practice
assembly can add math template questions to the default institution's bank during the check.

### Variations of the bank's own questions

`lib/variation/` makes new questions from the questions already in an
institution's bank, without a model: it reads a question, solves it, and
writes the same question with new numbers. Every variant keeps its source's
wording, structure and difficulty, gets wrong answers built from named
mistakes and a worked explanation, and is checked again before it is kept.

```bash
cd functions
npm run pool:vary -- --institution satify                     # write the batch for review
npm run pool:vary -- --institution satify --import            # and add it to the pool
npm run pool:vary -- --institution satify --import --replace  # regenerate every set and sync
```

A question is used only when the engine understands it, which it proves by
reproducing the source's own key:

- **Formal math** (equations, systems, functions, equivalent expressions,
  solution counts) in LaTeX, ClassMarker's `^{a}/_{b}` notation or plain text
  is parsed into one tree and solved exactly (rational arithmetic, polynomial
  algebra). Variants keep what the question turns on: a repeated
  subexpression, a target that is a multiple of one side, fractions in lowest
  terms, the monomials of every equation. Each variant is re-read from its
  rendered text and solved again numerically, a different method, and exactly
  one choice must match. The skill is classified from the structure; a source
  filed under a skill its structure does not support is reported.
- **Word problems** bind every number in the answer, the choices and the
  source's own explanations to a formula of the numbers the question states,
  found by exhaustive search. A binding counts only when it is the one
  formula (no different formula within a step of it), percent is treated as a
  unit, facts of the world never vary (stated conversions, a formula the
  question states, numbers under a radical, standard conversions like 10
  millimeters in a centimeter), and a key built from three or more numbers
  needs corroboration from the source's explanation or its distractors. Keys
  that depend on rounding are left alone. Variants re-render the source's own
  explanations with the new numbers.

The batch lands in `../exports/variants-<date>/`: `questions.jsonl` (each
variant with its source and verification), `coverage.md` (what was understood,
by skill, and why the rest was left alone) and `manifest.json`. Imported
variants are `source = 'variant'`, linked to their source by `variant_of` and
carrying its realism rating. A question and its variants are one lineage:
assembly never puts two of a lineage in one form, and prefers lineages a
student has not met (strongly in an exam, lightly in a practice set, where the
same question with new numbers beats a formulaic template). Sources rated
below `--min-realism` (3) are not varied.

With the API and client running, `npm run check:variants -- ../exports/variants-<date>`
(from `web/`) serves a batch to a temporary student, in an institution
pointed at its own bank of those questions, through the real UI: two practice
sets, answered through shuffled choices, no lineage twice in a set, fresh
lineages first, explanations rendered, screenshots in `.logs/variants-e2e/`.

`scripts/fix-letter-rationales.js` rewrites imported explanations that named a
choice by its letter ("which gives C"): choices are shuffled per student, so
the letter pointed at the wrong choice. Report first, `--apply` to rewrite
(with a backup).

### How questions render

`web/src/MathText.jsx` renders every question, choice and explanation:
LaTeX in `\( \)`, and the bank's other notations as math too: ClassMarker's
fractions (`^{a}/_{b}` and its variants), bare powers (`x^2`, `10^-8`,
`(1.60)^{t/2}`), `sqrt(...)` written out, and plain-text math flush against
them. A line that is nothing but math is set as math whole; parentheses
around a fraction grow to its height, as the SAT prints them; units keep the
text face (`cm³`); wide tables scroll inside their card on a phone.

With the API and client running (from `web/`):

```bash
npm run check:rendering -- --fixtures                    # the known shapes, each to its exact TeX
npm run check:rendering -- --audit [--institution satify] # every servable question, through MathText
npm run check:rendering -- --items <id,...> [--phone]     # those questions in the real answer review
```

Each flags what a student must never see: raw `^{..}`/`_{..}` markup, LaTeX
commands or delimiters as text, stray braces, control characters, KaTeX errors
(including the red text of an unknown command), and in the real UI, content
wider than the screen. Results and screenshots go to `.logs/rendering/`.

Text damaged on its way in (a `\frac` stored as a form feed and `rac`, a line
break stored as the two characters `\n`, math delimiters written as bare
parentheses, `$` or `%` inside math) is repaired by `lib/textRepair.js` as the
importers read it; the shared item checks reject it in generated items.
`scripts/repair-item-text.js` repairs rows imported before that, in every bank
and in stored sessions: report first, `--apply` to repair (with a backup).

### Reference material

The College Board question bank and the full-length practice tests import as
**reference** material, which generation learns from but students never see.

Turning the source PDFs into questions is an offline step in
[`tools/sat-extract/`](tools/sat-extract/README.md). Reading & Writing is
parsed straight from the PDF text layer (paragraphs, bullets, underlines,
verse); math, figures and the scanned practice tests are transcribed from page
images, with every answer independently re-solved and checked against the
text layer or OCR. The output is a dataset of one JSON record per question,
with math in LaTeX and figures as images, kept outside the repository next to
the sources. Import it with:

```bash
cd functions
node --env-file=.env scripts/import-dataset.js "/path/to/SAT/extracted/dataset" cb --dry-run
node --env-file=.env scripts/import-dataset.js "/path/to/SAT/extracted/dataset" cb --replace
node --env-file=.env scripts/import-dataset.js "/path/to/SAT/extracted/dataset" dsat --replace
```

Import `cb` first: a practice-test question the bank already holds is skipped,
so the bank's version with its official labels is the one kept. Practice-test
questions whose key disagrees with the independent solution are held back.

Anything with `source='reference'` is excluded from `candidatesFor()` in
`assembly.js` and therefore never appears on a student's exam. It is preferred
by `exemplars()` in `generate.js`, same skill and difficulty first, so it
shapes what the model writes and anchors the difficulty labels. These are
College Board's and publishers' questions, not original content: keep them on
the reference side of that line.

### Original questions

Servable Reading and Writing questions are written offline, in the College
Board's style, by the same tooling: `jobs_originals.py` cuts a writing job per
skill (counts per difficulty, the bank's own questions as models), sub-agents
write the questions, `jobs_verify_originals.py` cuts blind-solve jobs for the
output, and `build.py original` keeps only the questions whose blind answer
matches the key. They are imported into an institution's own bank as
`source='original'`, which students are served:

```bash
node --env-file=.env scripts/import-dataset.js "/path/to/SAT/extracted/dataset" original --institution satify --replace
```

`--replace` here syncs the bank with the dataset: a question the dataset
dropped or rewrote is retired (never deleted, since a served question may sit
in a student's history) and one it carries again comes back. Every original
question carries an explanation of the right answer and of each wrong choice,
written without naming letters, because choices are shuffled per student.

### The academy's own questions (ClassMarker)

A ClassMarker export is decoded by `tools/sat-extract/classmarker.py` and
imported by `functions/scripts/import-classmarker.js`, on the institution's API
key at batch prices. Only text-only questions that are not College Board or
CrackSAT text qualify. A model solves each one blind and it is kept only when
its answer matches the academy's key and it reads like the SAT. It is sorted
into the SAT's skills and difficulty, explained without naming letters, and
imported as `source='original'` with a realism rating (1-5) that full
practice tests use to draw the most exam-like questions first. Questions that
show images come in too: `classmarker.py --fetch-images` downloads the images
(ClassMarker serves them without a login), and a first pass turns an image of
math or a table into text and keeps at most one real figure as the question's
picture.

```bash
node --env-file=.env scripts/import-classmarker.js /path/to/classmarker/questions.jsonl --institution satify --dry-run
node --env-file=.env scripts/import-classmarker.js /path/to/classmarker/questions.jsonl --institution satify --limit 200
```

### Default accounts (change these before hosting)

| Role | Email | Password |
|------|-------|----------|
| Superadmin | `superadmin@satify.test` | `satify-super` |
| Admin (demo institution) | `admin@satify.test` | `satify-admin` |

The superadmin creates new institutions and their first admin; that admin
invites their own students (credentials are shown once so they can be shared).

## LLM API keys (per institution)

Each institution sets its **own Anthropic API key** in the admin **Settings**
tab, so generation/upload bills to them - not the platform. Keys are encrypted
at rest and never returned to the browser. If an institution has no key, the
platform fallback (`ANTHROPIC_API_KEY` in `functions/.env`) is used unless
`REQUIRE_INSTITUTION_KEY=true`, which forces each institution to bring its own.

## How a practice test works

1. A **blueprint** gives the CB structure (RW 54 = 27+27, Math 44 = 22+22,
   per-domain quotas, adaptive Module 2).
2. Each start **materializes a unique form**: items are sampled from the
   institution's bank, never one the student has seen, choice order shuffled;
   a short math cell is filled from the templates on the spot, and from
   generation when the institution has an API key.
3. The student takes Module 1, the server picks the Module 2 difficulty from
   their performance, then Module 2 is scored server-side (scaled 200 to 800
   per section). The full form with answers never leaves the server.

## The student's loop

An admin creates the account (Students tab: a starting password, or an invite
link) and that is the admin's whole job. The student dashboard then leads with
a **diagnostic**, and offers:

- a full practice SAT or a single section, timed like the real test or untimed;
- a **skill profile**: accuracy and a smoothed mastery estimate for each of the
  29 College Board skills, from everything the student has finished;
- **practice sets** built from chosen skills, or in one click from the weakest
  ones, each skill at a difficulty matched to how the student is doing in it.

Results always point at the skills missed, and every reviewed question shows
its explanation. Practice sessions are ordinary sessions with
`kind = 'practice'` and no exam (`POST /api/student/practice`), so admins see
them in Progress. Math gaps are filled from the templates while the set is
assembled; Reading and Writing draws on the original questions in the bank
(see above), then on generation when an API key is set, and the dashboard
marks what is not available yet.

A student can discard any set from their list. An unfinished one is deleted
and its questions go back into their pool; a finished one only leaves the list
(`hidden_at`): it still counts toward the skill profile, admins still see it in
Progress, and its questions are never served again.

## Institution modes

The platform owner picks how each institution runs when creating it, and can
change it later from the institution's card in the platform console (nothing is
deleted when it changes). The default, and the `insat` academy, is
**self-guided**: the loop above. An **institution-managed** academy's admins
run the course instead, with what primeTesting (`../primeTesting`, the app this
one was cloned from) did, on this question pool and interface:

- **Groups** of students, to give work to a whole class at once.
- **Tests**: the full SAT, Reading and Writing, or Math, timed or untimed
  (`pa_exams.kind = 'sat'` with a `scope`). Every student who is given a test
  gets their own form, assembled from insat's pool and specs exactly as a
  self-guided test is. Tests can be filed in folders (a folder is assigned at
  once), locked until a release time, or hidden from students.
- **Custom tests** (`pa_exams.kind = 'fixed'`): the academy's own questions,
  the same for every student. AI reads them out of uploaded PDFs or images
  (a whole practice test works, its answer key included), or writes them for a
  chosen domain or skill, each one solved again and kept only when that check
  agrees; they can also be written by hand. Each test has a page to review,
  edit, remove and move its questions (`web/src/admin/TestEditor.jsx`).
  A timed one gives each module the time its length would have on the SAT,
  and its result is the number correct (it is not built like the SAT, so it
  has no scaled score). Uploads and AI run on the academy's own LLM API key
  (Settings), or the platform's when it has none.
- **Assignments**: a test, or practice topics, given to any number of students
  and groups at once, with an optional due date (`pa_assignments.kind` is
  `exam` or `practice`); a test already given to someone is skipped.
- **A page per student**: their skill map, test history and assigned work.
  Practice topics are assigned from the skill map, starting from the
  student's weakest skills, and built for each student from their own record
  when they start, exactly as self-guided skill practice is.
- Students see what is assigned to them (by group, if they are in several)
  and their own skill map, read-only. They cannot start practice themselves.

The API enforces the mode (`functions/lib/modes.js`, read fresh on every request):
groups, tests, folders and assignments answer 403 for a self-guided academy,
and self-started practice answers 403 for a managed one. Making tests from
uploads or with AI is for managed academies only: a self-guided institution
serves insat's pool alone, so its bank routes and AI key settings answer 403
too.

What a managed academy uploads or has AI write stays in its own bank: it is
served only in its own custom tests and never enters insat's pool or the
generation pool (`functions/lib/pool.js`). The institution that holds insat's
pool cannot be deleted from the platform console, and the pool's questions
cannot be edited or retired through the bank routes.

With the API and client running, `npm run check:managed` (from `web/`)
walks the whole managed flow in a browser: the platform owner creates a
managed academy; its admin adds students, a group and a Full SAT test, locks
and unlocks it, and assigns it; a student takes it; the admin assigns practice
from the student's page; the student does it; the admin sees both results;
the owner makes the academy self-guided again. It also asks the guards
directly, and puts screenshots in `.logs/screens/managed/`.

`npm run check:authoring` walks custom tests the same way. It starts its own
API (`:3012`) with the AI provider mocked (`web/scripts/mock-llm.mjs`), so
it needs no key and spends nothing, and its own build of the client (`:5184`)
against it: the admin adds an AI key, has AI write a test, edits and removes
questions, adds more from an uploaded PDF and by hand, moves one between
modules and assigns the test; the student takes it, timed, and both see the
number correct. It also checks that the academy's questions stayed out of the
shared pools and that a self-guided institution can do none of this.
Screenshots go to `.logs/screens/authoring/`.

## The interface

The client is React 19 with Tailwind CSS v4 and [shadcn/ui](https://ui.shadcn.com)
components (Radix primitives, the Mist palette with mist-700 as the primary color); icons come from
[react-icons](https://react-icons.github.io/react-icons/), its Lucide set
(`react-icons/lu`). The colors are CSS variables in `web/src/index.css`;
the type is Geist, with Source Serif 4 for passages and question stems, both
self-hosted.

- `src/components/ui/` holds the shadcn components. Add one with
  `npx shadcn@latest add <name>` (settings in `components.json`); the CLI
  writes `lucide-react` imports, so switch those to the same icon from
  `react-icons/lu`.
- `src/ui.jsx` holds the app's own pieces built on them: the wordmark, section
  headings, status badges and meters (one tone map for success, warning and
  danger), empty states and the confirm dialog.
- The brand is the insat logo kit, kept as delivered in `web/brand/`: an
  infinity loop (the endless loop of practice) landing on an orange point,
  and the two-tone wordmark. The app serves `public/insat-logo.svg` (mark and
  wordmark, framed to what they paint) and `public/insat-app-icon.svg`;
  `npm run brand:icons` draws every other icon from the app icon: the PNG
  favicon, the iOS home-screen icon and the desktop app's icon set. The logo
  keeps its own purple and orange; the interface stays Mist.
- An institution's brand color (admin Settings, Branding) replaces the primary
  color for its students and staff; the text on it turns white or black to
  stay readable.
- In the test runner, the calculator and reference sheet float over the
  question and drag by their title bar, as on the real test.
- Every role's header (the admin's sidebar foot) has the account menu
  (`src/account.jsx`): the avatar opens who is signed in, account settings
  (change password, which also clears an admin's "must reset") and sign out.

With the API and client running, `npm run check:screens` (from `web/`)
photographs every screen as a student, an admin and the platform owner see it,
on a desktop and on a phone, into `.logs/screens/<label>/` (`-- --label
<name>`, default `latest`). It flags page errors, failed API calls and content
wider than a phone, and drags a tool window to check that it follows and stays
on screen.

## Hosting

The DB layer is addressed by `DATABASE_URL`, so the same code runs locally
(Docker Postgres) and in production (Neon / Railway / Supabase) with one env
swap. Recommended: client → Cloudflare Pages/Vercel; API → Railway/Render;
Postgres → **Neon**.

## Config (`functions/.env`)

`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY` (for institution API keys),
`SATGEN_URL`, `PORT`, `CLIENT_ORIGIN`, `SUPERADMIN_*`, `ADMIN_*`,
`REQUIRE_INSTITUTION_KEY`. See `functions/.env.example`.

## License

Example/educational code. Customize, extend, sell - just don't claim affiliation
with the College Board or the SAT trademark.
