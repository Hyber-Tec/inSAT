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
//   cb    the College Board question bank, as it stands (tools/sat-extract
//         fetches it from the bank's own site). --replace swaps out every
//         earlier College Board reference row.
//   dsat  the full-length practice tests. A question whose key disagrees with
//         the transcriber's own solution, or that has no key, is held back:
//         a wrong key would teach generation the wrong answer. Import cb first:
//         a practice-test question the bank already holds is skipped.
// Original questions are the exception: written to the College Board's style
// and kept only when a blind solve agreed with the key (tools/sat-extract/
// SPEC.md, "Original-question jobs"), they are served to students, so they go
// into an institution's own bank as source='original'.
//   original  needs --institution <slug>. --replace syncs that bank with the
//         dataset (below).
// The College Board bank and the practice tests are served as well: given
// --institution, cb or dsat puts its questions into that bank as
// source='official', each explanation in the bank's shape (lib/official.js; a
// question whose explanation cannot be, because it names choices by letter,
// stays reference material). --replace syncs as for originals. Import cb
// before dsat here too.
// Every bank and practice-test question, reference or official, is rated by
// how closely it reads like the current exam: the College Board's own (the
// bank, and a practice test most of whose questions the bank holds) 5, a
// third-party practice test's 4. It is also dated (`published_on`): the day
// the College Board published it in its bank, or the day its practice test
// was made. A full test draws the highest rated first and, among those, the
// newest; a practice set leans the same way (lib/assembly.js); generation
// imitates them first (lib/generate.js).
//
// --replace keeps a served bank in line with the dataset. A question is known
// by where it came from (ORIGIN: the bank's question id, a test's question
// number), so one the source rewords, re-rates, re-dates, re-keys or redraws
// is changed in place and keeps its id, and with it its place in students'
// histories; one the dataset no longer holds is retired (never deleted: a
// served question may sit in a student's history) and one it holds again
// comes back. A question the College Board's bank holds is served as the
// bank's: a practice test's copy of it is not served, and once the bank is
// imported, a copy the pool serves from elsewhere (the academy's ClassMarker
// questions had many before the bank published them) is retired.
//
// Run (from functions/; the emulators when FIRESTORE_EMULATOR_HOST is set,
// production otherwise):
//   node --env-file-if-exists=.env.local scripts/import-dataset.js "/path/to/extracted/dataset" cb --dry-run
//   node --env-file-if-exists=.env.local scripts/import-dataset.js "/path/to/extracted/dataset" cb --replace
//   node --env-file-if-exists=.env.local scripts/import-dataset.js "/path/to/extracted/dataset" dsat --replace
//   node --env-file-if-exists=.env.local scripts/import-dataset.js "/path/to/extracted/dataset" original --institution satify --replace
//   node --env-file-if-exists=.env.local scripts/import-dataset.js "/path/to/extracted/dataset" cb --institution satify --replace
//   node --env-file-if-exists=.env.local scripts/import-dataset.js "/path/to/extracted/dataset" dsat --institution satify --replace

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bucket, db, target as writingTo } from '../lib/firebase.js';
import { COL, col, docOf, getMany, queryRows, writeAll } from '../lib/store.js';
import { globalPoolId, ensureGlobalPool, touched } from '../lib/pool.js';
import { contentHash, hashRef, importRows } from '../lib/items.js';
import { assetMd5, saveAsset } from '../lib/assets.js';
import { simhash } from '../lib/similarity.js';
import { byCell, holds, planSync, stable } from '../lib/datasetSync.js';
import { repairItemText } from '../lib/textRepair.js';
import { DOMAINS, canonicalSkill } from '../lib/taxonomy.js';
import { collegeBoardTests, officialRationale, officialRealism } from '../lib/official.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const args = process.argv.slice(2);
const institutionAt = args.indexOf('--institution');
const institutionSlug = institutionAt >= 0 ? args[institutionAt + 1] || '' : '';
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--institution');
const [datasetDir, collection] = positional;
const dryRun = args.includes('--dry-run');
const replace = args.includes('--replace');
// Official questions: the College Board bank or a practice test served from an institution's bank.
const official = Boolean(institutionSlug) && (collection === 'cb' || collection === 'dsat');
const servable = collection === 'original' || official;
const SOURCE = official ? 'official' : servable ? 'original' : 'reference';

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

/**
 * One dataset question -> an item row, or a reason it cannot be one.
 * `ownTests`: the practice tests that are the College Board's own.
 */
