# Variation engine: validation

Run locally on 2026-09-30 against the Satify bank and the running app.

## What it is

`server/lib/variation/` makes new math questions from the institution's own
questions, without a model. It reads a question, solves it, and writes the
same question with new numbers, new wrong answers built from named mistakes,
and a worked explanation. A question is used only when the engine's own
solution reproduces the source's key.

## Result

- Read 1,407 original math questions without figures (sources rated 2 or lower
  for realism, or with garbled text, are skipped).
- Understood 285: the engine reproduced their keys exactly.
- Made 515 verified variants from 174 of them (up to 3 per source):
  420 from formal math (equations, systems, functions, equivalent expressions,
  solution counts) and 95 from word problems (percentages, rates and units,
  geometry formulas, modeling).
- By difficulty: 319 easy, 190 medium, 6 hard. A variant keeps its source's
  difficulty, and few hard sources are understood yet.
- 33 variants are filed under a different skill than their source, because
  the question's structure does not support the source's label (for example
  "f(x) = 4x - 7, what is f(-2)?" filed as a nonlinear function).
- All 515 imported into the Satify pool as `source = 'variant'`, linked to
  their sources. Active questions: 4,462 before, 4,977 after.

Batch, per-source coverage and reasons: [`exports/variants-2026-09-30/`](../exports/variants-2026-09-30/coverage.md).

## How each variant is checked

- Formal math: solved exactly (rational arithmetic, polynomial algebra), then
  re-read from its rendered text and solved again numerically; exactly one
  choice must match, every math span must render in KaTeX and print back to
  the same tree, and the item must pass the structural checks shared with the
  templates (`lib/itemChecks.js`).
- Word problems: every number re-extracted from the rendered text, every
  formula evaluated again in floating point, and the key bound a second time
  on the new numbers to the same formula and to no other.
- Every word-problem variant in this batch (95) and a sample of every formal
  kind were also read by hand. Earlier drafts of the word rules produced wrong
  keys (a polygon-angle law varied, coincidental formulas for 9 = 3 squared,
  a rounded key matched by a near-miss formula); each case became a rule and a
  regression test: facts of the world never vary, percent is a unit, no
  rounding-dependent keys, radicands fixed, squares only in geometry, long keys
  need corroboration.

## Browser checks (real API, database and UI)

`npm run check:variants` served variants to temporary students in isolated
institutions, for a formal skill (linear equations) and a word-problem skill
(percentages). Both passed: 10/10 answered correctly through shuffled choices,
no question and its variant in one set, lineages the student had not met
served first in the second set, no KaTeX errors, no console or API errors, no
horizontal overflow on a phone. Screenshots: `.logs/variants-e2e/` and
`.logs/variants-e2e-word/`.

## Also fixed along the way

- 150 student-facing explanations (300 counting the global pool) named a
  choice by its letter ("which gives C"); choices are shuffled per student, so
  the letter pointed at the wrong choice. Rewritten to quote the choice
  (`scripts/fix-letter-rationales.js`, backup in `exports/`), including one
  stored session. The import's check now catches that phrasing.
- 253 questions showed ClassMarker's raw `^{a}/_{b}` fraction markup; the
  renderer now typesets it (and its stray sign and empty-subscript debris).
- Plain-text minus signs render as true minus signs; the answer review header
  no longer wraps "Question 1" on a phone.
- The server taxonomy again holds exactly the College Board's 29 skills (an
  earlier session had added pseudo-domains "reading" and "writing").

## Limits

- 1,122 sources are not understood yet. The largest groups: conceptual word
  problems with no numbers to vary (262), numbers more than one formula could
  explain (207), and question shapes the engine does not read yet (slopes and
  intercepts, "which equation defines f", tables, most geometry and data).
- Modeling questions whose source explanation is generic are left alone rather
  than given an explanation that explains nothing.
- The engine adds depth where sources exist; the thin cells in
  [practice-coverage.md](practice-coverage.md) (hard difficulty, the statistics
  skills) need more understood sources there.
