// Near-duplicate detection for the question bank.
//
// content_hash catches byte-identical items. It does not catch the thing a
// model actually does: emit the same question with two words changed, a
// different name, or the numbers permuted. Those pass the hash check and
// quietly fill the bank with one question wearing twenty hats.
//
// SimHash over word shingles gives a 64-bit fingerprint where similar text
// lands at a small Hamming distance, so a candidate can be compared against the
// existing bank with integer math and no extra service.

const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;

function fnv1a64(text) {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** Words, lowercased, stripped of punctuation and LaTeX delimiters. */
function words(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\\[()[\]]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 64-bit SimHash of an item's text, as 16 hex characters.
 *
 * Numbers are kept as themselves on purpose. Folding them to a placeholder
 * would make every instance of one math template look like a duplicate of its
 * siblings, and that variety is the whole point of the templates. What this
 * must catch is the same wording with the values left alone, which is the
 * shape a model repeats.
 */
export function simhash({ passage, question, choices }) {
  // Fingerprint whichever part actually carries the item's identity.
  //
  // For Reading & Writing that is the PASSAGE: the stems are drawn from a small
  // set of standard phrasings ("which choice best states the main idea"), so
  // hashing the whole item buries the signal -- measured, a rephrasing of one
  // passage sat at 15 bits while a completely different passage sat at 21,
  // which is far too narrow to threshold. The passage alone separates them
  // cleanly. For math there is no passage, so the stem and options are the
  // identity.
  const text = passage && passage.trim()
    ? passage
    : [question || '', ...(choices || [])].join(' ');
  const toks = words(text);
  if (!toks.length) return null;

  // 3-word shingles keep local word order, which single words throw away.
  const shingles = toks.length < 3
    ? [toks.join(' ')]
    : toks.slice(0, -2).map((_, i) => toks.slice(i, i + 3).join(' '));

  const bits = new Array(64).fill(0);
  for (const s of shingles) {
    const h = fnv1a64(s);
    for (let b = 0; b < 64; b += 1) {
      bits[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
    }
  }

  let out = 0n;
  for (let b = 0; b < 64; b += 1) if (bits[b] > 0) out |= 1n << BigInt(b);
  return out.toString(16).padStart(16, '0');
}

/** The text a fingerprint is taken over: the passage, or the stem with its options. */
const identity = ({ passage, question, choices }) => (passage && passage.trim()
  ? passage
  : [question || '', ...(choices || [])].join(' '));

/**
 * How much of the two items' identity text they share, as the Jaccard overlap
 * of their word sets (0 to 1).
 *
 * A fingerprint match is confirmed with this before an item is called a
 * near-duplicate. Fingerprints of two different Reading and Writing passages
 * can still land within the threshold when both open with the same long
 * preamble ("While researching a topic, a student has taken the following
 * notes:"), and 25 distinct practice-test questions were dropped that way. A
 * rewording of one passage keeps most of its words; two passages that merely
 * share a preamble do not.
 */
export function wordOverlap(a, b) {
  const x = new Set(words(identity(a)));
  const y = new Set(words(identity(b)));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/** Below this overlap a fingerprint match is a coincidence, not a repeat. */
export const NEAR_DUPLICATE_OVERLAP = 0.5;

/** Number of differing bits between two hex fingerprints (0 = identical). */
export function hamming(a, b) {
  if (!a || !b) return 64;
  let x = (BigInt(`0x${a}`) ^ BigInt(`0x${b}`)) & MASK64;
  let n = 0;
  while (x) { x &= x - 1n; n += 1; }
  return n;
}

/**
 * Cut-offs in differing bits, per section. Both come from measurement, not
 * taste (see server/scripts/check-similarity.js):
 *
 *   rw   - passages are fingerprinted, so a reused passage lands at 0 bits and
 *          a lightly reworded one at ~13, while a genuinely different passage
 *          sits above 30. 16 catches the edit and stays well clear.
 *   math - stems are fingerprinted, and legitimate siblings from one template
 *          are meant to look alike. 8 keeps the false-flag rate at ~3%; past
 *          that it starts rejecting perfectly good variants.
 */
export const NEAR_DUPLICATE_BITS = { rw: 16, math: 8 };

export const bitsFor = (section) => NEAR_DUPLICATE_BITS[section] ?? NEAR_DUPLICATE_BITS.math;

/**
 * True when `candidate` is within `bits` of any fingerprint in `existing`.
 * `existing` is a plain array of hex strings, so the caller decides how wide
 * to scope the comparison (same section + domain is the useful scope).
 */
export function isNearDuplicate(candidate, existing, bits = NEAR_DUPLICATE_BITS.math) {
  if (!candidate) return false;
  return existing.some((h) => hamming(candidate, h) <= bits);
}
