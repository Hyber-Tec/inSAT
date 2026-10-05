# insat - SAT practice, self-guided or institution-managed

Cloned from `../primeTesting` (the institution-managed system), rebranded,
and then merged back: an institution is **self-guided** (the student drives)
or **institution-managed** (primeTesting's assigned tests, on this question
pool and interface). See "Institution modes" in the README. primeTesting is no
longer needed; none of its academies were moved here (on purpose).

Running locally: `./start.sh` (Postgres `:5434`, API `:3002`, client `:5174`).
Both projects can run at once: every port, the database name and the
localStorage token key were moved so they do not collide.

## The practice loop

An academy's admin creates student accounts (`web/src/admin/Students.jsx`:
a starting password or an invite link) and that is the admin's whole job.
A student signs in to a practice dashboard (`web/src/student/Practice.jsx`)
that leads with a diagnostic (a full test or one section) until the student
has answered something, then with the weakest skills:

- **Next up**: up to three of their weakest skills (skills with a miss in them,
  lowest mastery first), practiced in one click.
- **Take a practice test**: a full SAT (98 questions, adaptive Module 2, a
  break) or one section, on the SAT's clock or untimed.
- **Your skills**: all 29 College Board skills with accuracy, a mastery bar and
  a level (Focus, Building, Strong, Not tested). Any of them can be picked to
  build a set; a skill with nothing to serve says so and cannot be picked.
- **Your practice**: history. Unfinished sets can be resumed or discarded,
  finished ones reviewed.

Every results screen says what to practice next (the skills missed, one click
away), and every question in the review carries its explanation. After a skill
set the review also shows where each skill now stands overall.

Server side (`functions/routes/student.js`, `functions/lib/practice.js`):

- `GET /api/student/profile`: per-skill accuracy over every completed session,
  what can be served in each skill (`ready` unseen items, `more` if templates or
  generation can make more) and per section.
- `POST /api/student/practice` with `{ mode: 'full' | 'rw' | 'math' | 'skills',
  skills?, timed? }`: materializes a unique form into a `kind = 'practice'`
  session with no exam (`pa_sessions.exam_id` is nullable; title and timing
  live on the session).
- `GET /api/student/practice` (history), `DELETE /api/student/practice/:id`
  (unfinished only, so its questions go back to the pool).
- Mastery is Laplace-smoothed, `(correct + 1) / (answered + 2)`, so one lucky
  answer is not mastery. A skill set sizes itself (about a dozen questions,
  `perSkillFor`) and sets each skill's difficulty from the student's mastery in
  it.
- A skill set has no scaled score (a handful of questions on one skill has
  none). Its sessions store null scaled scores and report correct of total.
- Practice is not proctored (no fullscreen lock, no tab-switch record) and runs
  in the browser; there is no assigned-exam flow any more.
- The admin's Progress tab lists every session with its scores and review.

## How a form is assembled (`functions/lib/assembly.js`)

- **A question is never served to the same person twice.** `seen` (from
  `loadSeenItemIds`) is a hard exclusion and a short form is reported, never
  padded. An adaptive module holds both routes until Module 1 decides; after
  that only the served route counts as seen and the other route's questions go
  back to the pool (they used to be burned, about 49 per full test).
- **A test draws the most exam-like questions first.** Every form except a
  skill set is an exam (`spec.exam !== false`; `skillsSpec` sets it false).
  An exam ranks each candidate by `realism` (1-5, rated when an outside
  question is imported; unrated written questions count as 4, templates as
  1), one step costing as much as a skill already drawn once, so templates
  serve a test only when nothing more exam-like is left for that student. A
  skill set keeps the wider mix.
- **Draws spread across skills.** Each pick balances the wanted difficulty
  against a skill not yet drawn (`SKILL_SPREAD`); a `mixed` module takes any
  difficulty. Before this, a Math test drew all 16 algebra questions from one
  skill, because most templates sit at one difficulty.
- **A set mixes every pattern a skill has.** Each pick also balances the
  math template (`TEMPLATE_SPREAD`), every template a draw could use first gets
  a few unseen items, and a template item carries a small handicap
  (`TEMPLATE_BIAS`), so an SAT-style question (original or generated) of the
  wanted difficulty goes first. Before this, a "Lines, angles, and triangles"
  set was ten similar-triangle questions from one template.