function toRow(q, ownTests) {
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
  const shaped = official ? officialRationale(q) : null;
  if (shaped && !shaped.rationale) return { skip: `${shaped.why}: stays reference` };

  const passage = q.section === 'rw' ? (q.passage || null) : null;
  const choices = isGrid ? [] : q.choices;
  const figures = (q.figures || []).map(({ kind, choice, description, table }) => ({ kind, choice, description, table }));
  return {
    row: {
      content_hash: contentHash({ section: q.section, question: q.question, choices, passage, figure: q.figure_key }),
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
        ...(official ? shaped.rationale : servable ? originalRationale(q) : { correct: q.rationale || '' }),
        ...ORIGIN[collection](q),
        flags: q.flags || [],
        // An explanation the source did not print, written to its style (see
        // tools/sat-extract/SPEC.md, "Explanation-writing jobs").
        ...((q.flags || []).includes('explanation-written') ? { written: true } : {}),
      },
      figure: figures.length ? { figures } : null,
      png: q.figure_asset ? fs.readFileSync(path.join(datasetDir, q.figure_asset)) : null,
      source: SOURCE,
      // reference and official: the source's own key, re-solved during
      // transcription; original: the writer's key, confirmed by a blind solve
      verified: true,
      ...(collection === 'original' ? {} : { realism: officialRealism(collection, q, ownTests) }),
      published_on: q.published_on || null,
    },
  };
}

/** The bank the rows go into: an institution's own for servable questions, else the global pool. */
async function targetInstitution() {
  if (!servable) {
    await ensureGlobalPool();
    return { id: await globalPoolId(), label: 'the global pool' };
  }
  if (!institutionSlug) throw new Error(`${SOURCE} questions are served to students: name the bank with --institution <slug>`);
  const [found] = await queryRows(col(COL.institutions).where('slug', '==', institutionSlug).limit(1));
  if (!found) throw new Error(`No institution with slug "${institutionSlug}"`);
  return { id: found.id, label: `the ${found.name} bank` };
}

/** Where a row came from (its ORIGIN, as text), or null for a row of another collection. */
const MARKER = Object.keys(ORIGIN[collection]?.({}) || {})[0];
const originOf = (r) => (r.rationale && MARKER in r.rationale ? stable(r.rationale[MARKER]) : null);

/**
 * Bring a bank's served questions from this collection in line with the
 * dataset (lib/datasetSync.js, planSync): a question changed in place keeps
 * its id, one the dataset dropped or `held` names is retired, one it carries
 * again is restored. Only the collection's own rows are compared: the bank's
 * other questions, such as an academy's ClassMarker pool among the originals,
 * are not the dataset's to retire.
 */
async function syncServed(institutionId, rows, held = new Set()) {
  const have = (await queryRows(col(COL.items)
    .where('institution_id', '==', institutionId).where('source', '==', SOURCE)))
    .filter((item) => originOf(item) !== null);
  // Who holds each content hash the dataset's questions have, read at once.
  const locks = await getMany(COL.itemHashes, [...new Set(rows.map((r) => `${institutionId}_${r.content_hash}`))], ['item_id']);
  const holderOf = (hash) => locks.get(`${institutionId}_${hash}`)?.item_id ?? null;
  const { updates, moves, counts: n } = planSync({ have, rows, originOf, held, holderOf });
  await writeAll(updates.map(({ item, changes }) => ['update', col(COL.items).doc(item.id), { ...docOf(COL.items, changes), ...touched() }]));
  for (const m of moves) await move(institutionId, m);
  console.log(`\nsynced with the dataset: changed ${n.changed} (${n.moved} reworded or redrawn), retired ${n.retired}`
    + `${n.repeats ? ` (${n.repeats} now repeat another question)` : ''}, restored ${n.restored}`);
}

/**
 * Move a served question to the identity (content hash) its new wording
 * gives it, with the dataset's changes, and its figure when that changed.
 * The old figure stays in storage: past sessions show it.
 */
async function move(institutionId, { item, row, changes, fresh }) {
  Object.assign(changes, { content_hash: row.content_hash, simhash: simhash(row) });
  if (row.png && (await assetMd5(item.asset_id)) !== crypto.createHash('md5').update(row.png).digest('base64')) {
    changes.asset_id = await saveAsset({ mime: 'image/png', bytes: row.png });
  }
  const batch = db.batch();
  if (item.content_hash) batch.delete(hashRef(institutionId, item.content_hash));
  if (fresh) batch.create(hashRef(institutionId, row.content_hash), { item_id: item.id });
  batch.update(col(COL.items).doc(item.id), { ...docOf(COL.items, changes), ...touched() });
  await batch.commit();
}

/** The College Board bank's questions an institution serves, by cell (lib/datasetSync.js). */
async function servedBank(institutionId) {
  return byCell((await queryRows(col(COL.items).where('institution_id', '==', institutionId).where('source', '==', 'official')))
    .filter((r) => !r.retired_at && r.rationale && 'collegeBoardId' in r.rationale));
}

/**
 * A question the College Board's bank holds is served as the bank's, so the
 * copy another collection serves is retired: a practice test printed it, or
 * the academy's own pool (ClassMarker) had it before the bank published it.
 * A student then never meets one question twice, and meets it with the
 * bank's own explanation, difficulty and date. Their variants go with the
 * next `vary-bank.js --replace`.
 */
