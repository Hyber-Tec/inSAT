// Persist questions into a bank (`items`) with dedup. The bank is the source of
// truth; only 4-option multiple-choice or grid-in items are kept. Rows arrive
// already normalized (from generation, upload extraction, or manual entry).
//
// A question's identity in a bank is its content hash: `itemHashes` holds one
// document per (institution, hash), created together with the item, so two
// writers racing with the same question cannot both add it.

import crypto from 'node:crypto';
import { db } from './firebase.js';
import { COL, col, docOf, getRow, newId, now } from './store.js';
import { saveAsset } from './assets.js';
import { bankRows, remember, touched } from './pool.js';
import { conflict } from './http.js';
import { simhash, hamming, bitsFor, wordOverlap, NEAR_DUPLICATE_OVERLAP } from './similarity.js';
import { canonicalSkill } from './taxonomy.js';

export function contentHash({ section, question, choices, passage }) {
  const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Passage is part of the identity: many Reading & Writing questions share an
  // identical stem + choices and differ only by passage, so without it distinct
  // questions collapse into one and get dropped as "duplicates".
  const basis = `${section}|${norm(passage)}|${norm(question)}|${(choices || []).map(norm).join('|')}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24);
}

/** The key of a question's identity in a bank. */
export const hashRef = (institutionId, hash) => col(COL.itemHashes).doc(`${institutionId}_${hash}`);

/** The item of a bank with this content hash, or null. */
export async function findByHash(institutionId, hash) {
  const lock = await hashRef(institutionId, hash).get();
  return lock.exists ? getRow(COL.items, lock.get('item_id')) : null;
}

/** A row is bankable if it's a complete 4-option MC or a grid-in with an answer. */
export function isBankable(row) {
  if (!row.section || !row.question) return false;
  if (row.answer_type === 'grid-in') return Boolean(row.answer_text);
  return Array.isArray(row.choices) && row.choices.length === 4 && row.choices.every(Boolean);
}

/**
 * Insert a normalized row into an institution's bank.
 * Returns 'added' | 'duplicate' (byte-identical) | 'near-duplicate' (the same
 * question reworded, or a Reading & Writing passage used again).
 *
 * `nearDuplicates: 'allow'` skips the near-duplicate gate. That gate keeps a
 * servable bank varied; reference material is a faithful copy of a source, in
 * which several distinct questions legitimately share one passage.
 */
export async function insertItem(row, institutionId, { nearDuplicates = 'reject', onAdded } = {}) {
  const lock = hashRef(institutionId, row.content_hash);
  if ((await lock.get()).exists) return 'duplicate';

  // Compared only against the same section + domain: that is where a repeat
  // would actually land, and it keeps the scan small as a bank grows.
  // A fingerprint within the threshold is confirmed by word overlap, so two
  // passages that only share an opening formula are not called the same.
  const fingerprint = simhash(row);
  if (fingerprint && nearDuplicates !== 'allow') {
    const limit = bitsFor(row.section);
    for (const r of (await bankRows(institutionId)).values()) {
      if (r.retired_at || !r.simhash || r.section !== row.section || r.domain !== row.domain) continue;
      if (hamming(fingerprint, r.simhash) <= limit && wordOverlap(row, r) >= NEAR_DUPLICATE_OVERLAP) return 'near-duplicate';
    }
  }

  // A figure is stored as an asset the exam UI shows through the normal <img>
  // path: a rendered figure as SVG, a figure cropped from a source page as PNG,
  // or an imported image as it came ({ mime, bytes }).
  const image = row.image
    || (row.png ? { mime: 'image/png', bytes: row.png } : null)
    || (row.svg ? { mime: 'image/svg+xml', bytes: Buffer.from(String(row.svg), 'utf8') } : null);
  const assetId = image ? await saveAsset(image) : null;

  const id = newId();
  const item = {
    institution_id: institutionId,
    content_hash: row.content_hash,
    section: row.section,
    domain: row.domain,
    skill: row.skill,
    difficulty: row.difficulty,
    passage: row.passage ?? null,
    question: row.question,
    choices: row.choices,
    correct_idx: row.correct_idx,
    answer_type: row.answer_type,
    rationale: row.rationale || {},
    figure: row.figure || null,
    asset_id: assetId,
    source: row.source,
    verified: Boolean(row.verified),
    created_at: now(),
    retired_at: null,
    answer_text: row.answer_text || null,
    simhash: fingerprint,
    accepted: Array.isArray(row.accepted) && row.accepted.length ? row.accepted : null,
    realism: row.realism ?? null,
    variant_of: row.variant_of ?? null,
  };
  const batch = db.batch();
  batch.create(lock, { item_id: id });
  batch.set(col(COL.items).doc(id), { ...docOf(COL.items, item), ...touched() });
  try {
    await batch.commit();
  } catch (err) {
    if (err.code === 6) return 'duplicate'; // another writer added it first
    throw err;
  }
  const added = { id, ...item, updated_at: null };
  remember(institutionId, [added]);
  onAdded?.(added);
  return 'added';
}

/** Import a batch of already-normalized rows into an institution's bank. Skips
 *  rows that aren't bankable; dedups by content hash. */
export async function importRows(rows, institutionId, options = {}) {
  let added = 0, duplicates = 0, nearDuplicates = 0, skipped = 0;
  for (const row of rows) {
    if (!isBankable(row)) { skipped++; continue; }
    const result = await insertItem(row, institutionId, options);
    if (result === 'added') added++;
    else if (result === 'near-duplicate') nearDuplicates++;
    else duplicates++;
  }
  // `duplicates` stays the byte-identical count so existing callers and their
  // wording are unaffected; near-duplicates are reported alongside it.
  return { added, duplicates, nearDuplicates, skipped };
}

/** Normalize a hand-written question (client shape) into an item row: four
 *  choices and the right one, or (Math) an answer to enter. Its explanation is
 *  `explanation`, or a whole `rationale`. */
export function manualRow(q) {
  const grid = q.answerType === 'grid-in';
  const passage = q.section === 'rw' ? (String(q.passage || '').trim() || null) : null;
  const question = String(q.question || '').trim();
  const choices = grid ? [] : (q.choices || []).map((c) => String(c ?? '').trim());
  return {
    content_hash: contentHash({ section: q.section, question, choices, passage }),
    section: q.section,
    domain: q.domain || '',
    skill: canonicalSkill(q.domain, q.skill) || q.skill || '',
    difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
    passage,
    question,
    choices,
    correct_idx: grid ? 0 : q.correctIdx ?? 0,
    answer_type: grid ? 'grid-in' : 'multiple-choice',
    answer_text: grid ? String(q.answerText || '').trim() : null,
    rationale: q.explanation ? { correct: String(q.explanation).trim() } : q.rationale || {},
    figure: null,
    image_ref: null,
    source: 'manual',
    verified: true,
  };
}

/** Manual item add from the admin editor (client question shape). */
export async function insertManualItem(q, institutionId) {
  return insertItem(manualRow(q), institutionId);
}

/** Shape an item row for the admin bank list. */
export function rowToBankItem(row) {
  return {
    id: row.id,
    section: row.section,
    domain: row.domain,
    skill: row.skill,
    difficulty: row.difficulty,
    passage: row.passage,
    question: row.question,
    choices: row.choices,
    correctIdx: row.correct_idx,
    answerType: row.answer_type,
    answerText: row.answer_text,
    accepted: row.accepted || [],
    rationale: row.rationale,
    hasFigure: Boolean(row.asset_id || row.figure),
    assetId: row.asset_id || null,
    source: row.source,
    verified: row.verified,
    createdAt: row.created_at,
  };
}

/**
 * Edit a bank item in place (institution-scoped). Updates the stored question
 * and recomputes its content hash. Returns the updated bank-item shape, or
 * null if not found. `d` carries the edited fields from the admin.
 */
export async function updateBankItem(id, institutionId, d) {
  const found = await getRow(COL.items, id);
  if (!found || found.institution_id !== institutionId) return null;
  const section = found.section;

  const answerType = d.answerType === 'grid-in' ? 'grid-in' : 'multiple-choice';
  const question = String(d.question || '').trim();
  const passage = section === 'rw' && d.passage ? String(d.passage).trim() : null;
  const choices = answerType === 'grid-in' ? [] : (d.choices || []).map((c) => String(c ?? '').trim()).slice(0, 4);
  const correctIdx = answerType === 'grid-in' ? 0 : Math.max(0, Math.min(3, Number(d.correctIdx) || 0));
  const answerText = answerType === 'grid-in' ? String(d.answerText ?? '').trim() : null;
  const rationale = d.rationale && typeof d.rationale === 'object' ? d.rationale : { correct: String(d.rationale || '') };
  const difficulty = ['easy', 'medium', 'hard'].includes(d.difficulty) ? d.difficulty : found.difficulty;
  const hash = contentHash({ section, question, choices, passage });

  // An edited grid-in answer invalidates the source's list of accepted forms;
  // scoring then falls back to numeric equivalence with the new answer.
  const keepAccepted = (found.answer_text ?? null) === answerText && found.answer_type === answerType;
  const changes = {
    question, passage, choices, correct_idx: correctIdx, answer_type: answerType, answer_text: answerText,
    rationale, difficulty, content_hash: hash, accepted: keepAccepted ? found.accepted ?? null : null,
  };
  await db.runTransaction(async (t) => {
    if (hash !== found.content_hash) {
      const next = hashRef(institutionId, hash);
      if ((await t.get(next)).exists) throw conflict('That question is already in the bank.');
      if (found.content_hash) t.delete(hashRef(institutionId, found.content_hash));
      t.create(next, { item_id: id });
    }
    t.update(col(COL.items).doc(id), { ...changes, ...touched() });
  });
  const updated = { ...found, ...changes };
  remember(institutionId, [updated]);
  return rowToBankItem(updated);
}
