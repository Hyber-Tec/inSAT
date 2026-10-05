// Rewrite explanations that point at a choice by its letter.
//
// Some imported explanations end "..., which gives C." Choices are shuffled
// for every student, so for most students "C" names a different choice than
// the one meant. The letter always names the keyed choice in the stored
// order, so it is replaced with that choice itself: "..., which gives 74."
// A choice that is a sentence rather than a value is not quoted; the clause
// is dropped instead.
//
//   node --env-file-if-exists=.env.local scripts/fix-letter-rationales.js            # report only
//   node --env-file-if-exists=.env.local scripts/fix-letter-rationales.js --apply    # rewrite, keeping a backup
// (from functions/; the emulators when FIRESTORE_EMULATOR_HOST is set, production otherwise)
//
// Sessions already served keep their own copy of each question, with the
// choices in that student's order; those copies are rewritten the same way,
// quoting the keyed choice as the student saw it.
//
// Idempotent: a fixed explanation no longer matches. The backup (every
// changed item's previous rationale, every changed session's previous form)
// goes to ../exports/.

import fs from 'node:fs';
import path from 'node:path';
import { target } from '../lib/firebase.js';
import { COL, col, docOf, queryRows, writeAll } from '../lib/store.js';
import { touched } from '../lib/pool.js';

const apply = process.argv.includes('--apply');
const LETTERS = ['A', 'B', 'C', 'D'];
const CLAUSE = /,\s*which gives\s+\(?([A-D])\)?\./g;
// What the clause looks like anywhere in an item's or a form's JSON.
const NAMES_A_LETTER = /which gives \(?[A-D]\)?\./;

/** The keyed choice as a value to quote, or null when it reads as a sentence. */
function quotable(choice) {
  const text = String(choice ?? '').trim();
  const words = text.replace(/\\\(|\\\)|\\[a-z]+|[{}]/g, ' ').match(/[A-Za-z]{3,}/g) || [];
  return text && text.length <= 60 && words.length <= 1 ? text.replace(/\.$/, '') : null;
}

try {
  const rows = (await queryRows(col(COL.items)
    .where('answer_type', '==', 'multiple-choice').select('choices', 'correct_idx', 'rationale')))
    .filter((r) => NAMES_A_LETTER.test(JSON.stringify(r.rationale)));
  const changes = [];
  for (const r of rows) {
    const key = LETTERS[r.correct_idx];
    const value = quotable(r.choices[r.correct_idx]);
    const next = {};
    let changed = false;
    for (const [k, text] of Object.entries(r.rationale)) {
      if (typeof text !== 'string') { next[k] = text; continue; }
      next[k] = text.replace(CLAUSE, (all, letter) => {
        if (letter !== key) throw new Error(`item ${r.id}: "${all}" does not name the keyed choice ${key}`);
        changed = true;
        return value ? `, which gives ${value}.` : '.';
      });
    }
    if (changed) changes.push({ id: r.id, before: r.rationale, after: next });
  }
  // Served copies: every question instance in a stored form.
  const sessions = (await queryRows(col(COL.sessions).select('form')))
    .filter((sess) => NAMES_A_LETTER.test(JSON.stringify(sess.form)));
  const sessionChanges = [];
  for (const sess of sessions) {
    const form = structuredClone(sess.form);
    let changed = false;
    const fix = (q) => {
      if (!q || q.answerType === 'grid-in' || !q.rationale) return;
      const value = quotable(q.choices?.[q.correctIdx]);
      for (const [k, text] of Object.entries(q.rationale)) {
        if (typeof text !== 'string' || !CLAUSE.test(text)) continue;
        CLAUSE.lastIndex = 0;
        q.rationale[k] = text.replace(CLAUSE, () => (value ? `, which gives ${value}.` : '.'));
        changed = true;
      }
      CLAUSE.lastIndex = 0;
    };
    for (const sec of form.sections || []) {
      for (const mod of sec.modules || []) {
        for (const q of mod.questions || []) fix(q);
        for (const list of Object.values(mod.variants || {})) for (const q of list) fix(q);
      }
    }
    if (changed) sessionChanges.push({ id: sess.id, before: sess.form, after: form });
  }
  console.log(`${changes.length} items name a choice by its letter; ${sessionChanges.length} served sessions carry such an explanation`);
  for (const c of changes.slice(0, 3)) console.log(JSON.stringify({ before: Object.values(c.before).find((t) => /which gives/.test(t)), after: Object.values(c.after).find((t) => /calculation/.test(t)) }));
  if (apply && (changes.length || sessionChanges.length)) {
    const backup = path.resolve(`../exports/letter-rationales-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, JSON.stringify({
      items: changes.map(({ id, before }) => ({ id, rationale: before })),
      sessions: sessionChanges.map(({ id, before }) => ({ id, form: before })),
    }, null, 2) + '\n');
    console.log(`writing to ${target()}`);
    await writeAll([
      ...changes.map((c) => ['update', col(COL.items).doc(c.id), { rationale: c.after, ...touched() }]),
      ...sessionChanges.map((c) => ['update', col(COL.sessions).doc(c.id), docOf(COL.sessions, { form: c.after })]),
    ]);
    console.log(`rewrote ${changes.length} items and ${sessionChanges.length} sessions; previous text saved to ${backup}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
