// Re-derives every banked template item from its template and seed, so a fix
// to a template (a wrong key, a broken stem, new explanations) reaches the items
// already in the bank instead of only the ones built after it.
//
// A template plus a seed always builds the same item, and each banked item keeps
// both in its rationale. An item whose seed no longer builds (a draw the fixed
// template now rejects) is retired rather than left in circulation. Sessions keep
// their own copy of every question served, so past results do not change.
//
//   node --env-file=.env scripts/rebuild-template-items.js --dry-run
//   node --env-file=.env scripts/rebuild-template-items.js

import { isDeepStrictEqual } from 'node:util';
import { query, pool } from '../lib/db.js';
import { MATH_TEMPLATES, buildItem } from '../lib/templates/math.js';
import { contentHash } from '../lib/items.js';
import { simhash } from '../lib/similarity.js';

const dryRun = process.argv.includes('--dry-run');
const byId = new Map(MATH_TEMPLATES.map((t) => [t.id, t]));

const { rows } = await query(
  `SELECT id, institution_id, question, choices, correct_idx, answer_type, answer_text, rationale
     FROM pa_items
    WHERE source = 'template' AND retired_at IS NULL`,
);

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
    if (!dryRun) await query('UPDATE pa_items SET retired_at = now() WHERE id = $1', [row.id]);
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
    if (!dryRun) await query('UPDATE pa_items SET rationale = $1::jsonb WHERE id = $2', [JSON.stringify(next.rationale), row.id]);
    continue;
  }

  // The question itself changed (a corrected key or stem): new identity too.
  tally.rebuilt += 1;
  changedBy[template.id] = (changedBy[template.id] || 0) + 1;
  if (dryRun) continue;
  const hash = contentHash({ section: 'math', question: next.question, choices: [...next.choices].sort(), passage: null });
  try {
    await query(
      `UPDATE pa_items
          SET question = $1, choices = $2::jsonb, correct_idx = $3, answer_type = $4, answer_text = $5,
              rationale = $6::jsonb, content_hash = $7, simhash = $8
        WHERE id = $9`,
      [next.question, JSON.stringify(next.choices), next.correct_idx, next.answer_type, next.answer_text,
        JSON.stringify(next.rationale), hash, simhash({ question: next.question, choices: next.choices }), row.id],
    );
  } catch (err) {
    if (err.code !== '23505') throw err; // unique violation: the corrected item is already banked
    tally.rebuilt -= 1;
    tally.retired += 1;
    await query('UPDATE pa_items SET retired_at = now() WHERE id = $1', [row.id]);
  }
}

console.log(`${rows.length} template items${dryRun ? ' (dry run, nothing written)' : ''}`);
console.log(`  unchanged                       ${tally.unchanged}`);
console.log(`  explanations added              ${tally.explanations}`);
console.log(`  rebuilt (key or stem corrected) ${tally.rebuilt}`);
console.log(`  retired (seed no longer builds) ${tally.retired}`);
if (tally.unknown) console.log(`  no template or seed recorded    ${tally.unknown}`);
if (Object.keys(changedBy).length) console.log('  rebuilt or retired, by template:', changedBy);
await pool.end();
