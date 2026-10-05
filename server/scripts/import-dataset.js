// Imports a transcribed question dataset (built by tools/sat-extract) into the bank.
//
// The dataset lives outside the repository, next to the source PDFs, because it
// is College Board and third-party content. Each line of
// <dataset>/<collection>.jsonl is one question in a fixed shape (see
// tools/sat-extract/SPEC.md); figures are PNGs under <dataset>/figures/.
//
// The transcribed collections land as source='reference' in the global pool,
// the same as the old PDF importer: generation learns from them and their
// difficulty labels anchor generated items, but students never see them
// (candidatesFor in assembly.js excludes reference items).
//   cb    the College Board question bank. --replace swaps out every earlier
//         College Board reference row, which is how the rows the old
//         Ghostscript importer produced (truncated stems, missing math) retire.
//   dsat  the full-length practice tests. A question whose key disagrees with
//         the transcriber's own solution, or that has no key, is held back:
//         a wrong key would teach generation the wrong answer. Import cb first:
//         a practice-test question the bank already holds is skipped.
// Original questions are the exception: written to the College Board's style
// and kept only when a blind solve agreed with the key (tools/sat-extract/
// SPEC.md, "Original-question jobs"), they are served to students, so they go
// into an institution's own bank as source='original'.
//   original  needs --institution <slug>. --replace syncs that bank with the
//         dataset: a question the dataset dropped or rewrote is retired (a
//         served question may sit in a student's history, so never deleted),
//         and one the dataset carries again comes back.
//
// Run:
//   node --env-file=.env scripts/import-dataset.js "/path/to/extracted/dataset" cb --dry-run
//   node --env-file=.env scripts/import-dataset.js "/path/to/extracted/dataset" cb --replace
//   node --env-file=.env scripts/import-dataset.js "/path/to/extracted/dataset" dsat --replace
//   node --env-file=.env scripts/import-dataset.js "/path/to/extracted/dataset" original --institution satify --replace

import fs from 'node:fs';
import path from 'node:path';
import { pool, query } from '../lib/db.js';
import { globalPoolId, ensureGlobalPool } from '../lib/pool.js';
import { contentHash, importRows } from '../lib/items.js';
import { repairItemText } from '../lib/textRepair.js';
import { DOMAINS, canonicalSkill } from '../lib/taxonomy.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const args = process.argv.slice(2);
const institutionAt = args.indexOf('--institution');
const institutionSlug = institutionAt >= 0 ? args[institutionAt + 1] || '' : '';
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--institution');
const [datasetDir, collection] = positional;
const dryRun = args.includes('--dry-run');
const replace = args.includes('--replace');
const servable = collection === 'original';

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Where a row came from, kept in its rationale JSON so --replace can find the
// rows of one collection again.
const ORIGIN = {
  cb: (q) => ({ collegeBoardId: q.source_id }),
  dsat: (q) => ({ dsat: { test: q.test, section: q.section, module: q.module, number: q.number } }),
  original: (q) => ({ original: { job: q.job, index: q.index } }),
};

/** An original question's explanations: the correct answer's, then each wrong choice's by letter. */
function originalRationale(q) {
  const out = { correct: q.rationale.correct };
  for (const letter of LETTERS) {
    if (letter !== q.answer && q.rationale[letter]) out[letter] = q.rationale[letter];
  }
  return out;
}

/** One dataset question -> a pa_items row, or a reason it cannot be one. */
function toRow(q) {
  if (!DOMAINS[q.section]?.includes(q.domain)) return { skip: `unknown domain ${q.domain}` };
  if (collection === 'dsat') {
    if (!q.answer) return { skip: 'no answer key' };
    if ((q.flags || []).some((f) => f.startsWith('key-disagrees'))) return { skip: 'key disagrees with the solution (review first)' };
    // A question a reviewer found to have no single defensible answer would
    // teach generation the same flaw.
    if ((q.flags || []).some((f) => f.startsWith('ambiguous'))) return { skip: 'ambiguous as printed' };
  }
  const isGrid = q.answer_type === 'grid-in';
  const correctIdx = LETTERS.indexOf(String(q.answer || '').trim());
  if (!isGrid && (correctIdx < 0 || (q.choices || []).length !== 4)) return { skip: 'malformed multiple choice' };
  if (!isGrid && new Set(q.choices.map((c) => String(c).trim())).size !== 4) return { skip: 'two choices are the same (source error)' };
  if (isGrid && !String(q.answer || '').trim()) return { skip: 'grid-in without an answer' };

  const passage = q.section === 'rw' ? (q.passage || null) : null;
  const choices = isGrid ? [] : q.choices;
  const figures = (q.figures || []).map(({ kind, choice, description, table }) => ({ kind, choice, description, table }));
  return {
    row: {
      content_hash: contentHash({ section: q.section, question: q.question, choices, passage }),
      section: q.section,
      domain: q.domain,
      skill: canonicalSkill(q.domain, q.skill) || q.skill || '',
      difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
      passage,
      question: q.question,
      choices,
      correct_idx: isGrid ? 0 : correctIdx,
      answer_type: isGrid ? 'grid-in' : 'multiple-choice',
      answer_text: isGrid ? String(q.answer).trim() : null,
      accepted: isGrid ? (q.accepted || []) : null,
      // flags travel with the item so a reviewer can see what the transcription noted
      rationale: {
        ...(servable ? originalRationale(q) : { correct: q.rationale || '' }),
        ...ORIGIN[collection](q),
        flags: q.flags || [],
        // An explanation the source did not print, written to its style (see
        // tools/sat-extract/SPEC.md, "Explanation-writing jobs").
        ...((q.flags || []).includes('explanation-written') ? { written: true } : {}),
      },
      figure: figures.length ? { figures } : null,
      png: q.figure_asset ? fs.readFileSync(path.join(datasetDir, q.figure_asset)) : null,
      source: servable ? 'original' : 'reference',
      // reference: the source's own key, re-solved during transcription;
      // original: the writer's key, confirmed by a blind solve
      verified: true,
    },
  };
}

