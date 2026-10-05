// Re-derives every banked template item from its template and seed, so a fix
// to a template (a wrong key, a broken stem, new explanations) reaches the items
// already in the bank instead of only the ones built after it.
//
// A template plus a seed always builds the same item, and each banked item keeps
// both in its rationale. An item whose seed no longer builds (a draw the fixed
// template now rejects) is retired rather than left in circulation. Sessions keep
// their own copy of every question served, so past results do not change.
//
//   node --env-file-if-exists=.env.local scripts/rebuild-template-items.js --dry-run
//   node --env-file-if-exists=.env.local scripts/rebuild-template-items.js
// (from functions/; the emulators when FIRESTORE_EMULATOR_HOST is set, production otherwise)

import { isDeepStrictEqual } from 'node:util';
import { db, target } from '../lib/firebase.js';
import { COL, col, queryRows } from '../lib/store.js';
import { touched } from '../lib/pool.js';
import { MATH_TEMPLATES, buildItem } from '../lib/templates/math.js';
import { contentHash, hashRef } from '../lib/items.js';
import { simhash } from '../lib/similarity.js';

const dryRun = process.argv.includes('--dry-run');
const byId = new Map(MATH_TEMPLATES.map((t) => [t.id, t]));
const item = (id) => col(COL.items).doc(id);
const retire = (id) => item(id).update({ retired_at: new Date(), ...touched() });

const rows = await queryRows(col(COL.items)
  .where('source', '==', 'template').where('retired_at', '==', null)
  .select('institution_id', 'content_hash', 'question', 'choices', 'correct_idx', 'answer_type', 'answer_text', 'rationale'));
if (!dryRun) console.log(`writing to ${target()}`);

const tally = { unchanged: 0, explanations: 0, rebuilt: 0, retired: 0, unknown: 0 };
const changedBy = {};
for (const row of rows) {
  const template = byId.get(row.rationale?.template);
  const seed = Number(row.rationale?.seed);
  if (!template || !Number.isFinite(seed)) { tally.unknown += 1; continue; }

  // Exactly this seed: a re-roll would be a different question.
  const built = buildItem(template, seed, 1);
  if (!built) {
    tally.retired += 1;
    changedBy[template.id] = (changedBy[template.id] || 0) + 1;
    if (!dryRun) await retire(row.id);
    continue;
  }

  const next = {
    question: built.question,
    choices: built.choices,
    correct_idx: built.correctIdx,
    answer_type: built.answerType,
    answer_text: built.answerText || null,
    rationale: { ...built.rationale, template: template.id, seed },
  };
  const sameItem = next.question === row.question && isDeepStrictEqual(next.choices, row.choices)
    && next.correct_idx === row.correct_idx && next.answer_type === row.answer_type
    && (next.answer_text ?? null) === (row.answer_text ?? null);
  if (sameItem && isDeepStrictEqual(next.rationale, row.rationale)) { tally.unchanged += 1; continue; }

  if (sameItem) {
    tally.explanations += 1;
    if (!dryRun) await item(row.id).update({ rationale: next.rationale, ...touched() });
    continue;
  }

  // The question itself changed (a corrected key or stem): new identity too.
  tally.rebuilt += 1;
  changedBy[template.id] = (changedBy[template.id] || 0) + 1;
  if (dryRun) continue;
  const hash = contentHash({ section: 'math', question: next.question, choices: [...next.choices].sort(), passage: null });
  const rebuilt = await db.runTransaction(async (t) => {
    // The corrected item may already be banked under its new identity.
    if (hash !== row.content_hash) {
      if ((await t.get(hashRef(row.institution_id, hash))).exists) return false;
      if (row.content_hash) t.delete(hashRef(row.institution_id, row.content_hash));
      t.create(hashRef(row.institution_id, hash), { item_id: row.id });
    }
    t.update(item(row.id), {
      ...next, content_hash: hash, simhash: simhash({ question: next.question, choices: next.choices }), ...touched(),
    });
    return true;
  });
  if (!rebuilt) {
    tally.rebuilt -= 1;
    tally.retired += 1;
    await retire(row.id);
  }
}

console.log(`${rows.length} template items${dryRun ? ' (dry run, nothing written)' : ''}`);
console.log(`  unchanged                       ${tally.unchanged}`);
console.log(`  explanations added              ${tally.explanations}`);
console.log(`  rebuilt (key or stem corrected) ${tally.rebuilt}`);
console.log(`  retired (seed no longer builds) ${tally.retired}`);
if (tally.unknown) console.log(`  no template or seed recorded    ${tally.unknown}`);
if (Object.keys(changedBy).length) console.log('  rebuilt or retired, by template:', changedBy);
