// What makes a generated item well formed, whatever produced it (a math
// template, the variation engine). Each check returns a message naming the
// problem, or nothing; an item with any problem is never imported.

import { repairText } from './textRepair.js';

export const LETTERS = ['A', 'B', 'C', 'D'];
const LEAKS = ['undefined', 'NaN', 'Infinity', '[object'];
// A choice named by its letter: "choice A", "Option (B)", "answer is D", "(C)",
// "the calculation, which gives C." Choices are shuffled per student, so a
// letter would point at the wrong one.
const LETTER_REF = /\b(?:[Cc]hoice|[Oo]ption|[Aa]nswer|[Ll]etter)s?(?:\s+(?:is|was))?\s*(?:\\\(|\()?\s*[A-D]\b|\([A-D]\)|\bgives\s+\(?[A-D]\)?(?=[.,;]|$)/;
export const MATH_SPAN = /\\\(([\s\S]*?)\\\)/g;

/** `\(` and `\)` strictly alternate, opening first, and the last span is closed. */
export function delimitersBalanced(s) {
  let open = false;
  for (const [d] of String(s).matchAll(/\\[()]/g)) {
    if ((d === '\\(') === open) return false;
    open = !open;
  }
  return !open;
}

/** What is wrong with one explanation string, or null when it is fine. */
export function explanationProblem(text) {
  if (typeof text !== 'string' || !text.trim()) return 'empty';
  const leak = LEAKS.find((bad) => text.includes(bad));
  if (leak) return `"${leak}" leaked in`;
  if (!delimitersBalanced(text)) return 'unbalanced LaTeX delimiters';
  const ref = text.match(LETTER_REF);
  if (ref) return `names a choice by its letter ("${ref[0]}")`;
  if (text.includes('—')) return 'contains an em dash';
  // Outside \( \) the client renders prose, so stray LaTeX shows up raw.
  if (/[\\^_]/.test(text.replace(MATH_SPAN, ' '))) return 'LaTeX outside \\( \\) delimiters';
  // Inside, % starts a TeX comment and $ is not math at all.
  for (const [, tex] of text.matchAll(MATH_SPAN)) {
    if (/(?:^|[^\\])[%$]/.test(tex)) return `unescaped % or $ in \\(${tex}\\)`;
  }
  return null;
}

/**
 * The rationale explains every wrong choice under its letter and nothing else:
 * no explanation under the correct choice's letter, none at all on a grid-in.
 */
export function explanationProblems(item) {
  const out = [];
  const rat = item.rationale || {};
  const extra = Object.keys(rat).filter((key) => key !== 'correct' && !LETTERS.includes(key));
  if (extra.length) out.push(`unexpected rationale keys: ${extra.join(', ')}`);
  if (item.answerType === 'grid-in') {
    const lettered = LETTERS.filter((l) => l in rat);
    if (lettered.length) out.push(`grid-in item explains choices ${lettered.join(', ')}`);
  } else {
    for (const [i, letter] of LETTERS.entries()) {
      if (i === item.correctIdx) {
        if (letter in rat) out.push(`the correct choice ${letter} carries a why-wrong explanation`);
      } else if (typeof rat[letter] !== 'string' || !rat[letter].trim()) {
        out.push(`wrong choice ${letter} (${item.choices[i]}) has no explanation`);
      } else if (!/^This\b/.test(rat[letter])) {
        // "This divides ...", "This is the area ...": the student reads it
        // right under the choice they picked, so it opens on that choice.
        out.push(`the explanation of wrong choice ${letter} does not open with "This"`);
      }
    }
  }
  for (const [key, text] of Object.entries(rat)) {
    const problem = explanationProblem(text);
    if (problem) out.push(`rationale.${key}: ${problem}`);
  }
  return out;
}

/**
 * Structural problems of an item in the engine shape
 * { question, choices, correctIdx, answerType, answerText, rationale }.
 * `numericGrid` requires a grid-in answer that is a plain number.
 */
export function itemProblems(item, { numericGrid = true } = {}) {
  const q = item.question;
  if (!q || typeof q !== 'string') return ['empty question'];
  // Damaged text (lib/textRepair.js), say a source's escaped "\n" copied
  // into a variant, shows up raw in the app.
  const texts = [q, ...(item.choices || []), ...Object.values(item.rationale || {})];
  if (texts.some((t) => typeof t === 'string' && repairText(t) !== t)) return ['damaged text: a lost backslash, an escaped line break or bare-parenthesis math'];
  for (const bad of LEAKS) {
    if (q.includes(bad) || JSON.stringify(item.choices).includes(bad)) return [`"${bad}" leaked into the item`];
  }
  const opens = (q.match(/\\\(/g) || []).length;
  const closes = (q.match(/\\\)/g) || []).length;
  if (!delimitersBalanced(q)) return [`unbalanced LaTeX delimiters (${opens} open, ${closes} close)`];
  // Zero open and zero close counts as "balanced", which is exactly what a
  // template looks like when a template literal ate its backslashes. Anything
  // carrying math notation therefore has to be delimited.
  if (opens === 0 && /\^|frac\{|sqrt\{/.test(q)) return ['math notation is not wrapped in LaTeX delimiters (lost backslashes?)'];
  const shown = [q, ...(item.choices || [])].join('\n');
  if (shown.includes('—')) return ['the stem or a choice contains an em dash'];
  // "x + 0", "- 0", "0x": a degenerate draw that should have been re-rolled.
  for (const [, tex] of shown.matchAll(MATH_SPAN)) {
    if (/[+-] 0(?![\d.])|(?:^|[^\d.])0[a-z]/.test(tex)) return [`zero term in \\(${tex}\\)`];
  }
  if (!item.rationale?.correct) return ['missing rationale'];

  if (item.answerType === 'grid-in') {
    if (!item.answerText || (numericGrid && !Number.isFinite(Number(item.answerText)) && !/^-?\d+\/\d+$/.test(item.answerText))) {
      return [`grid-in answer is not numeric: ${item.answerText}`];
    }
    return explanationProblems(item);
  }
  const c = item.choices;
  if (!Array.isArray(c) || c.length !== 4) return [`expected 4 choices, got ${c?.length}`];
  if (c.some((x) => !x || !String(x).trim())) return ['blank choice'];
  if (new Set(c.map(String)).size !== 4) return ['duplicate choices'];
  if (c.some((x) => !delimitersBalanced(String(x)))) return ['unbalanced LaTeX delimiters in a choice'];
  if (!(item.correctIdx >= 0 && item.correctIdx <= 3)) return [`correctIdx out of range: ${item.correctIdx}`];
  return explanationProblems(item);
}
