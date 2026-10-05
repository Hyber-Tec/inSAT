// Read a question into a model the engine can solve and vary: the functions
// it defines, the relations it gives, the constants it declares, and what it
// asks. The model is only built when every piece of the question is accounted
// for; anything unrecognized is a reason to leave the question alone.

import * as R from './rational.js';
import { parse, walk, same, symbols, evalQ, ParseError } from './expr.js';
import { segment } from './text.js';

/** Why a question is left alone: a short category, with the specifics in `detail`. */
export class NotUnderstood extends Error {
  constructor(reason, detail = null) {
    super(reason);
    this.detail = detail;
  }
}
const refuse = (why, detail) => { throw new NotUnderstood(why, detail); };

/** Letters used as functions: "f(x) = ...", "the function g", "functions f and g". */
export function detectFunctions(text) {
  const s = String(text).replace(/ƒ/g, 'f');
  const out = new Set();
  for (const m of s.matchAll(/(?<![A-Za-z\\])([A-Za-z])\s*\(\s*[A-Za-z]\s*\)\s*=/g)) out.add(m[1]);
  for (const m of s.matchAll(/\bfunctions?\s+(?:\\\()?([A-Za-z])(?:\\\))?(?:\s*(?:,|and)\s*(?:\\\()?([A-Za-z])(?:\\\))?)?/g)) {
    out.add(m[1]);
    if (m[2]) out.add(m[2]);
  }
  // Letters that stand for a variable are never functions here.
  for (const bad of ['x', 'y', 'n', 't']) out.delete(bad);
  return out;
}

/** Declared constants: "where k is a constant", "a and b are constants", "for some constant c". */
export function declaredConstants(skeleton) {
  const s = skeleton.replace(/\s+/g, ' ');
  const out = new Map();
  const sign = (w) => (w === 'positive' ? 1 : w === 'negative' ? -1 : 0);
  for (const m of s.matchAll(/\b([a-zA-Z])(?:,\s*([a-zA-Z]))?(?:,?\s*and\s*([a-zA-Z]))? (?:is|are) (?:a |an |some )?(?:(positive|negative|nonzero|real) )?(?:integer )?constants?\b/g)) {
    for (const v of [m[1], m[2], m[3]]) if (v) out.set(v, sign(m[4]));
  }
  for (const m of s.matchAll(/\bfor some (?:(positive|negative) )?constant ([a-zA-Z])\b/g)) out.set(m[2], sign(m[1]));
  for (const m of s.matchAll(/\b(?:the )?constants? ([a-zA-Z])(?: and ([a-zA-Z]))?\b/g)) {
    out.set(m[1], out.get(m[1]) ?? 0);
    if (m[2]) out.set(m[2], out.get(m[2]) ?? 0);
  }
  return out;
}

// ------------------------------------------------------------------ choices

const NUMBER_TEXT = /^\s*(-|−)?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?\s*$/;

/**
 * One answer choice as the engine reads it:
 *   { kind: 'number', value }            "12", "\(-\frac{3}{4}\)", "−6", "^{5}/_{6}"
 *   { kind: 'expr', tree }               "3w^{2} + 11w − 70"
 *   { kind: 'rel', tree }                "x - 3 = -24", "y = 4x + 1"
 *   { kind: 'rels', trees }              "x = -7 and x = 1"
 *   { kind: 'tuple', tree }              "(10, 58)"
 *   { kind: 'text', text }               anything else
 */
export function readChoice(text, functions = new Set()) {
  const raw = String(text ?? '').trim();
  if (NUMBER_TEXT.test(raw) && /\d/.test(raw)) {
    const m = NUMBER_TEXT.exec(raw);
    const v = R.fromDecimal(`${m[1] ? '-' : ''}${(m[2] || '0').replace(/,/g, '')}${m[3] || ''}`);
    return { kind: 'number', value: v, dollars: raw.includes('$') };
  }
  const seg = segment(raw);
  const prose = seg.skeleton.replace(/⟦\d+⟧/g, '').replace(/\band\b|[\s,.;]/g, '');
  if (!seg.spans.length) return { kind: 'text', text: raw };
  let trees;
  try {
    trees = seg.spans.map((sp) => parse(sp.src, { functions }));
  } catch (err) {
    if (err instanceof ParseError) return { kind: 'text', text: raw, unreadable: true };
    throw err;
  }
  if (prose) return { kind: 'text', text: raw, trees };
  if (trees.length > 1) return trees.every((t) => t.k === 'rel') ? { kind: 'rels', trees } : { kind: 'text', text: raw };
  const [t] = trees;
  if (t.k === 'rel' || t.k === 'chain') return { kind: 'rel', tree: t };
  if (t.k === 'tuple') return { kind: 'tuple', tree: t };
  const value = constValue(t);
  if (value) return { kind: 'number', value, tree: t };
  return { kind: 'expr', tree: t };
}

