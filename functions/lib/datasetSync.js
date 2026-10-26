// Keeping a bank's served questions in line with the dataset they came from
// (scripts/import-dataset.js): which questions change, which move to a new
// identity, which retire, and which questions a bank already holds. Pure
// functions over rows, so they are tested without a database
// (tests/official.test.js).

import { simhash, hamming, bitsFor, wordOverlap, NEAR_DUPLICATE_OVERLAP } from './similarity.js';

// What a sync brings in line with the dataset: a question's labels, rating,
// date and answer, and what a student reads of it.
export const SYNCED = ['domain', 'skill', 'difficulty', 'realism', 'published_on', 'answer_type', 'correct_idx', 'answer_text',
  'accepted', 'figure', 'passage', 'question', 'choices', 'rationale'];

/** A value as text with its object keys in order, to compare stored and dataset rows. */
export const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
  : x));

/**
 * What bringing a bank's served questions (`have`) in line with the dataset
 * (`rows`) takes. A question is matched by where it came from (`originOf`, null
 * for a row of another collection), so one the dataset now words, rates,
 * dates, keys or draws differently is changed in place and keeps its id: a
 * served row may be in a student's history by id, and the questions a student
 * has met are never served again by id. Its identity in the bank (the content
 * hash) moves with it, unless another question already holds the new one
 * (`holderOf(hash)`: that question's id, or null): then it has become a repeat
 * of that one and is retired. A question the dataset no longer carries, or
 * whose origin `held` names (the bank serves it as another collection's), is
 * retired rather than deleted, and one it carries again is restored.
 *
 * Returns { updates: [{ item, changes }], moves: [{ item, row, changes, fresh }],
 * counts }; `fresh` when no lock holds the new content hash yet.
 */
export function planSync({ have, rows, originOf, held = new Set(), holderOf = () => null }) {
  const wanted = new Map();
  for (const r of rows) {
    const origin = originOf(r);
    if (origin !== null && !held.has(origin) && !wanted.has(origin)) wanted.set(origin, r);
  }
  const counts = { retired: 0, restored: 0, changed: 0, moved: 0, repeats: 0 };
  const updates = [];
  const moves = [];
  for (const item of have) {
    const origin = originOf(item);
    if (origin === null) continue;
    let row = wanted.get(origin) ?? null;
    let moving = false;
    if (row && row.content_hash !== item.content_hash) {
      const holder = holderOf(row.content_hash);
      if (holder && holder !== item.id) {
        counts.repeats += 1;
        row = null;
      } else {
        moving = true;
      }
    }
    const changes = {};
    if (row && item.retired_at) {
      counts.restored += 1;
      changes.retired_at = null;
    } else if (!row && !item.retired_at) {
      counts.retired += 1;
      changes.retired_at = new Date();
    }
    if (row) {
      for (const f of SYNCED) if (f in row && stable(item[f] ?? null) !== stable(row[f] ?? null)) changes[f] = row[f] ?? null;
      if (Object.keys(changes).some((f) => f !== 'retired_at')) counts.changed += 1;
    }
    if (moving) {
      counts.moved += 1;
      moves.push({ item, row, changes, fresh: !holderOf(row.content_hash) });
    } else if (Object.keys(changes).length) {
      updates.push({ item, changes });
    }
  }
  return { updates, moves, counts };
}

/** Rows by section and domain, the cells `holds` compares within. */
export function byCell(rows) {
  const cells = new Map();
  for (const r of rows) {
    const key = `${r.section}|${r.domain}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(r);
  }
  return cells;
}

const pictured = (r) => Boolean(r.png || r.asset_id || r.figure);
const keyOf = (r) => (r.answer_type === 'grid-in' ? `=${r.answer_text}` : String(r.choices?.[r.correct_idx] ?? '').replace(/\s+/g, ' ').trim());

/**
 * Whether `bank` (rows by cell, `byCell`) holds the question `row`: the same
 * question, or the same words nearly (the near-duplicate gate's measure).
 * Words alone cannot tell two figures apart (the same stem asked of two
 * graphs), so where either has a figure the answer must agree too.
 */
export function holds(bank, row) {
  const cell = bank.get(`${row.section}|${row.domain}`) || [];
  const fingerprint = row.simhash ?? simhash(row);
  const limit = bitsFor(row.section);
  return cell.some((b) => b.content_hash === row.content_hash
    || (fingerprint && b.simhash && hamming(fingerprint, b.simhash) <= limit && wordOverlap(row, b) >= NEAR_DUPLICATE_OVERLAP
      && (!(pictured(row) || pictured(b)) || keyOf(row) === keyOf(b))));
}