- **A chosen difficulty is strict.** The skill map offers Adaptive (each skill
  from the student's record) or Easy, Medium or Hard; a chosen one serves only
  that difficulty (`strict` in the skill spec), and the profile's per-skill
  `byDifficulty` greys out what a skill cannot serve at that level.
- **Math fills its own gaps.** When a math cell is short, templates build fresh
  items on the spot (free, instant, correct by construction) before any model
  call, and a domain draw first makes sure every templated skill has something
  unseen. Template siblings skip the near-duplicate gate: it compared each new
  sibling with every banked one, so its small false-match rate compounded until
  a template stalled at 8 or 9 items. Exact repeats are still dropped by content
  hash, with choice order ignored.
- **Reading and Writing comes from the bank.** RW questions are the original
  questions in the institution's bank (`source='original'`: written offline
  in the College Board's style, kept only when an independent blind solve
  agreed with the key, with an explanation for every choice), then generation
  when an API key is set. With neither, the dashboard shows those tests and
  skills as not available yet instead of failing.
- **Passages keep the bank's line conventions.** One line break between
  parts; `MathText` sets "Text 1"/"Text 2" heading lines bold with a gap, a
  context line ("The following text is from ...") apart from the excerpt,
  bullets with a hanging indent, and a title line plus ` | `-separated rows
  as a ruled table.

## Fixed along the way

- **Rebrand leftovers.** The wordmark in the app header, landing page and
  sign-in still read "Prime Testing", and `index.html` linked a missing
  `/satify.png`.
- **Fixed exams were scored as adaptive.** A section without an adaptive
  Module 2 still took a route from Module 1, so its score jumped about 220
  points at the 60% threshold. It now scales linearly (`plainScaled`), and
  only adaptive sections report a route.
- **Admin question review showed raw LaTeX** (`\frac{3}{5}`) and no
  explanation for the chosen wrong answer; it now renders math and both
  explanations, and names the skill.
- **Inline math is set in display style**, so a fraction in a stem or a choice
  keeps full-size numerals.
- **Review modal**: Escape closes it, the arrow keys step through questions,
  and its icon buttons have labels.
- **Template bugs** (found while writing the wrong-choice explanations): an
  exponential template rounded exact halves down, so some keys were 0.01 off;
  `alg-no-solution` printed a literal `\n` (red KaTeX error text) in every
  stem; tangent items never built; a slope distractor could be a bare number
  no mistake produces. All fixed, and the 565 banked template items rebuilt.
- **Bundle**: each role's app is its own chunk (the landing page no longer
  loads KaTeX or the admin console), which also clears Vite's size warning.

## Reference material

The College Board question bank and the full-length practice tests are
transcribed by `tools/sat-extract/` (see its README) and imported with
`source='reference'` into the global pool: generation exemplars, never served.

- **Question bank: done.** 3,266 questions transcribed, 3,264 in the pool
  (2 exact repeats), with the bank's own skill, difficulty, key and rationale,
  math in LaTeX, 618 figures. This replaced the old text-layer import, whose
  math was unreadable. The 4 questions the export left without a key were
  keyed by review and their explanations written.
- **Practice tests: imported.** All 23 tests transcribed, 2,540 questions.
  1,606 are in the pool; the rest were exact (793) or near (125) duplicates of
  the bank or of each other (Tests 10 to 13 are the linear editions of
  College Board practice tests, 33/27 per module, and share questions with
  Test 9 and the bank), 9 are ambiguous as printed, 5 print two identical
  choices and 2 print no question sentence. Every question is keyed: 56
  key-versus-solution disagreements went to adjudication
  (`jobs_adjudicate.py`); 36 keys were wrong and are corrected. Test 20's key
  has the Reading and Writing Module 2 column of a different form (21 of 27
  wrong).
- **Every reference question has an explanation.** Where the source printed
  none (Tests 1 and 17 to 20 have no explanation booklet; parts of the Test
  5, 8, 9 and 21 booklets stop the API's content filter with long literary
  quotations), one was written in the College Board's style
  (`jobs_write_explanations.py`; each writer solved the question blind first,
  and only 2 of 622 disagreed with the key, both source flaws that are now
  adjudicated). A question printed in several tests shares one explanation.
  Tests 10 to 13 read their Reading and Writing explanations from the PDF
  text layer (`dsat_explain_text.py`). Key-corrected questions stay out of
  generation exemplars: their source explanation argues for the old key.
  Re-run `build.py dsat` and the import with `--replace` after any new
  records.
- **Original questions: 2,287 Reading and Writing, servable.** 196 to 290
  per skill, roughly even across easy, medium and hard. Written in 30-question
  batches from the bank's models, each batch solved blind by an independent
  model (Fable writers were checked by Opus, Opus writers by Sonnet); only
  questions whose blind answer matched the key were kept (a handful were
  dropped), and the checkers' notes caught and fixed about 60 factual or
  wording slips before import. Records in `out/original/`, dataset
  `dataset/original.jsonl`, imported into the default institution's bank. Math is not
  written this way: the templates cover it.

## Institution modes (2026-10-02)