/** The exact value of a tree with no symbols ("-\frac{3}{4}", "2^{3}"), or null. */
function constValue(t) {
  if (symbols(t).size) return null;
  for (const [n] of walk(t)) if (n.k === 'pi' || n.k === 'sqrt' || n.k === 'call') return null;
  try { return evalQ(t); } catch { return null; }
}

// --------------------------------------------------------------------- asks

// Each ask is matched against the last question sentence of the skeleton,
// lowercased, where ⟦i⟧ is a math span and a bare letter is a variable.
const S = '(⟦\\d+⟧|\\b[a-z](?:[₀-₉]+|_\\w+)?(?![a-z]))';
const ASKS = [
  ['sum', /\bsum of (?:all |the )?(?:possible )?(?:real |distinct )?(?:solutions|roots|values of [a-z] that satisfy)\b/],
  ['product', /\bproduct of (?:all |the )?(?:possible )?(?:real )?(?:solutions|roots)\b/],
  ['count', /\bhow many (?:distinct )?(?:real )?solutions\b|\bnumber of (?:distinct )?(?:real )?solutions\b/],
  ['positive', /\b(?:the |a )?positive (?:real )?solution\b/],
  ['negative', /\b(?:the |a )?negative (?:real )?solution\b/],
  ['greatest', /\b(?:greatest|largest|greater|larger) (?:possible )?(?:real )?(?:solution|root)\b/],
  ['least', /\b(?:least|smallest|lesser|smaller) (?:possible )?(?:real )?(?:solution|root)\b/],
  ['all', /\bwhat are (?:all )?(?:the )?solutions\b|\bwhich of the following are (?:all )?(?:the )?solutions\b|\bwhat (?:is|are) the solutions?\b.*\?$/],
  ['one', /\b(?:which of the following is|what is|which is) (?:a|one of the) solutions?\b|\bwhat value of [a-z] is a solution\b|\bwhat is one (?:possible )?solution\b/],
  ['sameSolution', /\bwhich (?:of the following )?equations? has the same solutions? as\b/],
  ['mustBeTrue', /\bwhich (?:equation|of the following|statement) must (?:also )?be true\b/],
  ['terms', new RegExp(`\\bwhich (?:equation|of the following|expression) (?:correctly )?(?:expresses|gives|represents) ${S} in terms? of\\b`)],
  ['equivalent', new RegExp(`\\b(?:which|what) (?:of the following )?(?:expressions? |equations? )?(?:is |are )?(?:equivalent|equal) to (?:the (?:given |following )?(?:expression|equation)?,? ?)?${S}(?:,|\\s|\\?|$)`)],
  ['equivalentAbove', /\bwhich (?:of the following )?(?:expressions? )?is equivalent to the (?:given )?expression\b|\bis equivalent to the expression above\b/],
  ['value', new RegExp(`\\bwhat is the (?:value|solution) of ${S}|\\bwhat is ${S}\\s*\\?|\\bwhat value of ${S} (?:satisfies|is the solution)|\\bfind (?:the value of )?${S}|\\bsolve for ${S}|\\bfor what value of ${S} (?:is|does)|\\bwhich (?:of the following )?(?:is the )?value of ${S}`)],
  ['solution', /\bwhat is the solution to (?:the (?:given )?equation|the equation (?:above|shown))|\bwhat is the solution\b|\bwhich of the following is the solution to the (?:given )?equation\b/],
];

function lastQuestion(skeleton) {
  const flat = skeleton.replace(/\s+/g, ' ').trim();
  const parts = flat.split(/(?<=[.?:!])\s+(?=[A-Z⟦])/);
  const q = [...parts].reverse().find((p) => /\?|\b(?:which|what|find|solve|how many)\b/i.test(p));
  return (q || parts[parts.length - 1] || '').toLowerCase();
}

export function findAsk(skeleton) {
  const q = lastQuestion(skeleton);
  for (const [kind, re] of ASKS) {
    const m = q.match(re);
    if (m) {
      const target = m.slice(1).find(Boolean) || null;
      return { kind, target, sentence: q };
    }
  }
  return null;
}

// ------------------------------------------------------------ understanding

/**
 * The model of a formal-math question, or NotUnderstood.
 * item: { question, choices, correctIdx, answerType, answerText, accepted }
 */
