// The variation engine: understand a bank question, then produce verified
// variations of it.
//
// A question is understood only when the engine can read every piece of it
// and, solving it exactly, arrives at the source's own key: for a multiple
// choice question, exactly one choice is correct and it is the keyed one. A
// question it cannot read, or reads to a different answer, is left alone.

import { readQuestion, NotUnderstood } from './model.js';

/** Recorded on every variant, so a batch can be traced to the engine that made it. */
export const ENGINE_VERSION = 'variation-1';
import { answer, correctChoices, gridStates } from './solve.js';
import { NotPolynomial } from './poly.js';

/** Normalize a bank row (pa_items shape) or an engine item to one shape. */
export function asItem(row) {
  return {
    id: row.id ?? null,
    question: row.question,
    choices: row.choices || [],
    correctIdx: row.correctIdx ?? row.correct_idx ?? 0,
    answerType: row.answerType ?? row.answer_type ?? 'multiple-choice',
    answerText: row.answerText ?? row.answer_text ?? null,
    accepted: row.accepted || [],
    domain: row.domain,
    skill: row.skill,
    difficulty: row.difficulty,
  };
}

/**
 * { ok: true, model, answer } when the engine reads the question and its own
 * solution reproduces the source's key, else { ok: false, reason }.
 */
// A formal reading failed for one of these reasons: the question may still
// be a word problem the word engine can read.
const WORDY = /^(?:numbers in the prose|no math|a question the engine does not recognize|a math span that is neither)/;

export function understand(row) {
  const formal = understandFormal(row);
  if (formal.ok || !WORDY.test(formal.reason)) return formal;
  const item = asItem(row);
  try {
    const model = readWord({ ...item, rationale: row.rationale || {} });
    return { ok: true, kind: 'word', model, item: { ...item, rationale: row.rationale || {} } };
  } catch (err) {
    if (err instanceof NotWord) return { ok: false, reason: err.message, detail: err.detail || null, formal: formal.reason };
    if (err instanceof RangeError) return { ok: false, reason: `arithmetic out of range: ${err.message}` };
    throw err;
  }
}

function understandFormal(row) {
  const item = asItem(row);
  try {
    const model = readQuestion(item);
    const ans = answer(model);
    if (item.answerType === 'grid-in') {
      if (!gridStates(ans, item.answerText, item.accepted)) return { ok: false, reason: 'solution differs from the key', model, answer: ans };
    } else {
      const correct = correctChoices(model, ans);
      if (correct.length !== 1) return { ok: false, reason: correct.length ? 'more than one choice is correct' : 'no choice matches the solution', model, answer: ans };
      if (correct[0] !== item.correctIdx) return { ok: false, reason: 'solution differs from the key', model, answer: ans };
    }
    return { ok: true, kind: 'formal', model, answer: ans, item };
  } catch (err) {
    if (err instanceof NotUnderstood || err instanceof NotPolynomial) return { ok: false, reason: err.message, detail: err.detail || null };
    if (err instanceof RangeError) return { ok: false, reason: `arithmetic out of range: ${err.message}` };
    throw err;
  }
}

// ---------------------------------------------------------------- variation

import * as R from './rational.js';
import * as P from './poly.js';
import { walk, toTex, inlineCalls } from './expr.js';
import { rng } from '../templates/rng.js';
import { findParams, instantiate, drawAll, sameShape, workSize, keepsDistinct, fractionsKeepShape, sameMonomials, linearLink } from './vary.js';
import { parts, relationPoly } from './solve.js';
import { explain, m } from './explain.js';
import { pickDistractors, explainSource, pickExprDistractors, explainSourceExpr } from './distract.js';
import { renderQuestion, numberChoice, mathChoice, gridAnswer } from './render.js';
import { verifyVariant } from './verify.js';
import { readWord, varyWord, NotWord } from './word.js';
import { SKILLS, domainForSkill } from '../taxonomy.js';

const LETTERS = ['A', 'B', 'C', 'D'];

/** Variables of an expression in order of first appearance. */
function orderOfAppearance(tree) {
  const out = [];
  for (const [n] of walk(tree)) if (n.k === 'sym' && !out.includes(n.name)) out.push(n.name);
  return out;
}

/** An expression answer as a polynomial with its print order, or null. */
function exprAnswer(model, trees, ans) {
  const { defs, target } = parts(model, trees);
  if (!P.isConstant(ans.rat.den)) return null;
  const poly = P.scale(ans.rat.num, R.inv(P.constantValue(ans.rat.den)));
  const order = orderOfAppearance(inlineCalls(target, defs));
  return { ...ans, poly, order, display: P.toTree(poly, order) };
}