Built from `prompts/institution-modes.md` (phases 1 to 4). The mode is
`pa_institutions.mode`; `functions/lib/modes.js` guards the routes. Managed tests
are `pa_exams.kind = 'sat'` plus `scope`, assembled per attempt with
`sectionSpec(scope)`; practice topics are `pa_assignments.kind = 'practice'`,
built at start by the same `assemblePractice` as self-started practice
(`functions/routes/student.js`). The admin's student page is
`GET /api/admin/users/:id/overview`. Client: `admin/{Groups,Tests,Assignments,
StudentPage,assign}.jsx`, `student/Assigned.jsx`, and the skill map shared by
both modes in `src/skills.jsx`. Proof: `npm run check:managed`.

**One question pool (2026-10-02).** Every institution's tests and practice
draw on insat's pool, the bank of slug `satify` (`functions/lib/pool.js`; only
`original`, `variant` and `template` items are the pool). Before this, assembly
read only the student's own institution's bank, so a new managed academy's
Reading and Writing or Full SAT tests could not start and its Math tests were
all template questions. A test fixture can point its throwaway institution at
its own bank with `pa_institutions.pool_institution_id`; nothing in the app
sets it. Assembly never calls a model now: the hidden AI fallback is gone.

**Custom tests (2026-10-02).** The user's rule: creating tests from uploads or
AI is allowed only for private institutions, read as institution-managed
academies (a self-guided institution gets 403 on `/api/admin/bank` and
`/api/admin/settings/llm-key`, and no AI settings). A managed academy makes
`pa_exams.kind = 'fixed'` tests from an upload (`POST /exams/from-upload`) or
written by AI (`POST /exams/from-ai`), reviews and edits them on
`admin/TestEditor.jsx` (dialogs in `admin/authoring.jsx`), and can add more by
upload, AI or hand. Their questions stay in the academy's own bank: never in
insat's pool, never copied to the generation pool (boot copies only insat's
pool there now, and the old dual writes are gone). A timed custom test gives
each module the SAT's pace for its length (`timedAtSatPace`); its result is the
number correct, with no scaled score. The institution holding the pool cannot
be deleted from the platform console. Proof: `npm run check:authoring`, which
runs its own API with the AI provider mocked (`web/scripts/mock-llm.mjs`).

Not built: the private bank editor screen (its API is managed-only), and
importing primeTesting's academies.

## Known gaps and next steps

1. **Reading and Writing depth.** 2,287 original RW questions, and "never
   served twice" is per student, so each student has about 40 full RW
   sections of material. The target was 300 per skill (batches rw-002 to
   rw-011); 22 batches remain, stopped on 2026-09-25 for usage limits. To
   finish: `python3 tools/sat-extract/plan_originals.py 11` prints what each
   skill still needs, read from disk; run `tools/sat-extract/workflows/originals.js`
   as a Claude Code workflow with `{"concurrency": 6, "plan": <that output>}`.
   Budget about 8M tokens per batch with Opus writers (the writers dominate).
   An API key adds generation on top (`npm run pool:topup`).
