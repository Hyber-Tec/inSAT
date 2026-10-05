# Self-guided practice validation

Validated locally on 2026-09-30 against the running API, Chromium browser, and
Postgres database. Local self-guided practice works with the existing bank.
This was not a deployment or a production readiness audit.

## New questions

- Generated 48 new math questions: 12 each for linear equations in one variable,
  equivalent expressions, measures of center and spread, and area and volume.
- Independently re-derived the answers from each rendered question using a
  separate solver and checked the question structure, explanations, and
  canonical classification before import.
- Imported all 48 into the Satify institution's student pool. No duplicates or
  skipped questions in this batch.
- These are deterministic template questions. No live model was called, and no
  new Reading and Writing questions were generated in this run.

Artifacts:

- [Questions with classification](../exports/verified-practice-2026-09-30/questions.jsonl)
- [Verification results](../exports/verified-practice-2026-09-30/verification.json)
- [Batch manifest and bank IDs](../exports/verified-practice-2026-09-30/manifest.json)

## Real student workflow

The repeatable browser check uses the actual API and database, with no mocked
model responses or mocked persistence in the student flow:

1. Sign in as a new temporary student and see all 29 skills.
2. Take and submit a full 98-question diagnostic across both sections.
3. Confirm easy adaptive routes after low performance; separately confirm a
   hard math route after correct Module 1 answers.
4. See scored results, skill breakdowns, and explanations in question review.
5. Start and complete a 12-question set from the weakest-skill recommendations.
   Stored question IDs confirm zero repeats from the diagnostic.
6. Confirm the completed follow-up updates the student's profile and carries no
   misleading SAT scaled score for a short skill set.
7. In a temporary institution containing the new batch, serve ten of the newly
   generated questions, answer them correctly through the browser, and receive
   10/10 after choice shuffling.
8. Check the phone layout at 390 pixels: reading passage above question,
   usable answer choices, and no horizontal overflow.

The mobile reading layout was corrected during this run. Temporary test users,
sessions, and the isolated batch-test institution were removed afterward.

[Machine-readable results](../.logs/self-guided-e2e/evidence.json) and screenshots
are saved in `.logs/self-guided-e2e/`.

## Checks

- Real browser workflow: passed.
- Client production build: passed.
- Generation gate: six tests passed, with simulated model responses.
- Independent template verification: two regression tests passed.
- Template checks: 8,675 rendered items passed structural checks; independent
  answer solvers cover 19 of the 29 template patterns, including every pattern
  used in the new batch.
- Practice policy: ten checks passed.
- Scoring: 19 checks passed.
- Similarity checks and whitespace checks: passed.

## Remaining limits

- No provider key is configured. Fresh model-generated questions and live
  independent model verification still need a key in admin Settings. That path
  was not exercised with a real model in this run.
- [Coverage report](practice-coverage.md): 4,462 active student-pool questions,
  all 29 skills represented, 23 of 87 skill/difficulty cells below the planning
  target of 20, and six cells with no stored questions. Question totals include
  six additional math items created by normal practice assembly during testing.
- Previously imported questions were exercised, not independently reverified
  in their entirety.
- Installing the browser-test dependency exposed seven existing client
  dependency audit advisories. Automatic remediation failed because npm
  returned 404 for `electron-to-chromium@1.5.443`. Dependency remediation remains
  outside the completed functional validation.

## Repeat

Start the API and client, then from `web/`:

```bash
npm run check:self-guided -- ../exports/verified-practice-2026-09-30
```

From `functions/`, prepare another independently checked math batch or update the
inventory report:

```bash
npm run pool:prepare -- --institution satify --import
npm run pool:coverage -- satify
```

Omit `--import` to prepare an export for review without adding it to the pool.