/** Whether a choice is written as a polynomial in standard (expanded) form. */
function expandedForm(tree) {
  const monomial = (n) => {
    if (n.k === 'num' || n.k === 'sym') return true;
    if (n.k === 'pow') return n.base.k === 'sym' && n.exp.k === 'num';
    if (n.k === 'div') return n.num.k === 'num' && n.den.k === 'num';
    if (n.k === 'mul') return n.items.every((f) => f.k === 'num' || f.k === 'sym' || (f.k === 'pow' && f.base.k === 'sym' && f.exp.k === 'num') || (f.k === 'div' && f.num.k === 'num' && f.den.k === 'num'));
    return false;
  };
  if (tree.k === 'add') return tree.items.every(({ e }) => monomial(e));
  if (tree.k === 'neg') return monomial(tree.e);
  return monomial(tree);
}

/**
 * The skill a question's structure tests, with the others it could fairly be
 * filed under. Equivalence and identities are Equivalent expressions; one
 * equation in one unknown is linear or nonlinear by its degree; two
 * equations are a system; a question about a defined function is a Linear or
 * Nonlinear function by the function's degree.
 */
export function classify(model, ans) {
  const pieces = parts(model);
  const { defs, relations, identities, target } = pieces;
  const kind = model.ask.kind;
  const defDegree = () => Math.max(0, ...Object.values(defs).map((f) => {
    try {
      const r = P.fromTree(f.body);
      return P.isConstant(r.den) ? P.degree(r.num, f.param) : 9;
    } catch { return 9; }
  }));
  const fn = (deg) => (deg <= 1 ? ['Linear functions', 'Linear equations in two variables'] : ['Nonlinear functions']);
  if (kind === 'equivalent' || kind === 'equivalentAbove' || identities.length) return ['Equivalent expressions'];
  if (!relations.length) return Object.keys(defs).length ? fn(defDegree()) : ['Equivalent expressions'];
  const inl = relations.map((r) => inlineCalls(r, defs));
  const hasAbs = inl.some((r) => [...walk(r)].some(([n]) => n.k === 'abs'));
  // Degree in the unknowns only: a constant times x ("c(2x + 1)") is still linear.
  const constants = new Set([...model.constants.keys(), ...(target?.k === 'sym' && model.special ? [target.name] : [])]);
  const deg = Math.max(...inl.map((r) => {
    try {
      const l = P.fromTree(r.l);
      const rr = P.fromTree(r.r);
      if (!P.isConstant(l.den) || !P.isConstant(rr.den)) return 9;
      let poly = P.sub(P.scale(l.num, R.inv(P.constantValue(l.den))), P.scale(rr.num, R.inv(P.constantValue(rr.den))));
      const known = Object.fromEntries([...constants].map((c) => [c, R.Q(2)]));
      poly = P.substitute(poly, known);
      return P.totalDegree(poly);
    } catch { return 9; }
  }));
  // The variables the relations are about, whatever the question asks for.
  const unknowns = [...new Set(inl.flatMap((r) => [...walk(r)].filter(([n]) => n.k === 'sym').map(([n]) => n.name)))].filter((u) => !constants.has(u));
  const calls = (t) => Boolean(t) && [...walk(t)].some(([n]) => n.k === 'call' && defs[n.f]);
  const usesFunction = Object.keys(defs).length > 0 && (relations.some(calls) || calls(target));
  if (usesFunction) return [...fn(defDegree()), ...(defDegree() <= 1 ? ['Linear equations in one variable'] : ['Nonlinear equations in one variable and systems of equations in two variables'])];
  if (relations.length >= 2 && unknowns.length >= 2) {
    return deg <= 1 && !hasAbs ? ['Systems of two linear equations in two variables'] : ['Nonlinear equations in one variable and systems of equations in two variables'];
  }
  if (deg <= 1 && !hasAbs) return ['Linear equations in one variable'];
  return ['Nonlinear equations in one variable and systems of equations in two variables', ...(target && target.k !== 'sym' ? ['Equivalent expressions'] : [])];
}

/** The shape a variant's answer must share with the source's. */
function sameAnswer(src, out) {
  if (src.type !== out.type) return false;
  switch (src.type) {
    case 'number': {
      if (!sameShape(src.value, out.value)) return false;
      // The solutions behind the answer keep their kind too: integer
      // solutions stay integers, and the count of solutions is unchanged.
      const a = src.solved?.solutions || [];
      const b = out.solved?.solutions || [];
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        for (const u of Object.keys(a[i])) {
          if (!(u in b[i])) return false;
          if (R.isInt(a[i][u]) !== R.isInt(b[i][u])) return false;
          if (!R.isInt(a[i][u]) && Number(b[i][u].d) > Math.max(12, Number(a[i][u].d) * 2)) return false;
        }
      }
      return true;
    }
    case 'count': return src.value === out.value;
    case 'none': return true;
    case 'expr': {
      // Same terms with the same signs: 3w^{2} + 11w - 70 stays a + b - c.
      const terms = (a) => new Map([...a.rat.num.entries()].map(([k, { c }]) => [k, R.toNumber(R.div(c, P.constantValue(a.rat.den)))]));
      const ta = terms(src);
      const tb = terms(out);
      if (ta.size !== tb.size || [...ta.keys()].some((k) => !tb.has(k))) return false;
      if ([...ta].some(([k, c]) => Math.sign(c) !== Math.sign(tb.get(k)))) return false;
      const max = (t) => Math.max(...[...t.values()].map(Math.abs));
      return max(tb) <= Math.max(60, 4 * max(ta));
    }
    default: return false;
  }
}