export function readQuestion(item) {
  const seg = segment(item.question);
  if (!seg.spans.length) refuse('no math');
  if (seg.numbers.length) refuse('numbers in the prose (a word problem)', seg.numbers.map((n) => n.text).slice(0, 3).join(', '));
  const functions = detectFunctions(item.question);
  const trees = seg.spans.map((sp) => {
    try { return parse(sp.src, { functions }); } catch (err) {
      if (err instanceof ParseError) refuse('math it cannot read unambiguously', `"${sp.src}": ${err.message}`);
      throw err;
    }
  });
  const ask = findAsk(seg.skeleton);
  if (!ask) refuse('a question the engine does not recognize', lastQuestion(seg.skeleton).slice(0, 120));

  // The target of a value/equivalence ask: a span or a bare letter.
  let targetSpan = null;
  let targetSym = null;
  if (ask.target) {
    const m = /^⟦(\d+)⟧$/.exec(ask.target);
    if (m) targetSpan = Number(m[1]);
    else targetSym = normalizeLetter(ask.target, item.question);
  }

  // A role for every span: a definition f(x) = body, a relation, a condition,
  // the target, or a mention that carries no information ("(x, y)", "x").
  const defined = new Set();
  const roles = trees.map((t, i) => {
    if (i === targetSpan) return 'target';
    if (t.k === 'rel' && t.op === '=' && t.l.k === 'call' && t.l.arg.k === 'sym' && functions.has(t.l.f)
      && !defined.has(t.l.f) && !symbols(t.r).has(t.l.f)) {
      defined.add(t.l.f);
      return 'def';
    }
    if (t.k === 'rel' && t.op === '=') return 'rel';
    if (t.k === 'rel' || t.k === 'chain') return 'cond';
    if (t.k === 'tuple' && t.items.every((e) => e.k === 'sym')) return 'mention';
    if (t.k === 'sym') return 'mention';
    return 'expr';
  });
  // "E1 is equivalent to E2, where r is a constant": an identity in the
  // other variables, which determines the constants.
  const flat = seg.skeleton.replace(/\s+/g, ' ');
  for (const m of flat.matchAll(/⟦(\d+)⟧,? (?:is|are) (?:equivalent|equal) to (?:the expression )?⟦(\d+)⟧|⟦(\d+)⟧,? can be (?:re)?written as ⟦(\d+)⟧/g)) {
    const [i, j] = (m[1] ? [m[1], m[2]] : [m[3], m[4]]).map(Number);
    if (roles[i] === 'expr' && roles[j] === 'expr') { roles[i] = 'idl'; roles[j] = 'idr'; }
  }
  // "Which expression is equivalent to the expression above?": the lone expression is the target.
  if ((ask.kind === 'equivalentAbove' || ask.kind === 'equivalent') && targetSpan === null) {
    const lone = roles.map((r, i) => (r === 'expr' ? i : -1)).filter((i) => i >= 0);
    if (lone.length !== 1) refuse('no single expression to be equivalent to');
    targetSpan = lone[0];
    roles[targetSpan] = 'target';
  }
  if (roles.includes('expr')) refuse('a math span that is neither a relation nor the target');

  const constants = declaredConstants(seg.skeleton);
  // "If the equation has infinitely many solutions / no solution, what is k?"
  const lowered = flat.toLowerCase();
  const special = /\binfinitely many (?:real )?solutions\b/.test(lowered) ? 'infinite'
    : /\bno (?:real )?solutions?\b/.test(lowered) ? 'none' : null;
  const choices = item.answerType === 'grid-in' ? [] : (item.choices || []).map((c) => readChoice(c, functions));
  return { seg, trees, roles, functions, constants, special, ask: { kind: ask.kind, targetSpan, targetSym, sentence: ask.sentence }, choices };
}

/** The letter a skeleton's lowercased target stands for, in the question's own case: "r₁" -> "R_1". */
function normalizeLetter(lower, question) {
  const plain = lower.replace(/[₀-₉]+/g, (d) => `_${[...d].map((ch) => '₀₁₂₃₄₅₆₇₈₉'.indexOf(ch)).join('')}`);
  const upper = plain.toUpperCase().replace(/^([A-Z])_/, '$1_');
  const letter = plain[0];
  const hasLower = new RegExp(`(?<![A-Za-z])${letter}(?![A-Za-z])`).test(question);
  const hasUpper = new RegExp(`(?<![A-Za-z])${letter.toUpperCase()}(?![A-Za-z])`).test(question);
  return hasUpper && !hasLower ? `${upper[0]}${plain.slice(1)}` : plain;
}

export { same };
