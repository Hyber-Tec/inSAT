// Write a variant back out as question text.
//
// The source's prose is kept word for word; every math span is typeset again
// from its tree as LaTeX, so a variant of a question written in ClassMarker's
// notation ("^{1}/_{34}") or plain text ("3x + 5 = 20") reads like the SAT.
// Variables named in the prose ("what is the value of x?") are set as math
// too, but never the article "a".

import * as R from './rational.js';
import { toTex, walk, numTex } from './expr.js';
import { fill } from './text.js';

/** Every symbol and function name used in the model's math. */
function mathLetters(model, trees) {
  const out = new Set(model.functions);
  for (const t of trees) for (const [n] of walk(t)) if (n.k === 'sym') out.add(n.name);
  if (model.ask.targetSym) out.add(model.ask.targetSym);
  return out;
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
const toName = (letter) => letter.replace(/ƒ/g, 'f').replace(/[₀-₉]+/, (d) => `_${[...d].map((c) => SUBSCRIPT.indexOf(c)).join('')}`);
const nameTex = (name) => (name.includes('_') ? name.replace(/_(\w+)/, '_{$1}') : name);

/** Set the prose's lone variables as math: "value of x?" -> "value of \(x\)?". */
function markLetters(prose, letters) {
  return prose.replace(/(?<![A-Za-z\\{_'’\-‐])([A-Za-zƒ])([₀-₉]+)?(?![A-Za-z'’\-‐(])/g, (all, ch, sub, at, whole) => {
    const name = toName(ch + (sub || ''));
    if (!letters.has(name)) return all;
    const after = whole.slice(at + all.length);
    if (ch === 'a' || ch === 'A' || ch === 'I') {
      // An article is followed by a word: "a constant", "A certain". A variable
      // is followed by punctuation, an operator, or "is"/"and"/"are"/"in".
      const next = after.match(/^\s*([A-Za-z]+)/);
      if (next && !['is', 'and', 'are', 'in', 'when', 'if', 'where', 'be', 'to', 'or', 'for'].includes(next[1])) return all;
    }
    return `\\(${nameTex(name)}\\)`;
  });
}

/** The question text for a model with these trees. */
export function renderQuestion(model, trees) {
  const letters = mathLetters(model, trees);
  // Letters are marked in the prose only (placeholders hold the math).
  const prose = markLetters(model.seg.skeleton, letters);
  return fill(prose, (i) => {
    const sp = model.seg.spans[i];
    const tex = toTex(trees[i]);
    return sp.display ? `\\[${tex}\\]` : `\\(${tex}\\)`;
  }).replace(/[ \t]+\n/g, '\n');
}

/** A number as an answer choice. */
export function numberChoice(q, { dollars = false } = {}) {
  if (dollars && R.sign(q) >= 0) {
    const places = R.decimalPlaces(q);
    return `$${places === null ? numTex(q) : R.toFixed(q, places && places < 2 ? 2 : places)}`;
  }
  return `\\(${numTex(q, { commas: R.isInt(q) && R.cmp(R.abs(q), R.Q(1000)) >= 0 })}\\)`;
}

/** An expression or relation as an answer choice. */
export const mathChoice = (tree) => `\\(${toTex(tree)}\\)`;

/**
 * What a student types for a grid-in answer, and every entry the SAT
 * accepts: the fraction, or a decimal that fills the grid (rounded or
 * truncated). Five characters for a positive answer, six for a negative.
 */
export function gridAnswer(q) {
  const plain = R.toPlain(q);
  const width = R.sign(q) < 0 ? 6 : 5;
  const accepted = [];
  if (plain.length <= width) accepted.push(plain);
  const exact = R.toDecimal(q);
  if (exact !== null) {
    const short = exact.replace(/^(-?)0\./, '$1.');
    for (const e of [exact, short]) if (e.length <= width && !accepted.includes(e)) accepted.push(e);
  } else {
    for (let places = 1; places <= 4; places += 1) {
      for (const mode of ['round', 'trunc']) {
        for (const e of [R.approx(q, places, mode), R.approx(q, places, mode).replace(/^(-?)0\./, '$1.')]) {
          // Only entries that fill the grid: fewer digits than fit would be a rounding the SAT rejects.
          const fills = e.length === width || (e.length < width && places === 4);
          if (fills && e.length <= width && !accepted.includes(e)) accepted.push(e);
        }
      }
    }
  }
  if (!accepted.length) return null; // does not fit the grid in any form
  return { text: accepted[0], accepted };
}