/** The finished item for one set of trees, or a reason it cannot be built. */
function build(model, trees, ans, item, profile, r) {
  const question = renderQuestion(model, trees);
  const explanation = explain(model, trees, ans);
  const base = { question, answerType: item.answerType, rationale: { correct: explanation.text } };
  if (item.answerType === 'grid-in') {
    if (ans.type !== 'number') return { reason: `grid-in ${ans.type} answer` };
    const grid = gridAnswer(ans.value);
    if (!grid) return { reason: 'answer does not fit the grid' };
    return { item: { ...base, choices: [], correctIdx: 0, answerText: grid.text, accepted: grid.accepted } };
  }
  let options;
  if (ans.type === 'number') {
    const wrong = pickDistractors(model, trees, ans, explanation.summary, profile.preferred);
    if (!wrong) return { reason: 'fewer than three distinct distractors' };
    const dollars = model.choices.some((c) => c.dollars);
    options = [{ text: numberChoice(ans.value, { dollars }), why: null }, ...wrong.map((w) => ({ text: numberChoice(w.value, { dollars }), why: w.why }))];
  } else if (ans.type === 'expr') {
    const ex = exprAnswer(model, trees, ans);
    if (!ex) return { reason: 'expression answer is not a polynomial' };
    const fix = `Expanding correctly gives ${m(toTex(ex.display))}.`;
    const wrong = pickExprDistractors(model, trees, ex, fix, profile.preferred);
    if (!wrong) return { reason: 'fewer than three distinct distractors' };
    options = [{ text: mathChoice(ex.display), why: null }, ...wrong.map((w) => ({ text: mathChoice(P.toTree(w.poly, ex.order)), why: w.why }))];
  } else if (ans.type === 'count') {
    // The same four options ("Zero", "Exactly one", ...); the count is unchanged.
    options = item.choices.map((text, i) => ({ text, why: i === item.correctIdx ? null : `This is not the number of solutions. ${explanation.summary}` }));
    const correct = options[item.correctIdx];
    options = [correct, ...options.filter((o) => o !== correct)];
  } else return { reason: `${ans.type} answers are not varied yet` };
  if (new Set(options.map((o) => o.text)).size !== 4) return { reason: 'duplicate choice text' };
  // Shuffle; explanations follow their choices.
  const order = r.shuffle([0, 1, 2, 3]);
  const choices = order.map((i) => options[i].text);
  const correctIdx = order.indexOf(0);
  const rationale = { ...base.rationale };
  order.forEach((src, pos) => { if (src !== 0) rationale[LETTERS[pos]] = options[src].why; });
  return { item: { ...base, choices, correctIdx, rationale } };
}

/**
 * What must not change between a source and its variant beyond the answer's
 * shape: the monomials of every relation once expanded, and how a linear
 * target relates to the equation it is asked about.
 */
function signature(model, trees) {
  const pieces = parts(model, trees);
  const polys = [];
  for (const rel of pieces.relations) {
    try { polys.push(relationPoly(inlineCalls(rel, pieces.defs)).poly); } catch { polys.push(null); }
  }
  let link = null;
  const t = pieces.target;
  if (model.ask.kind === 'value' && t && t.k !== 'sym' && pieces.relations.length === 1) {
    try {
      const rel = inlineCalls(pieces.relations[0], pieces.defs);
      const tp = P.fromTree(inlineCalls(t, pieces.defs));
      const l = P.fromTree(rel.l);
      const r = P.fromTree(rel.r);
      const vars = [...P.vars(tp.num)];
      if (vars.length === 1 && P.isConstant(tp.den) && P.isConstant(l.den) && P.isConstant(r.den)) {
        const side = P.isConstant(r.num) ? l : P.isConstant(l.num) ? r : null;
        if (side) link = linearLink(P.scale(tp.num, R.inv(P.constantValue(tp.den))), P.scale(side.num, R.inv(P.constantValue(side.den))), vars[0]);
      }
    } catch { link = null; }
  }
  return { polys, link };
}

