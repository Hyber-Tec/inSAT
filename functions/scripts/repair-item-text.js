// Repair question text damaged on its way into the bank (lib/textRepair.js):
// a LaTeX backslash lost to a JSON escape ("\frac" stored as a form feed and
// "rac"), a line break stored as the two characters "\n", math delimiters
// written as bare parentheses, a $ or % inside math. A student sees each as
// raw markup or a KaTeX error.
//
//   node --env-file-if-exists=.env.local scripts/repair-item-text.js            # report only
//   node --env-file-if-exists=.env.local scripts/repair-item-text.js --apply    # repair, keeping a backup
// (from functions/; the emulators when FIRESTORE_EMULATOR_HOST is set, production otherwise)
//
// Only what a student reads is repaired (question, passage, choices,
// explanations), in every bank, the global pool's copies included, and in
// stored sessions, which keep their own copy of each question they served.
// The importers now repair as they read; this is for rows imported before that.
//
// A question whose words change is hashed again the way its importer hashes
// it, so a rerun of that importer, repairing as it reads, finds the question
// already in the bank instead of adding the damaged text a second time. A row
// whose importer is not known here keeps its hash and is listed.
//
// Idempotent. The backup (every changed row's and session's previous text)
// goes to ../exports/.

import fs from 'node:fs';
import path from 'node:path';
import { db, target } from '../lib/firebase.js';
import { COL, col, docOf, queryRows, writeAll } from '../lib/store.js';
import { touched } from '../lib/pool.js';
import { contentHash, hashRef } from '../lib/items.js';
import { simhash } from '../lib/similarity.js';
import { repairItemText } from '../lib/textRepair.js';

const apply = process.argv.includes('--apply');
const FIELDS = ['question', 'passage', 'choices', 'rationale'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The content hash the row's importer would give the repaired text, or null when unknown. */
function hashFor(row, next) {
  const cm = row.rationale?.classmarker;
  if (cm) {
    // import-classmarker.js: a question's figure is part of its identity.
    const question = cm.figure ? `${next.question}|${cm.figure}` : next.question;
    return contentHash({ section: row.section, question, choices: next.choices, passage: next.passage });
  }
  if (row.rationale?.original || row.rationale?.collegeBoardId || row.rationale?.dsat) {
    // import-dataset.js
    return contentHash({ section: row.section, question: next.question, choices: next.choices, passage: next.passage });
  }
  if (row.source === 'variant') {
    // vary-bank.js: the choices in a fixed order, since a variant's are shuffled.
    return contentHash({ section: 'math', question: next.question, choices: [...next.choices].sort(), passage: null });
  }
  return null;
}

try {
  const rows = await queryRows(col(COL.items)
    .select('institution_id', 'section', 'source', 'content_hash', 'question', 'passage', 'choices', 'rationale'));
  const changes = [];
  const unhashed = [];
  for (const row of rows) {
    const next = repairItemText(Object.fromEntries(FIELDS.map((f) => [f, row[f]])));
    if (FIELDS.every((f) => same(row[f], next[f]))) continue;
    const wordsChanged = ['question', 'passage', 'choices'].some((f) => !same(row[f], next[f]));
    let hash = row.content_hash;
    if (wordsChanged) {
      hash = hashFor(row, next) ?? row.content_hash;
      if (hash === row.content_hash) unhashed.push(row.id);
    }
    changes.push({ row, next, hash, fields: FIELDS.filter((f) => !same(row[f], next[f])) });
  }

  // A repaired question must not collide with another row of its bank.
  const taken = new Set(rows.map((r) => `${r.institution_id}|${r.content_hash}`));
  for (const c of changes) {
    if (c.hash !== c.row.content_hash && taken.has(`${c.row.institution_id}|${c.hash}`)) {
      throw new Error(`item ${c.row.id}: repaired, it would duplicate another question of its bank (hash ${c.hash})`);
    }
  }

  const sessions = await queryRows(col(COL.sessions).select('form'));
  const sessionChanges = [];
  for (const sess of sessions) {
    const form = structuredClone(sess.form);
    let changed = false;
    const fix = (q) => {
      const next = repairItemText(q);
      for (const f of FIELDS) {
        if (!same(next?.[f], q?.[f])) { q[f] = next[f]; changed = true; }
      }
    };
    for (const sec of form?.sections || []) {
      for (const mod of sec.modules || []) {
        for (const q of mod.questions || []) fix(q);
        for (const list of Object.values(mod.variants || {})) for (const q of list) fix(q);
      }
    }
    if (changed) sessionChanges.push({ id: sess.id, before: sess.form, after: form });
  }

  console.log(`${changes.length} items carry damaged text; ${sessionChanges.length} stored sessions do`);
  const byField = {};
  for (const c of changes) for (const f of c.fields) byField[f] = (byField[f] || 0) + 1;
  for (const [f, n] of Object.entries(byField)) console.log(`  ${String(n).padStart(5)}  in ${f}`);
  const rehashed = changes.filter((c) => c.hash !== c.row.content_hash).length;
  if (rehashed) console.log(`  ${rehashed} questions hashed again, their words having changed`);
  if (unhashed.length) console.log(`  kept the hash of ${unhashed.length} whose importer is unknown: ${unhashed.join(', ')}`);
  for (const c of changes.slice(0, 4)) {
    const f = c.fields[0];
    console.log(`  ${c.row.id.slice(0, 8)} ${f}: ${JSON.stringify(JSON.stringify(c.row[f]).slice(0, 110))}`);
  }

  if (apply && (changes.length || sessionChanges.length)) {
    const backup = path.resolve(`../exports/item-text-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, JSON.stringify({
      items: changes.map(({ row }) => ({ id: row.id, content_hash: row.content_hash, ...Object.fromEntries(FIELDS.map((f) => [f, row[f]])) })),
      sessions: sessionChanges.map(({ id, before }) => ({ id, form: before })),
    }, null, 2) + '\n');
    console.log(`writing to ${target()}`);
    for (const { row, next, hash } of changes) {
      // The repaired text, and its place in the bank when its words changed.
      const batch = db.batch();
      if (hash !== row.content_hash) {
        if (row.content_hash) batch.delete(hashRef(row.institution_id, row.content_hash));
        batch.create(hashRef(row.institution_id, hash), { item_id: row.id });
      }
      batch.update(col(COL.items).doc(row.id), {
        question: next.question, passage: next.passage, choices: next.choices, rationale: next.rationale,
        content_hash: hash, simhash: simhash(next), ...touched(),
      });
      await batch.commit();
    }
    await writeAll(sessionChanges.map((c) => ['update', col(COL.sessions).doc(c.id), docOf(COL.sessions, { form: c.after })]));
    console.log(`repaired ${changes.length} items and ${sessionChanges.length} sessions; previous text saved to ${backup}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
