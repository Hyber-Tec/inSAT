// Persist questions into pa_items rows with dedup. The bank is the source of
// truth; only 4-option multiple-choice or grid-in items are kept. Rows arrive
// already normalized (from generation, upload extraction, or manual entry).

import crypto from 'node:crypto';
import { query } from './db.js';
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
export async function insertItem(row, institutionId, { nearDuplicates = 'reject' } = {}) {
  const existing = await query(
    'SELECT id FROM pa_items WHERE institution_id = $1 AND content_hash = $2',
    [institutionId, row.content_hash],
  );
  if (existing.rows.length) return 'duplicate';

  // Compared only against the same section + domain: that is where a repeat
  // would actually land, and it keeps the scan small as a bank grows.
  // A fingerprint within the threshold is confirmed by word overlap, so two
  // passages that only share an opening formula are not called the same.
  const fingerprint = simhash(row);
  if (fingerprint && nearDuplicates !== 'allow') {
    const { rows: near } = await query(
      `SELECT simhash, passage, question, choices FROM pa_items
        WHERE institution_id = $1 AND section = $2 AND domain = $3
          AND simhash IS NOT NULL AND retired_at IS NULL`,
      [institutionId, row.section, row.domain],
    );
    const limit = bitsFor(row.section);
    const repeat = near.some((r) => hamming(fingerprint, r.simhash) <= limit
      && wordOverlap(row, r) >= NEAR_DUPLICATE_OVERLAP);
    if (repeat) return 'near-duplicate';
  }

  // A figure is stored as an asset the exam UI shows through the normal <img>
  // path: a rendered figure as SVG, a figure cropped from a source page as PNG,
  // or an imported image as it came ({ mime, bytes }).
  let assetId = null;
  const image = row.image
    || (row.png ? { mime: 'image/png', bytes: row.png } : null)
    || (row.svg ? { mime: 'image/svg+xml', bytes: Buffer.from(String(row.svg), 'utf8') } : null);
  if (image) {
    const a = await query('INSERT INTO pa_assets (mime, bytes) VALUES ($1, $2) RETURNING id', [image.mime, image.bytes]);
    assetId = a.rows[0].id;
  }

  await query(
    `INSERT INTO pa_items
       (institution_id, content_hash, section, domain, skill, difficulty, passage, question, choices,
        correct_idx, answer_type, rationale, figure, asset_id, source, verified, answer_text, simhash, accepted, realism, variant_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19::jsonb,$20,$21)
     ON CONFLICT (institution_id, content_hash) DO NOTHING`,
    [
      institutionId, row.content_hash, row.section, row.domain, row.skill, row.difficulty,
      row.passage, row.question, JSON.stringify(row.choices), row.correct_idx,
      row.answer_type, JSON.stringify(row.rationale),
      row.figure ? JSON.stringify(row.figure) : null, assetId, row.source, row.verified,
      row.answer_text || null, fingerprint,
      Array.isArray(row.accepted) && row.accepted.length ? JSON.stringify(row.accepted) : null,
      row.realism ?? null, row.variant_of ?? null,
    ],
  );
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

/** Normalize a hand-written question (client shape) into a pa_items row: four
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

/** Shape a pa_items row for the admin bank list. */
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
 * Edit a bank item in place (institution-scoped). Updates the stored JSON for
 * that question and recomputes its content hash. Returns the updated bank-item
 * shape, or null if not found. `d` carries the edited fields from the admin.
 */
export async function updateBankItem(id, institutionId, d) {
  const found = await query('SELECT section FROM pa_items WHERE id = $1 AND institution_id = $2', [id, institutionId]);
  if (!found.rows[0]) return null;
  const section = found.rows[0].section;

  const answerType = d.answerType === 'grid-in' ? 'grid-in' : 'multiple-choice';
  const question = String(d.question || '').trim();
  const passage = section === 'rw' && d.passage ? String(d.passage).trim() : null;
  const choices = answerType === 'grid-in' ? [] : (d.choices || []).map((c) => String(c ?? '').trim()).slice(0, 4);
  const correctIdx = answerType === 'grid-in' ? 0 : Math.max(0, Math.min(3, Number(d.correctIdx) || 0));
  const answerText = answerType === 'grid-in' ? String(d.answerText ?? '').trim() : null;
  const rationale = d.rationale && typeof d.rationale === 'object' ? d.rationale : { correct: String(d.rationale || '') };
  const difficulty = ['easy', 'medium', 'hard'].includes(d.difficulty) ? d.difficulty : null;
  const hash = contentHash({ section, question, choices, passage });

  // An edited grid-in answer invalidates the source's list of accepted forms;
  // scoring then falls back to numeric equivalence with the new answer.
  const { rows } = await query(
    `UPDATE pa_items
        SET question = $1, passage = $2, choices = $3::jsonb, correct_idx = $4,
            answer_type = $5, answer_text = $6, rationale = $7::jsonb,
            difficulty = COALESCE($8, difficulty), content_hash = $9,
            accepted = CASE WHEN answer_text IS NOT DISTINCT FROM $6 AND answer_type = $5
                            THEN accepted ELSE NULL END
      WHERE id = $10 AND institution_id = $11
      RETURNING *`,
    [question, passage, JSON.stringify(choices), correctIdx, answerType, answerText,
      JSON.stringify(rationale), difficulty, hash, id, institutionId],
  );
  return rows[0] ? rowToBankItem(rows[0]) : null;
}