function sameSignature(a, b) {
  const pa = a.polys.filter(Boolean);
  const pb = b.polys.filter(Boolean);
  if (pa.length !== pb.length || !sameMonomials(pa, pb)) return false;
  if (!a.link) return true;
  return Boolean(b.link) && a.link.kWhole === b.link.kWhole && a.link.kSign === b.link.kSign && a.link.cZero === b.link.cZero;
}

/**
 * Up to `count` verified variants of an understood question.
 * Returns { variants, tried, rejected: { reason: n }, classification }.
 */
export function vary(understood, { count = 3, seed = 1, attempts = 4000 } = {}) {
  if (understood.kind === 'word') {
    // A word problem keeps its source's skill: its classification comes from
    // the words, which the engine does not judge.
    const out = varyWord(understood.model, understood.item, { count, r: rng(seed), attempts: Math.min(attempts, 3000) });
    const skill = understood.item.skill;
    return { ...out, tried: null, classification: { skills: [skill], source: skill, agrees: true } };
  }
  const { model, answer: srcAns, item } = understood;
  const { params } = findParams(model);
  const rejected = {};
  const reject = (why) => { rejected[why] = (rejected[why] || 0) + 1; };
  const skills = classify(model, srcAns);
  const classification = { skills, source: item.skill, agrees: skills.includes(item.skill) };
  if (!params.length) return { variants: [], tried: 0, rejected: { 'no numbers to vary': 1 }, classification };
  if (!['number', 'expr', 'count'].includes(srcAns.type)) return { variants: [], tried: 0, rejected: { [`${srcAns.type} answers are not varied yet`]: 1 }, classification };
  model.keyIdx = item.correctIdx;
  // The source's distractors name the mistakes its variants should use.
  const srcExplain = explain(model, model.trees, srcAns);
  let preferred = [];
  if (item.answerType !== 'grid-in') {
    if (srcAns.type === 'number') preferred = explainSource(model, srcAns, srcExplain.summary);
    if (srcAns.type === 'expr') {
      const ex = exprAnswer(model, model.trees, srcAns);
      const keyChoice = model.choices[item.correctIdx];
      if (!ex || !keyChoice.tree || !expandedForm(keyChoice.tree)) {
        return { variants: [], tried: 0, rejected: { 'the key is not an expanded polynomial': 1 }, classification };
      }
      preferred = explainSourceExpr(model, ex);
    }
  }
  const srcWork = workSize(parts(model).relations.map((rel) => { try { return relationPoly(inlineCalls(rel, parts(model).defs)).poly; } catch { return new Map(); } }));
  const srcSignature = signature(model, model.trees);
  const r = rng(seed);
  const variants = [];
  const seen = new Set([renderQuestion(model, model.trees)]);
  let tried = 0;
  for (; tried < attempts && variants.length < count; tried += 1) {
    const values = drawAll(params, r);
    const changed = values.filter((v, i) => !R.eq(v, params[i].value)).length;
    if (changed < Math.min(2, params.length)) { reject('too close to the source'); continue; }
    if (!keepsDistinct(params, values)) { reject('two different numbers came out equal'); continue; }
    const trees = instantiate(model, params, values);
    if (!fractionsKeepShape(model.trees, trees)) { reject('a fraction changes character'); continue; }
    if (!sameSignature(srcSignature, signature(model, trees))) { reject('the structure changes'); continue; }
    let ans;
    try { ans = answer(model, trees); } catch { reject('variant cannot be solved'); continue; }
    if (!sameAnswer(srcAns, ans)) { reject('answer changes shape'); continue; }
    const pieces = parts(model, trees);
    let work = 0;
    try { work = workSize(pieces.relations.map((rel) => relationPoly(inlineCalls(rel, pieces.defs)).poly)); } catch { /* no relations */ }
    if (work > Math.max(200, srcWork * 4)) { reject('numbers grow too large'); continue; }
    let built;
    try { built = build(model, trees, ans, item, { preferred }, r); } catch (err) { reject(`build failed: ${err.message}`); continue; }
    if (!built.item) { reject(built.reason); continue; }
    if (seen.has(built.item.question)) { reject('duplicate variant'); continue; }
    const verdict = verifyVariant(built.item, { askKind: model.ask.kind });
    if (!verdict.verified) { reject(`not verified: ${verdict.errors[0]}`); continue; }
    seen.add(built.item.question);
    variants.push({
      ...built.item,
      params: params.map((p, i) => ({ from: R.toPlain(p.value), to: R.toPlain(values[i]) })),
      verification: { method: 'independent numeric re-solve of the rendered text', askKind: model.ask.kind },
    });
  }
  return { variants, tried, rejected, classification };
}

export { SKILLS, domainForSkill };
