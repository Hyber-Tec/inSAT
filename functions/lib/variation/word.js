// Word problems: the numbers a question states are its parameters, and every
// other number in it (the answer, each choice, the numbers in its own
// explanations) is bound to a formula of them.
//
// "A college bookstore makes a profit of $0.75 for every 12 pencils it sells.
// What is the profit for selling 20 pencils?" states 0.75, 12 and 20. The key,
// $1.25, is 20 * 0.75 / 12; the distractors are other formulas of the same
// numbers (0.75 * 12 / 20, 20 * 0.75). A variant draws new numbers, evaluates
// every formula again, and writes the question, the choices and the source's
// explanations with the new values.
//
// A question is used only when the reading is unambiguous:
//   - the key's smallest formula is one formula (formula.js), and it uses every
//     number the question states (a number the answer ignores means the
//     engine has misread something);
//   - every number in every wrong choice binds the same way, so the variant's
//     distractors are the same mistakes with new numbers;
//   - facts that must not change stay fixed: conversions ("1 mile = 1.6
//     kilometers"), years, times of day, labels ("Test 2"), number words.
//
// The check of a finished variant (verifyWord) reads the rendered text
// again, re-extracts its numbers, evaluates every bound formula in floating
// point, and binds the key a second time on the new numbers: the variant must
// still read one way only.

import katex from 'katex';
import * as R from './rational.js';
import { enumerate, bindValue, evalExact, evalFloat, atomsOf, formulaTex, equivalent, sizeOf } from './formula.js';

/** The values of every proper step of a formula: 22 in (47 - 25) / 2. */
function subValues(f, qs, top = true) {
  if ('atom' in f) return [];
  const out = [...subValues(f.a, qs, false), ...subValues(f.b, qs, false)];
  if (!top) { try { out.push(evalExact(f, qs)); } catch { /* division by zero */ } }
  return out;
}
import { draw } from './vary.js';
import { segment } from './text.js';
import { gridAnswer } from './render.js';
import { itemProblems, MATH_SPAN } from '../itemChecks.js';

export class NotWord extends Error {
  constructor(reason, detail = null) { super(reason); this.detail = detail; }
}
const refuse = (why, detail) => { throw new NotWord(why, detail); };

// ------------------------------------------------------------------ numbers

// A number as written in prose or in simple LaTeX: $1,200.50, \$20, 70%, 70\%,
// 1{,}200, 15 percent.
const NUMBER = /(\\?\$\s?)?(\d{1,3}(?:(?:,|\{,\})\d{3})+(?![\d,])|\d+)(\.\d+)?(\s?\\?%|\s?percent\b)?/g;

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twice: 2, double: 2, triple: 3, half: 2, dozen: 12, quarter: 4 };
const LABEL = /(?:Test|test|Figure|figure|Set|set|Table|table|Question|question|Model|model|Plan|plan|Phase|phase|Group|group|Rectangle|Triangle|Circle|Store|store|Company|company|School|school|Day|day|Week|week|Round|round|Level|level|Grade|grade|Class|class|Room|room|Section|section|Box|box|Line|line|Machine|machine|Trial|trial|Month|month|Year|year|Station|station|Route|route|Sample|sample|Experiment|experiment|Car|car|Team|team|Player|player)\s$/;