async function retireCopies(institutionId) {
  const bank = await servedBank(institutionId);
  const others = (await queryRows(col(COL.items).where('institution_id', '==', institutionId)))
    .filter((r) => !r.retired_at && ['original', 'official'].includes(r.source) && !(r.rationale && 'collegeBoardId' in r.rationale));
  const copies = others.filter((r) => holds(bank, r));
  await writeAll(copies.map((r) => ['update', col(COL.items).doc(r.id), { retired_at: new Date(), ...touched() }]));
  const from = (r) => (r.rationale?.classmarker ? 'the ClassMarker pool' : r.rationale?.dsat ? 'the practice tests' : 'the original questions');
  const by = {};
  for (const r of copies) by[from(r)] = (by[from(r)] || 0) + 1;
  console.log(`\nretired ${copies.length} served copies of the bank's questions${copies.length
    ? ` (${Object.entries(by).map(([k, v]) => `${v} from ${k}`).join(', ')})` : ''}`);
}

/** The practice tests that are the College Board's own, judged against the bank beside them in the dataset. */
function ownPracticeTests(tests) {
  const bankFile = path.join(datasetDir, 'cb.jsonl');
  if (!fs.existsSync(bankFile)) {
    console.warn(`No ${bankFile} to judge the practice tests by: each is rated as a third party's.`);
    return new Set();
  }
  return collegeBoardTests(tests, readJsonl(bankFile).map(repairItemText));
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
  const ownTests = collection === 'dsat' ? ownPracticeTests(questions) : new Set();
  const rows = [];
  const skipped = {};
  for (const q of questions) {
    const { row, skip } = toRow(q, ownTests);
    if (skip) { skipped[skip] = (skipped[skip] || 0) + 1; continue; }
    rows.push(row);
  }
  const count = (pred) => rows.filter(pred).length;
  const years = {};
  for (const r of rows) years[r.published_on?.slice(0, 4) || 'undated'] = (years[r.published_on?.slice(0, 4) || 'undated'] || 0) + 1;
  console.log(`${questions.length} questions in ${file}`);
  if (collection === 'dsat') console.log(`  the College Board's own tests: ${[...ownTests].sort((a, b) => a - b).join(', ') || 'none'}`);
  console.log(`  importable   ${rows.length}  (rw ${count((r) => r.section === 'rw')}, math ${count((r) => r.section === 'math')})`);
  if (collection !== 'original') console.log(`  realism      ${count((r) => r.realism === 5)} at 5 (the College Board's own), ${count((r) => r.realism === 4)} at 4`);
  console.log(`  published    ${Object.entries(years).sort().map(([y, k]) => `${y}: ${k}`).join(', ')}`);
  console.log(`  with figure  ${count((r) => r.png)}`);
  console.log(`  grid-in      ${count((r) => r.answer_type === 'grid-in')}`);
  for (const [why, n] of Object.entries(skipped)) console.log(`  skipped      ${n}  (${why})`);
  if (dryRun) { console.log('\n--dry-run: nothing written.'); return; }

  const target = await targetInstitution();
  console.log(`\nwriting to ${writingTo()}`);
  // A practice-test question the bank holds is served as the bank's (import cb first).
  let held = new Set();
  if (official && collection === 'dsat') {
    const bank = await servedBank(target.id);
    held = new Set(rows.filter((r) => holds(bank, r)).map(originOf));
    console.log(`  ${held.size} practice-test questions are the bank's, served as the bank's`);
  }
  if (replace && servable) {
    await syncServed(target.id, rows, held);
  } else if (replace) {
    // Reference rows are never served, so no session or exam points at them;
    // their figure assets, and their place in the bank, go with them.
    const marker = collection === 'cb' ? 'collegeBoardId' : 'dsat';
    const gone = (await queryRows(col(COL.items)
      .where('institution_id', '==', target.id).where('source', '==', 'reference')
      .select('content_hash', 'asset_id', 'rationale')))
      .filter((item) => item.rationale && marker in item.rationale);
    await writeAll(gone.flatMap((item) => [
      ['delete', col(COL.items).doc(item.id)],
      ...(item.content_hash ? [['delete', hashRef(target.id, item.content_hash)]] : []),
    ]));
    for (const id of gone.map((r) => r.asset_id).filter(Boolean)) {
      await bucket().file(`assets/${id}`).delete({ ignoreNotFound: true });
    }
    console.log(`\ncleared ${gone.length} earlier ${collection} reference items`);
  }
  // The College Board bank is a faithful copy: distinct questions that share a
  // passage are all kept, so the near-duplicate gate is off for it. Practice
  // tests go through the gate, so a question the bank already holds (official
  // tests reuse bank items) stays as the bank's version with its official
  // labels. Originals go through it too: a servable bank should stay varied.
  const result = await importRows(rows.filter((r) => !held.has(originOf(r))), target.id, { nearDuplicates: collection === 'cb' ? 'allow' : 'reject' });
  console.log(`\nimported into ${target.label} as ${official ? 'servable official questions' : servable ? 'servable questions' : 'reference material'}:`);
  console.log(`  added           ${result.added}`);
  console.log(`  duplicate       ${result.duplicates}`);
  console.log(`  near-duplicate  ${result.nearDuplicates}`);
  console.log(`  skipped         ${result.skipped}`);
  if (official && collection === 'cb') await retireCopies(target.id);
}

main()
  .catch((err) => { console.error(`\nFailed: ${err.message}`); process.exitCode = 1; });