2. **Math does not read like the SAT yet.** Practice math comes from the 29
   code templates, one or two per skill, which are correct but formulaic; the
   real SAT math is reference-only (College Board's). The fix is SAT-style
   math written from those questions: with an Anthropic key in Settings,
   `node --env-file=.env scripts/topup-pool.js --institution satify --math-model 10 --math 0 --rw 0`
   writes 10 per skill and difficulty (570) through the Batches API, verifies
   each blind, and imports them; sets then prefer them over templates.
   `--dry-run` shows the count first. The ClassMarker import (item 4) is the
   larger fix: most of its 11,276 usable questions are math.
3. **Math template depth.** Every one of the 19 math skills has a template
   now (29 templates), so any math skill can be practiced without a key. Most
   skills still have one template at one difficulty, so a hard Module 2 is
   light on hard math, and the two-variable half of "linear inequalities"
   (which point satisfies a system) is not templated yet.
4. **The academy's ClassMarker pool is decoded and ready to import, pending
   an API key.** `tools/sat-extract/classmarker.py` decodes the export
   (`private-data/SAT/ClassMarker_all_questions.txt`, 26,074 records) into
   `private-data/SAT/extracted/classmarker/questions.jsonl` with flags; 11,276 are
   text-only, not College Board or CrackSAT text, not repeats and well formed
   (10,306 multiple choice, 970 free response, mostly math). With a key in
   Settings, `node --env-file=.env scripts/import-classmarker.js <that file> --institution satify --limit 200`
   is a trial run: a blind solve keeps a question only when it matches the
   academy's key, has one answer and rates 3+ on realism, sorts it into the
   SAT's skills and difficulty, then a keyed pass writes letter-free
   explanations and lays it out, and code refuses any output whose text or
   choices drifted. Without `--limit` it does the rest; progress is saved in
   `stage0/1/2.jsonl` beside the input, and a batch still processing when a
   run stops is picked up by the next (`<pass>.pending.json`).
   Questions with images come in too. The export lacks the files, but each
   `[image 0/<file>]` loads from `https://0cm.classmarker.com/<file>` without
   a login (`classmarker.py --fetch-images` downloads them into `images/`;
   the CDN refuses urllib's default user agent). A transcribe pass turns an
   image of math or a table into text and keeps at most one real figure,
   which is stored as the item's asset and shown above the question; code
   checks the words around the images survived and that the result is not
   College Board text, and the blind pass then solves exactly what the
   student sees. `--no-images` leaves them out. Every question is also
   checked against the College Board bank and DSAT tests by stem and choices
   before anything is spent on it (201 short math copies, some with the
   numbers changed, that the 10-word-run check misses).
   Without a key, `--jobs` does the passes here instead: it writes job files
   (`jobs/<pass>-NNN.json`) that Claude Code agents work through, each writing
   `stage<N>.d/<pass>-NNN.jsonl`; rerunning takes the results in, imports
   what is finished and cuts the next round. `tools/sat-extract/workflows/classmarker.js`
   loops that as a workflow (args `{skip, perPass, jobSize, rounds}`), and
   `tools/sat-extract/CONTINUE-CLASSMARKER.md` tells any other AI coding
   agent how to work through the jobs. A
   pilot on 2026-09-25 (60 math questions, Sonnet agents) imported 26 and
   had 24 more waiting on explanations, with no key disagreements; it used
   about 14k tokens a question for a text blind check, 41k for one with a
   figure, 43k for a transcription and 56k for explanations (most of it
   cached context), so the 7,495 math questions (drill, Reading and Writing
   and uncategorized ClassMarker categories skipped) would take several
   hundred million tokens this way.
5. **Figures in answer choices** are shown as one composite image above the
   question, not per choice.
6. **Admin scope.** The console is Students, Progress and Settings; admins
   create accounts and watch results. There is no per-student skill profile
   view for them yet (the student's own dashboard has it).
7. **Server leftovers from the clone.** The exam, assignment, group and
   question-bank routes and tables (`routes/admin.js`, `routes/bank.js`,
   `lib/examForm.js`, `pa_exams`, `pa_assignments`, `pa_groups`, the
   assignment routes in `routes/student.js`) are still there; nothing in the
   UI reaches them since the admin panels and the student's "Assigned to you"
   section were removed. `ExamRunner.jsx` keeps its proctoring path
   (fullscreen, tab-switch count), inert because every session is practice.
   A cleanup pass can drop all of it; `web/taxonomy.js` is still used.

## Tooling

- `functions/lib/templates/`: 29 deterministic math generators covering all 19
  math skills. Every wrong choice carries an explanation of the mistake that
  produces it.
  `npm run check:templates` builds thousands, re-derives the answers and holds
  every explanation to the rules (no letter references, balanced math).
- `npm run pool:rebuild-templates`: re-derives every banked template item from
  its template and seed, so a template fix reaches items already in the bank
  (retiring any whose seed no longer builds). Idempotent.
- `functions/lib/templateItems.js`: template rows for the bank, used by assembly
  and by `scripts/topup-pool.js` (`--institution <slug>` fills one bank).
- `functions/lib/similarity.js`: SimHash near-duplicate detection; thresholds in
  `npm run check:similarity`.
- `functions/lib/batch.js`: Anthropic Message Batches, half price, for anything
  nobody is waiting on.
- `npm run check:scoring`: grid-in scoring against the accepted-answer lists.
- `npm run check:practice`: mastery levels, practice difficulty, set sizes and
  the practice specs, without a database.
- `functions/scripts/normalize-skills.js`: relabels bank items to the canonical
  College Board skill names (idempotent).
- **Original questions** (`tools/sat-extract`, see its README and SPEC.md;
  `workflows/originals.js` runs the whole loop, `plan_originals.py` finds
  where it left off):
  `jobs_originals.py` cuts writing jobs (skills, counts per difficulty, the
  bank's own questions as models); sub-agents write them offline;
  `jobs_verify_originals.py` cuts blind-solve jobs for the output; `build.py
  original` keeps only questions whose blind answer matches the key (and drops
  any explanation that names a choice letter, since choices are shuffled);
  `import-dataset.js <dataset> original --institution <slug>` puts them in
  that bank as servable `source='original'` items. `--replace` there retires
  and restores rather than deletes: a served question may sit in a student's
  history.