/** The bank the rows go into: an institution's own for servable questions, else the global pool. */
async function targetInstitution() {
  if (!servable) {
    await ensureGlobalPool();
    return { id: await globalPoolId(), label: 'the global pool' };
  }
  if (!institutionSlug) throw new Error('original questions are served to students: name the bank with --institution <slug>');
  const { rows } = await query('SELECT id, name FROM pa_institutions WHERE slug = $1', [institutionSlug]);
  if (!rows[0]) throw new Error(`No institution with slug "${institutionSlug}"`);
  return { id: rows[0].id, label: `the ${rows[0].name} bank` };
}

/**
 * Bring a bank's original questions in line with the dataset. A served row may
 * be in a student's history by id, so a question the dataset no longer carries
 * is retired rather than deleted, and one it carries again is restored. Only
 * the dataset's own rows (marked by ORIGIN.original) are compared: the bank's
 * other original questions, such as an academy's ClassMarker pool, are not
 * the dataset's to retire.
 */
async function syncOriginals(institutionId, rows) {
  const wanted = new Set(rows.map((r) => r.content_hash));
  const { rows: have } = await query(
    `SELECT id, content_hash, retired_at FROM pa_items
      WHERE institution_id = $1 AND source = 'original' AND rationale ? 'original'`,
    [institutionId],
  );
  let retired = 0;
  let restored = 0;
  for (const item of have) {
    if (wanted.has(item.content_hash) && item.retired_at) {
      restored += 1;
      await query('UPDATE pa_items SET retired_at = NULL WHERE id = $1', [item.id]);
    } else if (!wanted.has(item.content_hash) && !item.retired_at) {
      retired += 1;
      await query('UPDATE pa_items SET retired_at = now() WHERE id = $1', [item.id]);
    }
  }
  console.log(`\nsynced with the dataset: retired ${retired}, restored ${restored}`);
}

async function main() {
  if (!datasetDir || !ORIGIN[collection]) {
    console.error('Usage: import-dataset.js "/path/to/extracted/dataset" cb|dsat|original [--institution <slug>] [--replace] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const file = path.join(datasetDir, `${collection}.jsonl`);
  // Transcribers write JSON by hand: what a student reads is repaired where
  // they damaged it before anything is checked (lib/textRepair.js).
  const questions = readJsonl(file).map(repairItemText);
  const rows = [];
  const skipped = {};
  for (const q of questions) {
    const { row, skip } = toRow(q);
    if (skip) { skipped[skip] = (skipped[skip] || 0) + 1; continue; }
    rows.push(row);
  }
  const count = (pred) => rows.filter(pred).length;
  console.log(`${questions.length} questions in ${file}`);
  console.log(`  importable   ${rows.length}  (rw ${count((r) => r.section === 'rw')}, math ${count((r) => r.section === 'math')})`);
  console.log(`  with figure  ${count((r) => r.png)}`);
  console.log(`  grid-in      ${count((r) => r.answer_type === 'grid-in')}`);
  for (const [why, n] of Object.entries(skipped)) console.log(`  skipped      ${n}  (${why})`);
  if (dryRun) { console.log('\n--dry-run: nothing written.'); return; }

  const target = await targetInstitution();
  if (replace && servable) {
    await syncOriginals(target.id, rows);
  } else if (replace) {
    // Reference rows are never served, so no session or exam points at them;
    // their figure assets go with them.
    const marker = collection === 'cb' ? 'collegeBoardId' : 'dsat';
    const { rows: gone } = await query(
      `DELETE FROM pa_items
        WHERE institution_id = $1 AND source = 'reference' AND rationale ? $2
        RETURNING asset_id`,
      [target.id, marker],
    );
    const assets = gone.map((r) => r.asset_id).filter(Boolean);
    if (assets.length) await query('DELETE FROM pa_assets WHERE id = ANY($1::uuid[])', [assets]);
    console.log(`\ncleared ${gone.length} earlier ${collection} reference items`);
  }
  // The College Board bank is a faithful copy: distinct questions that share a
  // passage are all kept, so the near-duplicate gate is off for it. Practice
  // tests go through the gate, so a question the bank already holds (official
  // tests reuse bank items) stays as the bank's version with its official
  // labels. Originals go through it too: a servable bank should stay varied.
  const result = await importRows(rows, target.id, { nearDuplicates: collection === 'cb' ? 'allow' : 'reject' });
  console.log(`\nimported into ${target.label} as ${servable ? 'servable questions' : 'reference material'}:`);
  console.log(`  added           ${result.added}`);
  console.log(`  duplicate       ${result.duplicates}`);
  console.log(`  near-duplicate  ${result.nearDuplicates}`);
  console.log(`  skipped         ${result.skipped}`);
}

main()
  .catch((err) => { console.error(`\nFailed: ${err.message}`); process.exitCode = 1; })
  .finally(() => pool.end?.());