function spansOf(text) {
  const spans = [];
  for (const m of String(text).matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/**
 * Every number in a text, with how it is written and whether it may vary.
 * Returns [{ start, end, value, text, fixed, why, format }].
 */
export function numbersIn(text, { question = true } = {}) {
  const s = String(text ?? '');
  const math = spansOf(s);
  const inMath = (i) => math.some(([a, b]) => i >= a && i < b);
  // Formulas the question states, delimited or bare ("f(x) = 180(x - 2)"):
  // their numbers may be laws, not quantities, so they never vary.
  const formulas = question ? formulaSpans(s) : [];
  const out = [];
  // Conversion facts: "1 mile = 1.6 kilometers", "(Use 1 foot = 12 inches.)".
  const facts = [];
  for (const m of s.matchAll(/\b1\s+[A-Za-z][A-Za-z ]{0,20}?\s*(?:=|is equal to|equals)\s*\\?\$?\s?[\d,.{}]+/g)) facts.push([m.index, m.index + m[0].length]);
  for (const m of s.matchAll(/\((?:Use|use|Note:?)[^)]*\)/g)) facts.push([m.index, m.index + m[0].length]);
  NUMBER.lastIndex = 0;
  let m;
  while ((m = NUMBER.exec(s))) {
    const start = m.index;
    const end = start + m[0].length;
    const before = s.slice(Math.max(0, start - 24), start);
    const after = s.slice(end, end + 12);
    const digits = m[2].replace(/\{,\}|,/g, '');
    const text = m[0];
    // Part of a name or a power: x2, R1, h^{2}, 3rd, 2nd.
    if (/[A-Za-z_]$/.test(before) && !/\$$/.test(before)) continue;
    if (/^(?:st|nd|rd|th)\b/.test(after)) continue;
    // A power in the question (x^{2}) is structure; in a choice the
    // exponent may carry a stated number ("(4.10)^{6w}"), and is bound.
    if ((/\^\{?\s*$/.test(before) && (question || Number(m[2]) <= 3)) || /[_]\{?\s*$/.test(before)) continue;
    const value = R.fromDecimal(`${digits}${m[3] || ''}`);
    let fixed = false;
    let why = null;
    if (facts.some(([a, b]) => start >= a && start < b) || isConversion(value, sentenceAt(s, start))) { fixed = true; why = 'a stated conversion'; }
    else if (!m[1] && !m[3] && !m[4] && /^\d{4}$/.test(m[2]) && Number(digits) >= 1800 && Number(digits) <= 2100) { fixed = true; why = 'a year'; }
    else if (/^\s?(?:a\.m\.|p\.m\.|AM|PM|am|pm)\b|^:\d\d/.test(after) || /\d:$/.test(before)) { fixed = true; why = 'a time of day'; }
    else if (LABEL.test(before)) { fixed = true; why = 'a label'; }
    else if (formulas.some(([a, b]) => start >= a && start < b)) { fixed = true; why = 'part of a stated formula'; }
    else if (/\\frac\{[^}]*$|\\frac\{[^}]*\}\{[^}]*$/.test(before) || /\^\{[^}]*$|\/_\{[^}]*$/.test(before)) { fixed = true; why = 'part of a written fraction'; }
    else if (/(?:√|\\sqrt\{?)\s*\(?$/.test(before)) { fixed = true; why = 'under a radical'; }
    out.push({
      start,
      end,
      value,
      text,
      fixed,
      why,
      math: inMath(start),
      format: {
        dollar: m[1] ? m[1] : '',
        percent: m[4] ? m[4] : '',
        commas: /,|\{,\}/.test(m[2]),
        latexCommas: /\{,\}/.test(m[2]),
        places: m[3] ? m[3].length - 1 : 0,
      },
    });
  }
  return out;
}

// Standard conversions: a stated number equal to one of these factors, in a
// sentence that names both units ("there are 10 millimeters in a
// centimeter"), is a fact of the world and never varies.
const CONVERSIONS = [
  [10, 'millimeter', 'centimeter'], [100, 'centimeter', 'meter'], [1000, 'millimeter', 'meter'], [1000, 'meter', 'kilometer'],
  [1000, 'gram', 'kilogram'], [1000, 'milligram', 'gram'], [1000, 'milliliter', 'liter'], [100, 'centiliter', 'liter'],
  [12, 'inch', 'foot'], [12, 'inches', 'feet'], [3, 'foot', 'yard'], [3, 'feet', 'yard'], [36, 'inch', 'yard'], [5280, 'foot', 'mile'], [5280, 'feet', 'mile'], [1760, 'yard', 'mile'],
  [60, 'second', 'minute'], [60, 'minute', 'hour'], [3600, 'second', 'hour'], [24, 'hour', 'day'], [7, 'day', 'week'], [52, 'week', 'year'], [365, 'day', 'year'], [12, 'month', 'year'],
  [16, 'ounce', 'pound'], [2000, 'pound', 'ton'], [4, 'quart', 'gallon'], [2, 'pint', 'quart'], [8, 'pint', 'gallon'], [2, 'cup', 'pint'], [16, 'cup', 'gallon'], [8, 'fluid ounce', 'cup'], [128, 'fluid ounce', 'gallon'],
  [100, 'cent', 'dollar'], [10, 'decade', 'century'], [100, 'year', 'century'], [360, 'degree', 'circle'], [180, 'degree', 'straight'],
];
function isConversion(value, sentence) {
  const lower = sentence.toLowerCase();
  return CONVERSIONS.some(([k, a, b]) => R.eq(value, R.Q(k)) && lower.includes(a) && lower.includes(b));
}
const sentenceAt = (s, i) => {
  const start = Math.max(s.lastIndexOf('. ', i), s.lastIndexOf('? ', i), s.lastIndexOf('\n', i)) + 1;
  const ends = ['. ', '? ', '\n'].map((t) => s.indexOf(t, i)).filter((x) => x >= 0);
  return s.slice(start, ends.length ? Math.min(...ends) + 1 : s.length);
};

/** Where a text states a formula: math spans with an equals sign or a variable, delimited or bare. */
function formulaSpans(s) {
  const out = [];
  const seg = segment(s);
  // segment() reports spans in skeleton order; find each in the text in turn.
  let from = 0;
  for (const sp of seg.spans) {
    const needle = sp.delimited ? null : sp.src;
    const at = needle ? s.indexOf(needle, from) : -1;
    const isFormula = /[=<>≤≥]/.test(sp.src) || /[A-Za-z]\s*\(|\d\s*[A-Za-z]|[A-Za-z]\s*[-+*/^]/.test(sp.src);
    if (at >= 0) {
      if (isFormula) out.push([at, at + needle.length]);
      from = at + needle.length;
    }
  }
  // Delimited spans are located directly.
  for (const m of s.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g)) {
    const body = m[1] ?? m[2];
    if (/[=<>]|\\le|\\ge/.test(body) || /[A-Za-z]\s*\(|\d\s*[A-Za-z]/.test(body.replace(/\\[A-Za-z]+/g, ''))) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** Number words a question uses ("two pieces", "twice as many"): fixed atoms. */
function numberWords(text) {
  const out = [];
  // Only words that multiply: "two" in "the other two integers" is a count
  // that invites coincidences, "twice as many" is an operation.
  for (const m of String(text).matchAll(/\b(twice|double|triple|half|dozen)\b/gi)) {
    out.push({ value: R.Q(WORDS[m[1].toLowerCase()]), fixed: true, word: m[1] });
  }
  return out;
}

/** A value written the way a source number was: $1,250.00, 22%, 1{,}020. */
export function formatLike(v, fmt, { math = false } = {}) {
  const places = Math.max(fmt.places, 0);
  const exact = R.decimalPlaces(v);
  let body;
  if (exact !== null && exact <= places) body = R.toFixed(v, places);
  else if (exact !== null && places === 0 && exact <= 2) body = R.toDecimal(v);
  else return null; // does not print the way the source number did
  const negative = body.startsWith('-');
  if (negative) body = body.slice(1);
  if (fmt.commas || (Number(body.split('.')[0]) >= 10000)) {
    const sep = fmt.latexCommas || math ? '{,}' : ',';
    body = body.replace(/^(\d+)/, (d) => d.replace(/\B(?=(\d{3})+(?!\d))/g, sep));
  }
  return `${negative ? (math ? '-' : '−') : ''}${fmt.dollar}${body}${fmt.percent}`;
}

// --------------------------------------------------------------- the model

const ROUNDING = /\bnearest (?:tenth|hundredth|thousandth|whole|integer|cent|dollar|percent|degree|mile|foot|inch)|\brounded? (?:to|your)|\bapproximately\b|\broughly\b|\bclosest to\b|\bestimated?\b/i;

/** The atoms of a question: stated numbers (varying or fixed), number words, and the constants it may use unsaid. */
function atomsFor(question, choices) {
  const stated = numbersIn(question);
  const words = numberWords(question.replace(/\\\([\s\S]*?\\\)/g, ' '));
  const all = [question, ...choices].join(' ');
  // Constants of the world the question's context calls on without stating
  // them. Among the atoms, the real 180 of a degrees question beats any
  // coincidence of the stated numbers that happens to make 180 (5 * 9 * 2 * 2).
  const extras = [];
  const has = (re) => re.test(all);
  if (has(/%|\\%|percent/i)) extras.push(100, 1);
  if (has(/\bminutes?\b|\bhours?\b|\bseconds?\b/i)) extras.push(60);
  if (has(/\bdegrees?\b|\bradians?\b|°|\\circ/i)) extras.push(90, 180, 360);
  if (has(/\bdays?\b/i) && has(/\b(?:hours?|weeks?|years?)\b/i)) extras.push(24, 7, 365);
  if (has(/\bmonths?\b/i) && has(/\byears?\b/i)) extras.push(12);
  if (has(/\bweeks?\b/i) && has(/\byears?\b/i)) extras.push(52);
  if (has(/\b(?:milli|centi|kilo)?(?:meters?|grams?|liters?)\b/i)) extras.push(10, 100, 1000);
  if (has(/\binch(?:es)?\b/i) && has(/\b(?:foot|feet)\b/i)) extras.push(12);
  if (has(/\b(?:foot|feet)\b/i) && has(/\byards?\b/i)) extras.push(3);
  if (has(/\b(?:foot|feet)\b/i) && has(/\bmiles?\b/i)) extras.push(5280);
  // A stated number may be squared only where squaring is geometry: an
  // area, a circle, a side of a square, similar figures.
  const geometric = /\b(?:area|square|circle|radius|diameter|similar|scale factor|surface)\b/i.test(all);
  const atoms = [
    ...stated.map((n) => ({ value: n.value, fixed: n.fixed, source: n, pct: n.format.percent ? 1 : 0, square: geometric && !n.format.percent })),
    ...words.map((w) => ({ value: w.value, fixed: true, word: w.word })),
    // 100 is what a percent is out of, so it carries the percent unit.
    ...extras.map((k) => R.Q(k)).map((v) => ({ value: v, fixed: true, constant: true, pct: R.eq(v, R.Q(100)) && /%|percent/i.test(all) ? 1 : 0 })),
  ];
  // The same constant twice adds nothing but ambiguity.
  const seen = new Set();
  return atoms.filter((a) => {
    if (!a.fixed || a.source) return true;
    const k = R.key(a.value);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const NUMBER_WORDS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half|halves|twice|double|triple|quarter|third|thirds|fourths?|fifths?|tenths?)\b/i;
const GENERIC = /applying the stated|using the information in the question|solving the equation with the given values|the calculation gives|does not (?:agree|match)|is inconsistent with the calculation|does not follow from the given/i;

/**
 * Bind every number of a text (an explanation) to a formula, or null when
 * one does not bind. Returns [{ start, end, text, f, format, math }].
 */
function bindText(text, space, atoms, tolerance) {
  const out = [];
  for (const n of numbersIn(text, { question: false })) {
    const b = bindValue(space, atoms, n.value, { tolerance: tolerance(n), units: n.format.percent ? [1] : [0, 1] });
    if (!b || b.ambiguous) return null;
    out.push({ ...n, f: b.f });
  }
  return out;
}

/** How many numbers one formula may combine: every one of five, or four of more. */
const searchSize = (atoms) => (atoms.length <= 5 ? atoms.length : 4);

/** Tolerance for a number written rounded, when the question rounds. */
const tolFor = (rounds) => (n) => (rounds ? 0.5 * 10 ** -Math.max(n.format.places, 0) : 0);

/**
 * The word-problem model of a bank item, or NotWord.
 * item: { question, choices, correctIdx, answerType, answerText, accepted, rationale }
 */
export function readWord(item) {
  const question = String(item.question);
  const isGrid = item.answerType === 'grid-in';
  const choices = isGrid ? [] : (item.choices || []).map(String);
  const atoms = atomsFor(question, choices);
  const free = atoms.map((a, i) => (a.fixed ? -1 : i)).filter((i) => i >= 0);
  if (!free.length) refuse('no numbers to vary');
  if (free.length > 5) refuse('too many numbers to bind', String(free.length));
  if (atoms.length > 8) refuse('too many numbers to bind', String(atoms.length));
  const rounds = ROUNDING.test(question);
  // What unit a number in an answer may have: written with %, a percent;
  // bare, a plain number, or a percent when the question asks for one
  // ("what percent", "x% greater", "p%").
  const asksPercent = /\bwhat percent|\b[a-z]\s*(?:\\?%|percent)|\\\(\s*[a-z]\s*\\\)\s*\\?%|\bpercentage\b/i.test(question);
  const unitsOf = (n) => (n.format.percent ? [1] : asksPercent ? [0, 1] : [0]);
  const space = enumerate(atoms, { maxAtoms: searchSize(atoms) });
  if (space.truncated) refuse('too many combinations of its numbers to search');
  const freeMask = free.reduce((m, i) => m | (1 << i), 0);
  const tolerance = tolFor(rounds);

  // The answer: every number in each choice, or the grid-in value.
  const targets = isGrid ? [String(item.answerText)] : choices;
  const bound = targets.map((t, idx) => {
    const nums = numbersIn(t, { question: false });
    if (!nums.length) refuse('a choice without a number', t.slice(0, 60));
    const literals = [];
    for (const n of nums) {
      const b = bindValue(space, atoms, n.value, { tolerance: tolerance(n), units: unitsOf(n) });
      if (!b) refuse(idx === (isGrid ? 0 : item.correctIdx) ? 'the key is no formula of the stated numbers' : 'a distractor is no formula of the stated numbers', `${t}: ${n.text}`);
      if (b.ambiguous) refuse('a number that more than one formula explains', `${t}: ${n.text}`);
      literals.push({ ...n, f: b.f, units: unitsOf(n) });
    }
    return { text: t, literals };
  });
  const keyIdx = isGrid ? 0 : item.correctIdx;
  // A key that is only close to its formula ("to the nearest tenth") cannot
  // tell a formula from a near-miss, so the key must be the formula's exact value.
  for (const l of bound[keyIdx].literals) {
    let exact;
    try { exact = evalExact(l.f, atoms.map((a) => a.value)); } catch { refuse('the key divides by zero'); }
    if (!R.eq(exact, l.value)) refuse('a key that depends on rounding');
  }
  const used = bound[keyIdx].literals.reduce((mask, l) => [...atomsOf(l.f)].reduce((mm, a) => mm | (1 << a), mask), 0);
  if ((used & freeMask) !== freeMask) refuse('the key leaves a stated number unused');
  if (bound[keyIdx].literals.every((l) => 'atom' in l.f) && bound[keyIdx].literals.length === 1) refuse('the key is a number the question states');

  // The source's explanations, re-rendered with new numbers when every number
  // binds and the text reads cleanly (no raw notation outside \( \)).
  const rationale = item.rationale || {};
  const explanations = {};
  for (const [k, text] of Object.entries(rationale)) {
    if (!['correct', 'A', 'B', 'C', 'D'].includes(k) || typeof text !== 'string' || GENERIC.test(text)) continue;
    if (/[\\^_]/.test(text.replace(MATH_SPAN, ' '))) continue;
    // A number written as a word ("Forty percent") would not change with the numbers.
    if (NUMBER_WORDS.test(text)) continue;
    const b = bindText(text, space, atoms, tolerance);
    // Worth keeping only when it shows work: a number beyond the answer itself.
    if (b && b.some((n) => !bound[keyIdx].literals.some((l) => R.eq(l.value, n.value)))) explanations[k] = { text, numbers: b };
  }
  // A key built from three or more stated numbers is believed only with
  // corroboration: the source's own explanation passes through one of its
  // steps (a number in the explanation is the value of part of the formula),
  // or a distractor does ("200 is the number of gallons that must drain").
  const qs = atoms.map((a) => a.value);
  for (const l of bound[keyIdx].literals) {
    // A stated conversion or a stated formula's number is meant to be used;
    // the numbers that could combine by coincidence are the rest.
    const stated = [...atomsOf(l.f)].filter((i) => !atoms[i].constant && !['a stated conversion', 'part of a stated formula'].includes(atoms[i].source?.why)).length;
    if (stated < 3) continue;
    const steps = new Set(subValues(l.f, qs).map(R.key));
    const anchored = explanations.correct?.numbers.some((n) => steps.has(R.key(n.value)));
    const shared = bound.some((b, i) => i !== keyIdx && b.literals.some((d) => {
      let v;
      try { v = evalExact(d.f, qs); } catch { return false; }
      return steps.has(R.key(v)) || subValues(d.f, qs).some((x) => steps.has(R.key(x)));
    }));
    if (!anchored && !shared) refuse('a key of three or more numbers with nothing to corroborate it');
  }
  return { question, atoms, free, bound, keyIdx, isGrid, rounds, explanations, stated: numbersIn(question), space };
}

// ------------------------------------------------------------------ variants

/**
 * "a"/"an" before a number, by how the number is read: an 8-hour shift, an
 * 11% rise, an 80% increase, a 70% increase.
 */
export function articles(text) {
  return text.replace(/\b([Aa])(n?)(\s+\$?)(\d[\d,]*)/g, (all, a, n, sp, digits) => {
    const d = digits.replace(/,/g, '');
    const vowel = /^8/.test(d) || /^1[18]$/.test(d) || /^1[18]\d{3}$/.test(d) || /^1[18]\d{6}$/.test(d);
    return `${a}${vowel ? 'n' : ''}${sp}${digits}`;
  });
}

/** Replace numbers in a text by new values: [{ start, end, text }] sorted. */
function splice(text, edits) {
  let out = '';
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

/** The shape a bound number must keep: whole stays whole, places stay, sign stays, size stays near. */
function keepsShape(src, v, n, rounds) {
  if (R.sign(src) !== R.sign(v)) return false;
  const places = R.decimalPlaces(v);
  if (!rounds) {
    if (R.isInt(src) !== R.isInt(v)) return false;
    if (places === null || places > Math.max(n.format.places, R.isInt(src) ? 0 : 2)) return false;
  }
  const a = Math.abs(R.toNumber(src));
  const b = Math.abs(R.toNumber(v));
  return a === 0 ? b === 0 : b <= a * 5 && b >= a / 5;
}

/** A bound number's new text, rounded when the question rounds. */
function renderNumber(n, value, rounds) {
  let v = value;
  if (rounds) v = R.parse(R.approx(value, Math.max(n.format.places, 0), 'round'));
  return formatLike(v, n.format, { math: n.math });
}

const LETTERS = ['A', 'B', 'C', 'D'];
const m = (t) => `\\(${t}\\)`;

/**
 * One variant for a set of new values, or a reason it cannot be made.
 */
export function buildWord(model, values, r, item) {
  const qs = model.atoms.map((a, i) => (a.fixed ? a.value : values[i]));
  const shownAtoms = model.atoms.map((a, i) => {
    if (a.word) return a.word;
    if (a.constant) return R.toDecimal(a.value);
    const n = a.source;
    return formatLike(qs[i], { ...n.format, dollar: '', percent: '' }, { math: true })?.replace(/−/g, '-') ?? R.toPlain(qs[i]);
  });
  // The stem: every varying number replaced.
  const stemEdits = [];
  for (const [i, a] of model.atoms.entries()) {
    if (a.fixed || !a.source) continue;
    const text = formatLike(qs[i], a.source.format, { math: a.source.math });
    if (!text) return { reason: 'a stated number does not print like the original' };
    stemEdits.push({ start: a.source.start, end: a.source.end, text });
  }
  const question = articles(splice(model.question, stemEdits));
  // Choices: every bound number evaluated again.
  const texts = [];
  const values_ = [];
  for (const choice of model.bound) {
    const edits = [];
    const vals = [];
    for (const l of choice.literals) {
      let v;
      try { v = evalExact(l.f, qs); } catch { return { reason: 'a formula divides by zero' }; }
      if (!keepsShape(l.value, v, l, model.rounds)) return { reason: 'a choice changes shape' };
      const text = renderNumber(l, v, model.rounds);
      if (!text) return { reason: 'a choice does not print like the original' };
      edits.push({ start: l.start, end: l.end, text });
      vals.push(v);
    }
    texts.push(splice(choice.text, edits));
    values_.push(vals);
  }
  if (new Set(texts).size !== texts.length) return { reason: 'two choices came out the same' };
  // The key must differ from every distractor by value, not only by text.
  const keyVals = values_[model.keyIdx];
  // For a numeric answer, a distractor worth the key's value is a second key.
  const numeric = (t) => /^\s*(?:\\\()?\s*[-−]?\s*\\?\$?\s?[\d,{}.]+\s*(?:\\?%)?\s*(?:\\\))?\s*$/.test(t);
  if (!model.isGrid && numeric(texts[model.keyIdx]) && values_.some((vals, i) => i !== model.keyIdx && numeric(texts[i]) && Math.abs(R.toNumber(vals[0]) - R.toNumber(keyVals[0])) < 1e-9)) return { reason: 'a distractor equals the key' };

  // Explanations: the source's own, re-rendered, or the computation itself.
  const keyLits = model.bound[model.keyIdx].literals;
  // A number set inside \( \): the thousands comma as {,}, no $ or %.
  const inMath = (n, v) => {
    const exact = R.decimalPlaces(v);
    const places = model.rounds || exact === null ? n.format.places : exact;
    return renderNumber({ ...n, math: true, format: { ...n.format, dollar: '', percent: '', places } }, v, model.rounds);
  };
  const work = keyLits.length === 1 ? `${formulaTex(keyLits[0].f, shownAtoms)} = ${inMath(keyLits[0], keyVals[0])}` : null;
  const rerender = (e) => {
    const edits = [];
    const qsSrc = model.atoms.map((a) => a.value);
    for (const n of e.numbers) {
      let v;
      let src;
      try { v = evalExact(n.f, qs); src = evalExact(n.f, qsSrc); } catch { return null; }
      // A number the source wrote rounded ("≈ 198.9") is rounded the same
      // way; one it wrote exactly is written exactly, with the places it needs.
      const roundedInSource = !R.eq(src, n.value);
      let t;
      if (roundedInSource) t = model.rounds ? renderNumber(n, v, true) : null;
      else {
        const places = R.decimalPlaces(v);
        t = places === null ? null : formatLike(v, { ...n.format, places: Math.max(n.format.places, places) }, { math: n.math });
      }
      if (!t || !keepsShape(n.value, v, n, true)) return null;
      edits.push({ start: n.start, end: n.end, text: t });
    }
    return articles(splice(e.text, edits));
  };
  let correct = model.explanations.correct ? rerender(model.explanations.correct) : null;
  if (!correct) {
    if (!work) return { reason: 'no explanation for an answer with several numbers' };
    // A computation leaning on several constants the question never states
    // ("90 - 78 * 180 / 360") is right but explains nothing.
    const unstated = [...atomsOf(keyLits[0].f)].filter((i) => model.atoms[i].constant).length;
    if (unstated > 1) return { reason: 'no natural explanation for the key' };
    correct = `Using the numbers in the question, ${m(work)}.`;
  }
  // The corrected route, when the key is one computation; an equation or
  // expression key is shown by the explanation of the correct answer instead.
  const fix = work ? ` The correct calculation is ${m(work)}.` : '';
  if (model.isGrid) {
    // A rounded answer is entered as the question asks; an exact one as the SAT accepts it.
    const grid = model.rounds
      ? (() => { const t = R.approx(keyVals[0], Math.max(keyLits[0].format.places, 0), 'round'); return { text: t, accepted: [t] }; })()
      : gridAnswer(keyVals[0]);
    if (!grid) return { reason: 'the answer does not fit the grid' };
    // A source answered in decimals keeps a decimal answer where one is exact.
    const decimal = R.toDecimal(keyVals[0]);
    if (!model.rounds && keyLits[0].format.places && decimal && grid.accepted.includes(decimal)) grid.text = decimal;
    return { item: { question, choices: [], correctIdx: 0, answerType: 'grid-in', answerText: grid.text, accepted: grid.accepted, rationale: { correct } }, values: qs };
  }
  const why = texts.map((t, i) => {
    if (i === model.keyIdx) return null;
    const own = model.explanations[LETTERS[i]] ? rerender(model.explanations[LETTERS[i]]) : null;
    if (own) return /^This\b/.test(own) ? own : `This is not correct. ${own}`;
    const lits = model.bound[i].literals;
    // A short wrong computation is worth showing; a long one is noise.
    if (lits.length === 1 && sizeOf(lits[0].f) >= 2 && sizeOf(lits[0].f) <= 3) {
      const v = inMath(lits[0], values_[i][0]);
      return `This comes from ${m(`${formulaTex(lits[0].f, shownAtoms)} = ${v}`)}, which combines the numbers in the question the wrong way.${fix}`;
    }
    return `This does not follow from the numbers in the question.${fix}`;
  });
  // Shuffle; explanations follow their choices.
  const order = r.shuffle([0, 1, 2, 3]);
  const choices = order.map((i) => texts[i]);
  const correctIdx = order.indexOf(model.keyIdx);
  const rationale = { correct };
  order.forEach((src, pos) => { if (src !== model.keyIdx) rationale[LETTERS[pos]] = why[src]; });
  return { item: { question, choices, correctIdx, answerType: 'multiple-choice', rationale }, values: qs };
}

/** Up to `count` verified variants of a word problem. */
export function varyWord(model, item, { count = 3, r, attempts = 3000 } = {}) {
  const variants = [];
  const rejected = {};
  const reject = (why) => { rejected[why] = (rejected[why] || 0) + 1; };
  const seen = new Set([model.question]);
  for (let tried = 0; tried < attempts && variants.length < count; tried += 1) {
    const values = model.atoms.map((a) => (a.fixed ? a.value : draw({ value: a.value, places: a.source.format.places }, r)));
    if (model.free.filter((i) => !R.eq(values[i], model.atoms[i].value)).length < Math.min(2, model.free.length)) { reject('too close to the source'); continue; }
    // Numbers that differ in the source differ in the variant.
    if (model.free.some((i) => model.free.some((j) => i < j && !R.eq(model.atoms[i].value, model.atoms[j].value) && R.eq(values[i], values[j])))) { reject('two different numbers came out equal'); continue; }
    const built = buildWord(model, values, r, item);
    if (!built.item) { reject(built.reason); continue; }
    if (seen.has(built.item.question)) { reject('duplicate variant'); continue; }
    const verdict = verifyWord(built.item, model);
    if (!verdict.verified) { reject(`not verified: ${verdict.errors[0]}`); continue; }
    seen.add(built.item.question);
    variants.push({
      ...built.item,
      params: model.free.map((i) => ({ from: R.toPlain(model.atoms[i].value), to: R.toPlain(values[i]) })),
      verification: { method: 'numbers re-read from the rendered text, every formula re-evaluated, the key bound again', askKind: 'word' },
    });
  }
  return { variants, rejected };
}

// ------------------------------------------------------------------- check

function renderProblems(text) {
  const out = [];
  for (const [, tex] of String(text).matchAll(MATH_SPAN)) {
    try { katex.renderToString(tex, { throwOnError: true, strict: 'ignore' }); } catch (err) { out.push(`KaTeX cannot render \\(${tex}\\)`); }
  }
  return out;
}

/**
 * The check of a finished word variant: the rendered text read again, its
 * numbers re-extracted, every choice's formulas evaluated in floating point,
 * exactly one choice equal to the key, and the key bound again on the new
 * numbers to the same formula and to no other.
 */
export function verifyWord(v, model) {
  const errors = [...itemProblems(v, { numericGrid: false })];
  for (const t of [v.question, ...(v.choices || []), ...Object.values(v.rationale || {})]) errors.push(...renderProblems(t));
  if (errors.length) return { verified: false, errors };
  const fail = (e) => ({ verified: false, errors: [e] });
  const stated = numbersIn(v.question);
  if (stated.length !== model.stated.length) return fail('the variant states a different count of numbers');
  const atoms = atomsFor(v.question, v.choices || []);
  if (atoms.length !== model.atoms.length || atoms.some((a, i) => a.fixed !== model.atoms[i].fixed)) return fail('the variant reads with different numbers');
  const xs = atoms.map((a) => R.toNumber(a.value));
  // Each choice's numbers against its formulas, in floating point.
  const keyText = model.isGrid ? String(v.answerText) : v.choices[v.correctIdx];
  const expect = (idx) => model.bound[idx].literals.map((l) => evalFloat(l.f, xs));
  const tol = (n) => (model.rounds ? 0.5 * 10 ** -Math.max(n.format.places, 0) + 1e-9 : 1e-9 * Math.max(1, Math.abs(R.toNumber(n.value))));
  const matches = (text, idx) => {
    const nums = numbersIn(text, { question: false });
    const want = expect(idx);
    return nums.length === want.length && nums.every((n, j) => Math.abs(R.toNumber(n.value) - want[j]) <= tol(n));
  };
  // A grid-in answer may be the SAT's fraction ("24/5") or a decimal.
  const gridOk = () => {
    let q;
    try { q = R.parse(keyText.replace(/,/g, '')); } catch { return false; }
    const want = expect(model.keyIdx)[0];
    return Math.abs(R.toNumber(q) - want) <= (model.rounds ? 0.5 * 10 ** -Math.max(model.bound[0].literals[0].format.places, 0) + 1e-9 : 1e-9 * Math.max(1, Math.abs(want)));
  };
  if (model.isGrid ? !gridOk() : !matches(keyText, model.keyIdx)) return fail(`the key ${keyText} does not match its formula`);
  if (!model.isGrid) {
    // Every choice carries its own formulas' values: the shuffle is undone by
    // each choice's shape (its text with the numbers masked) and its numbers.
    const shape = (t) => { let out = ''; let at = 0; for (const n of numbersIn(t, { question: false })) { out += t.slice(at, n.start) + '#'; at = n.end; } return out + t.slice(at); };
    const srcOrder = v.choices.map((c) => model.bound.findIndex((b, i) => shape(b.text) === shape(c) && matches(c, i)));
    if (srcOrder.some((i) => i < 0) || new Set(srcOrder).size !== 4) return fail('a choice does not match its formulas');
    // A single number as the answer: no other choice may carry the key's value.
    if (model.bound[model.keyIdx].literals.length === 1) {
      const kv = expect(model.keyIdx)[0];
      const same = v.choices.filter((c) => { const ns = numbersIn(c, { question: false }); return ns.length === 1 && Math.abs(R.toNumber(ns[0].value) - kv) <= tol(ns[0]); });
      if (same.length !== 1) return fail(`${same.length} choices carry the key's value`);
    }
  }
  // Bound again on the variant's numbers: the same formula, and only it.
  const space = enumerate(atoms, { maxAtoms: searchSize(atoms) });
  if (space.truncated) return fail('the variant has too many combinations to check');
  for (const l of model.bound[model.keyIdx].literals) {
    const value = R.parse(String(R.toDecimal(evalExact(l.f, atoms.map((a) => a.value))) ?? R.toPlain(evalExact(l.f, atoms.map((a) => a.value)))));
    const b = bindValue(space, atoms, value, { units: l.units });
    if (!b || b.ambiguous) return fail('the variant can be read more than one way');
    if (!equivalent(b.f, l.f, atoms)) return fail('the variant binds its key to a different formula');
  }
  return { verified: true, errors: [] };
}
