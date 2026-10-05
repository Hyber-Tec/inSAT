// Wrong answers from named mistakes.
//
// A distractor is the answer a student reaches by making one specific error:
// solving for the wrong quantity, dropping a sign, distributing to one term
// only, not dividing at the end, picking the other root. Each mistake is a
// transformation of the question's own trees, solved exactly, and carries a
// student-facing explanation that opens with "This". Mistakes are located by
// path, so a mistake found in the source applies unchanged to every variant:
// a variant keeps the source's kind of distractors.

import * as R from './rational.js';
import * as P from './poly.js';
import { walk, toTex, getAt, replaceAt, inlineCalls, symbols, evalQ } from './expr.js';
import { parts, answer } from './solve.js';
import { m, num } from './explain.js';

/** Solve a mutated copy of the model; the answer's number, or null. */
function solveWith(model, trees) {
  try {
    const a = answer(model, trees);
    return a.type === 'number' ? a.value : null;
  } catch { return null; }
}

/** Every mistake that applies to a model's structure (paths into its trees). */
export function mistakesFor(model) {
  const out = [];
  const { kind } = model.ask;
  const t = model.ask.targetSpan;
  // Solving for the wrong quantity.
  if (kind === 'value') {
    out.push({ type: 'unknown' });
    if (t !== null) {
      for (const [node, path] of walk(model.trees[t])) {
        // x - 3 for x + 3; never -x + 3, which no one writes by mistake.
        if (node.k === 'add') node.items.forEach((_, i) => { if (i > 0) out.push({ type: 'target-sign', path: [...path, 'items', i] }); });
        if (node.k === 'div') out.push({ type: 'reciprocal', path });
      }
    }
  }
  // Sign errors and distribution errors inside the given equations and the
  // functions they use. A sign slip happens to a term being moved or combined,
  // not to the leading term of an expression.
  model.roles.forEach((role, span) => {
    if (!['rel', 'idl', 'idr', 'def'].includes(role)) return;
    for (const [node, path] of walk(model.trees[span])) {
      if (node.k === 'add') node.items.forEach((_, i) => { if (i > 0) out.push({ type: 'flip', span, path: [...path, 'items', i] }); });
      if (node.k === 'div' && node.den.k === 'num' && !R.eq(node.den.v, R.ONE) && path.length) out.push({ type: 'keep-denominator', span, path });
      if (node.k === 'mul' && node.items.length === 2 && node.items[0].k === 'num' && node.items[1].k === 'group' && node.items[1].e.k === 'add') {
        out.push({ type: 'distribute', span, path });
      }
      if (node.k === 'neg' && node.e.k === 'group' && node.e.e.k === 'add') out.push({ type: 'distribute-minus', span, path });
      if (node.k === 'add') {
        node.items.forEach((it, i) => {
          if (it.neg && it.e.k === 'group' && it.e.e.k === 'add') out.push({ type: 'distribute-minus-item', span, path: [...path, 'items', i] });
        });
      }
    }
  });
  // Evaluating a function: the classic slips with powers and negative inputs.
  model.roles.forEach((role, span) => {
    if (role !== 'def') return;
    for (const [node, path] of walk(model.trees[span])) {
      if (node.k === 'mul' && node.items.length === 2 && node.items[0].k === 'num' && node.items[1].k === 'pow' && node.items[1].base.k === 'sym') {
        out.push({ type: 'coefficient-in-power', span, path });
      }
      if (node.k === 'pow' && node.base.k === 'sym' && node.exp.k === 'num' && [2, 3].includes(Number(node.exp.v.n)) && R.isInt(node.exp.v)) {
        out.push({ type: 'power-as-product', span, path });
      }
    }
  });
  if (t !== null) {
    for (const [node, path] of walk(model.trees[t])) {
      if (node.k === 'call' && (node.arg.k === 'num' || (node.arg.k === 'neg' && node.arg.e.k === 'num'))) out.push({ type: 'input-sign', path });
    }
  }
  if (['value', 'solution'].includes(kind)) out.push({ type: 'no-divide' });
  if (['sum', 'product'].includes(kind)) out.push({ type: 'swap-aggregate' }, { type: 'one-root', which: 0 }, { type: 'one-root', which: 1 }, { type: 'signs-flipped' });
  if (['positive', 'negative', 'greatest', 'least'].includes(kind)) out.push({ type: 'other-root' }, { type: 'signs-flipped' });
  if (kind === 'value' && model.roles.includes('def')) out.push({ type: 'evaluate-instead' });
  out.push({ type: 'negate' });
  return out;
}

function withFlipped(tree, path) {
  const parentPath = path.slice(0, -2);
  const index = path[path.length - 1];
  return replaceAt(tree, parentPath, (add) => ({ ...add, items: add.items.map((it, i) => (i === index ? { ...it, neg: !it.neg } : it)) }));
}

/** The item written as a signed term, for explanations: "+ 5", "- 3x". */
function termTex(add, i) {
  const it = add.items[i];
  const t = toTex(it.e);
  return i === 0 ? (it.neg ? `-${t}` : t) : `${it.neg ? '-' : '+'} ${t}`;
}

/**
 * Apply one mistake to a model with the given trees. Returns
 * { value, why } or null when the mistake does not apply here or yields
 * nothing sensible. `ans` is the correct answer, `fix` the sentence that
 * resolves the question correctly.
 */
export function applyMistake(model, trees, mistake, ans, fix) {
  const correct = ans.value;
  const pieces = parts(model, trees);
  const target = pieces.target;
  const solved = ans.solved;
  const unknowns = solved?.unknowns || [];
  const sol = solved?.solutions?.[0];
  const say = (value, why) => (value === null || value === undefined ? null : { value, why: `${why} ${fix}` });
  switch (mistake.type) {
    case 'unknown': {
      // "This is the value of x, not x + 5."
      if (!target || target.k === 'sym' || !sol || unknowns.length === 0) return null;
      const out = [];
      for (const u of unknowns) {
        if (!sol || !(u in sol)) continue;
        out.push(say(sol[u], `This is the value of ${m(u)}, not of ${m(toTex(target))}.`));
      }
      return out.length ? out : null;
    }
    case 'target-sign': {
      const mutated = trees.map((tr, i) => (i === model.ask.targetSpan ? withFlipped(tr, mistake.path) : tr));
      const v = solveWith(model, mutated);
      return say(v, `This is the value of ${m(toTex(mutated[model.ask.targetSpan]))}, not of ${m(toTex(target))}.`);
    }
    case 'reciprocal': {
      const node = getAt(trees[model.ask.targetSpan], mistake.path);
      const mutated = trees.map((tr, i) => (i === model.ask.targetSpan ? replaceAt(tr, mistake.path, (d) => ({ ...d, num: d.den, den: d.num })) : tr));
      const v = solveWith(model, mutated);
      return say(v, `This is the value of ${m(toTex({ ...node, num: node.den, den: node.num }))}, the reciprocal of ${m(toTex(node))}.`);
    }
    case 'flip': {
      const add = getAt(trees[mistake.span], mistake.path.slice(0, -2));
      const i = mistake.path[mistake.path.length - 1];
      const mutated = trees.map((tr, s) => (s === mistake.span ? withFlipped(tr, mistake.path) : tr));
      const v = solveWith(model, mutated);
      const term = termTex(add, i);
      const flipped = termTex({ items: add.items.map((it, j) => (j === i ? { ...it, neg: !it.neg } : it)) }, i);
      return say(v, `This results from a sign error: it treats ${m(term.replace(/^\+ /, ''))} as ${m(flipped.replace(/^\+ /, ''))}.`);
    }
    case 'distribute': {
      const node = getAt(trees[mistake.span], mistake.path);
      const k = node.items[0];
      const inner = node.items[1].e;
      const first = inner.items[0];
      const wrong = { k: 'add', items: [{ neg: first.neg, e: { k: 'mul', items: [k, first.e], explicit: false } }, ...inner.items.slice(1)] };
      const mutated = trees.map((tr, s) => (s === mistake.span ? replaceAt(tr, mistake.path, () => ({ k: 'group', e: wrong })) : tr));
      const v = solveWith(model, mutated);
      return say(v, `This results from multiplying only the first term in ${m(toTex(node.items[1]))} by ${m(toTex(k))}.`);
    }
    case 'distribute-minus':
    case 'distribute-minus-item': {
      // -(a + b) read as -a + b: the minus reaches only the first term.
      let mutated;
      let shown;
      if (mistake.type === 'distribute-minus') {
        const node = getAt(trees[mistake.span], mistake.path);
        const inner = node.e.e;
        shown = toTex(node);
        mutated = trees.map((tr, s) => (s === mistake.span ? replaceAt(tr, mistake.path, () => ({ k: 'add', items: inner.items.map((it, j) => (j === 0 ? { ...it, neg: !it.neg } : it)) })) : tr));
      } else {
        const addPath = mistake.path.slice(0, -2);
        const i = mistake.path[mistake.path.length - 1];
        const add = getAt(trees[mistake.span], addPath);
        const inner = add.items[i].e.e;
        shown = `-${toTex(add.items[i].e)}`;
        mutated = trees.map((tr, s) => (s === mistake.span ? replaceAt(tr, addPath, (a) => ({
          ...a,
          items: [...a.items.slice(0, i), ...inner.items.map((it, j) => ({ neg: j === 0 ? !it.neg : it.neg, e: it.e })), ...a.items.slice(i + 1)],
        })) : tr));
      }
      const v = solveWith(model, mutated);
      return say(v, `This results from applying the negative sign in ${m(shown)} to the first term only.`);
    }
    case 'coefficient-in-power': {
      // 2x^{2} at x = 3 read as (2 * 3)^{2}.
      const node = getAt(trees[mistake.span], mistake.path);
      const [k, pw] = node.items;
      const wrong = { k: 'pow', base: { k: 'group', e: { k: 'mul', items: [k, pw.base], explicit: false } }, exp: pw.exp };
      const mutated = trees.map((tr, s) => (s === mistake.span ? replaceAt(tr, mistake.path, () => wrong) : tr));
      const v = solveWith(model, mutated);
      return say(v, `This results from multiplying by ${m(toTex(k))} before squaring, as if ${m(toTex(node))} were ${m(toTex(wrong))}.`);
    }
    case 'power-as-product': {
      // x^{2} read as 2x.
      const node = getAt(trees[mistake.span], mistake.path);
      const wrong = { k: 'group', e: { k: 'mul', items: [node.exp, node.base], explicit: false } };
      const mutated = trees.map((tr, s) => (s === mistake.span ? replaceAt(tr, mistake.path, () => wrong) : tr));
      const v = solveWith(model, mutated);
      return say(v, `This treats ${m(toTex(node))} as ${m(toTex(wrong.e))}, multiplying by the exponent instead of raising to the power.`);
    }
    case 'input-sign': {
      // f(-2) evaluated at 2.
      const node = getAt(trees[model.ask.targetSpan], mistake.path);
      const flipped = node.arg.k === 'neg' ? node.arg.e : { k: 'neg', e: node.arg };
      const mutated = trees.map((tr, s) => (s === model.ask.targetSpan ? replaceAt(tr, mistake.path, (c) => ({ ...c, arg: flipped })) : tr));
      const v = solveWith(model, mutated);
      return say(v, `This is the value of ${m(toTex({ ...node, arg: flipped }))}, not ${m(toTex(node))}: the input's sign was lost.`);
    }
    case 'keep-denominator': {
      // (x + 16)/5 = -19 solved as x + 16 = -19: the fraction never cleared.
      const node = getAt(trees[mistake.span], mistake.path);
      const mutated = trees.map((tr, s) => (s === mistake.span ? replaceAt(tr, mistake.path, () => ({ k: 'group', e: node.num })) : tr));
      const v = solveWith(model, mutated);
      return say(v, `This results from dropping the denominator ${m(toTex(node.den))} of ${m(toTex(node))} instead of multiplying both sides by it.`);
    }
    case 'no-divide': {
      // ax = b solved as x = b.
      if (unknowns.length !== 1 || pieces.relations.length !== 1) return null;
      const x = unknowns[0];
      const rel = inlineCalls(pieces.relations[0], pieces.defs);
      let poly;
      try {
        const l = P.fromTree(rel.l);
        const r = P.fromTree(rel.r);
        if (!P.isConstant(l.den) || !P.isConstant(r.den)) return null;
        poly = P.sub(P.scale(l.num, R.inv(P.constantValue(l.den))), P.scale(r.num, R.inv(P.constantValue(r.den))));
      } catch { return null; }
      const cs = P.univariate(poly, x);
      if (cs.length !== 2) return null;
      let a = cs[1];
      let b = R.neg(cs[0]);
      if (R.sign(a) < 0) { a = R.neg(a); b = R.neg(b); }
      if (R.eq(a, R.ONE) || !R.isInt(a)) return null;
      const wrongX = b;
      let v = wrongX;
      if (target && target.k !== 'sym') {
        try { v = evalQ(inlineCalls(target, pieces.defs), { [x]: wrongX }); } catch { return null; }
      }
      return say(v, `This comes from not dividing by ${m(num(a))} at the last step: ${m(`${num(a)}${x} = ${num(b)}`)} gives ${m(`${x} = ${num(R.div(b, a))}`)}.`);
    }
    case 'swap-aggregate': {
      const vs = solved.solutions.map((s) => s[unknowns[0]]);
      if (vs.length !== 2) return null;
      const kind = model.ask.kind;
      const v = kind === 'sum' ? R.mul(vs[0], vs[1]) : R.add(vs[0], vs[1]);
      return say(v, `This is the ${kind === 'sum' ? 'product' : 'sum'} of the solutions, not their ${kind}.`);
    }
    case 'one-root': {
      const vs = solved.solutions.map((s) => s[unknowns[0]]).sort(R.cmp);
      if (vs.length !== 2) return null;
      return say(vs[mistake.which], `This is only one of the two solutions, ${m(num(vs[mistake.which]))}.`);
    }
    case 'other-root': {
      const vs = solved.solutions.map((s) => s[unknowns[0]]);
      const others = vs.filter((v) => !R.eq(v, correct));
      if (others.length !== 1) return null;
      return say(others[0], `This is the other solution of the equation, which is not the one the question asks for.`);
    }
    case 'signs-flipped': {
      // Reading the roots off (x + 3)(x - 13) = 0 as -3's opposite: 3 and -13.
      const vs = solved.solutions.map((s) => R.neg(s[unknowns[0]]));
      if (!vs.length) return null;
      const kind = model.ask.kind;
      let v;
      if (kind === 'sum') v = vs.reduce(R.add, R.ZERO);
      else if (kind === 'product') return null;
      else if (kind === 'positive' || kind === 'greatest') v = vs.reduce((a, b) => (R.cmp(a, b) > 0 ? a : b));
      else v = vs.reduce((a, b) => (R.cmp(a, b) < 0 ? a : b));
      return say(v, `This uses solutions with the wrong signs: the solutions are ${solved.solutions.map((s) => m(num(s[unknowns[0]]))).join(' and ')}.`);
    }
    case 'evaluate-instead': {
      // f(a) = 28 misread as a = f(28).
      if (!target || target.k !== 'sym' || pieces.relations.length !== 1) return null;
      const rel = pieces.relations[0];
      if (rel.l.k !== 'call' || !pieces.defs[rel.l.f] || rel.l.arg.k !== 'sym' || rel.l.arg.name !== target.name) return null;
      let v;
      try { v = evalQ(inlineCalls({ k: 'call', f: rel.l.f, arg: rel.r }, pieces.defs)); } catch { return null; }
      return say(v, `This is the value of ${m(`${rel.l.f}(${toTex(rel.r)})`)}, not the input that gives ${m(`${rel.l.f}(${target.name}) = ${toTex(rel.r)}`)}.`);
    }
    case 'negate':
      return R.isZero(correct) ? null : say(R.neg(correct), 'This has the wrong sign.');
    default:
      return null;
  }
}

/** Every candidate wrong answer for one mistake, flattened. */
export function candidates(model, trees, mistake, ans, fix) {
  let got;
  try { got = applyMistake(model, trees, mistake, ans, fix); } catch { return []; }
  if (!got) return [];
  return (Array.isArray(got) ? got : [got]).filter(Boolean).map((c) => ({ ...c, mistake }));
}

/**
 * Which of the source's own distractors each mistake reproduces. Returns
 * the mistakes that explain at least one source distractor, in the order of
 * the source's choices.
 */
export function explainSource(model, ans, fix = '') {
  const found = [];
  const wrong = model.choices.map((c, i) => ({ c, i })).filter(({ i }) => i !== model.keyIdx);
  const all = mistakesFor(model);
  for (const { c } of wrong) {
    if (c.kind !== 'number') continue;
    for (const mistake of all) {
      const hit = candidates(model, model.trees, mistake, ans, fix).find((cand) => R.eq(cand.value, c.value));
      if (hit) { found.push(mistake); break; }
    }
  }
  return found;
}

/**
 * Three distinct wrong answers for a variant, preferring the mistakes the
 * source's own distractors came from. Returns null when three cannot be found.
 */
export function pickDistractors(model, trees, ans, fix, preferred = []) {
  const all = mistakesFor(model);
  const key = (mk) => JSON.stringify(mk);
  const order = [...preferred, ...all.filter((mk) => !preferred.some((p) => key(p) === key(mk)))];
  const chosen = [];
  const values = [ans.value];
  const limit = Math.max(50, R.toNumber(R.abs(ans.value)) * 10);
  for (const mistake of order) {
    for (const cand of candidates(model, trees, mistake, ans, fix)) {
      if (values.some((v) => R.eq(v, cand.value))) continue;
      if (Math.abs(R.toNumber(cand.value)) > limit) continue;
      if (cand.value.d > 1000n) continue;
      chosen.push(cand);
      values.push(cand.value);
      break;
    }
    if (chosen.length === 3) return chosen;
  }
  return null;
}


// ------------------------------------------------------------- expressions

/** An expression tree as a polynomial (constant denominators divided out), or null. */
function polyOf(tree, defs) {
  try {
    const r = P.fromTree(inlineCalls(tree, defs));
    if (!P.isConstant(r.den)) return null;
    return P.scale(r.num, R.inv(P.constantValue(r.den)));
  } catch { return null; }
}

const isBinomialGroup = (n) => n.k === 'group' && n.e.k === 'add' && n.e.items.length === 2;

/** Mistakes in expanding the target of an equivalence question. */
export function exprMistakesFor(model) {
  const out = [];
  const t = model.ask.targetSpan;
  if (t === null) return out;
  for (const [node, path] of walk(model.trees[t])) {
    if (node.k === 'mul' && node.items.length === 2 && node.items.every(isBinomialGroup)) {
      out.push({ type: 'first-last', path }, { type: 'one-cross', path, keep: 'outer' }, { type: 'one-cross', path, keep: 'inner' });
    }
    if (node.k === 'mul' && node.items.length === 2 && ['num', 'sym'].includes(node.items[0].k) && node.items[1].k === 'group' && node.items[1].e.k === 'add') {
      out.push({ type: 'distribute', path });
    }
    if (node.k === 'pow' && isBinomialGroup(node.base) && node.exp.k === 'num' && R.eq(node.exp.v, R.Q(2))) out.push({ type: 'square', path });
    if (node.k === 'add') {
      node.items.forEach((it, i) => {
        if (it.neg && it.e.k === 'group' && it.e.e.k === 'add') out.push({ type: 'minus-first', path: [...path, 'items', i] });
        if (it.e.k === 'mul' && it.e.items.length === 2 && it.e.items[0].k === 'num' && !R.eq(it.e.items[0].v, R.ONE)) out.push({ type: 'drop-coefficient', path: [...path, 'items', i] });
      });
    }
  }
  // Generic slips last, a sign before a dropped coefficient.
  const signs = [0, 1, 2, 3].map((which) => ({ type: 'term-sign', which }));
  const drops = out.filter((mk) => mk.type === 'drop-coefficient');
  return [...out.filter((mk) => mk.type !== 'drop-coefficient'), ...signs, ...drops];
}

const signedTex = (p, order) => toTex(P.toTree(p, order));

/** Apply one expansion mistake: { poly, why } or null. */
export function applyExprMistake(model, trees, mistake, ans, fix) {
  const span = model.ask.targetSpan;
  const target = trees[span];
  const { defs } = parts(model, trees);
  const order = ans.order || [];
  const keyPoly = ans.poly;
  const say = (poly, why) => (poly ? { poly, why: `${why} ${fix}` } : null);
  const node = mistake.path ? getAt(target, mistake.path) : null;
  const with_ = (fn) => polyOf(replaceAt(target, mistake.path, fn), defs);
  const termPolys = (group) => group.e.items.map(({ neg, e }) => { const q = polyOf(e, defs); return q && (neg ? P.neg(q) : q); });
  switch (mistake.type) {
    case 'first-last': {
      const [a, b] = termPolys(node.items[0]);
      const [c, d] = termPolys(node.items[1]);
      if (!a || !b || !c || !d) return null;
      const whole = polyOf(replaceAt(target, mistake.path, () => ({ k: 'num', v: R.ZERO })), defs);
      const own = P.add(P.mul(a, c), P.mul(b, d));
      if (!whole) return null;
      return say(P.add(whole, own), `This multiplies only the first terms and the last terms of ${m(toTex(node))}, leaving out the other two products.`);
    }
    case 'one-cross': {
      const [a, b] = termPolys(node.items[0]);
      const [c, d] = termPolys(node.items[1]);
      if (!a || !b || !c || !d) return null;
      const whole = polyOf(replaceAt(target, mistake.path, () => ({ k: 'num', v: R.ZERO })), defs);
      const missing = mistake.keep === 'outer' ? P.mul(b, c) : P.mul(a, d);
      const own = P.sub(P.mul(P.add(a, b), P.add(c, d)), missing);
      if (!whole) return null;
      return say(P.add(whole, own), `This leaves out the product ${m(signedTex(missing, order))} when multiplying ${m(toTex(node.items[0]))} by ${m(toTex(node.items[1]))}.`);
    }
    case 'distribute': {
      const k = node.items[0];
      const inner = node.items[1].e;
      const first = inner.items[0];
      const wrong = { k: 'group', e: { k: 'add', items: [{ neg: first.neg, e: { k: 'mul', items: [k, first.e], explicit: false } }, ...inner.items.slice(1)] } };
      return say(with_(() => wrong), `This multiplies only the first term in ${m(toTex(node.items[1]))} by ${m(toTex(k))}.`);
    }
    case 'square': {
      const [a, b] = termPolys(node.base);
      if (!a || !b) return null;
      const whole = polyOf(replaceAt(target, mistake.path, () => ({ k: 'num', v: R.ZERO })), defs);
      if (!whole) return null;
      return say(P.add(whole, P.add(P.mul(a, a), P.mul(b, b))), `This squares each term of ${m(toTex(node.base))} separately and leaves out the middle term.`);
    }
    case 'minus-first': {
      const addPath = mistake.path.slice(0, -2);
      const i = mistake.path[mistake.path.length - 1];
      const inner = node.e.e;
      const mutated = replaceAt(target, addPath, (a) => ({
        ...a,
        items: [...a.items.slice(0, i), ...inner.items.map((it, j) => ({ neg: j === 0 ? !it.neg : it.neg, e: it.e })), ...a.items.slice(i + 1)],
      }));
      return say(polyOf(mutated, defs), `This subtracts only the first term of ${m(toTex(node.e))}; the subtraction applies to every term inside the parentheses.`);
    }
    case 'drop-coefficient': {
      const coef = node.e.items[0];
      const mutated = replaceAt(target, mistake.path, (it) => ({ ...it, e: it.e.items[1] }));
      return say(polyOf(mutated, defs), `This leaves out the factor ${m(toTex(coef))} in ${m(toTex(node.e))}.`);
    }
    case 'term-sign': {
      const terms = [...keyPoly.values()].sort((x, y) => Object.values(y.m).reduce((s, e) => s + e, 0) - Object.values(x.m).reduce((s, e) => s + e, 0));
      const term = terms[mistake.which];
      if (!term || terms.length < 2) return null;
      const flipped = new Map(keyPoly);
      const monoKey = [...keyPoly.entries()].find(([, v]) => v === term)[0];
      flipped.set(monoKey, { m: term.m, c: R.neg(term.c) });
      const label = monoKey === '' ? 'constant term' : `${m(toTex(P.toTree(new Map([[monoKey, { m: term.m, c: R.ONE }]]), order)))}-term`;
      return say(flipped, `This has the wrong sign on the ${label}.`);
    }
    default:
      return null;
  }
}

/** Which mistakes reproduce the source's own expression distractors. */
export function explainSourceExpr(model, ans) {
  const found = [];
  const all = exprMistakesFor(model);
  model.choices.forEach((c, i) => {
    if (i === model.keyIdx || (c.kind !== 'expr' && c.kind !== 'number')) return;
    const tree = c.tree || { k: 'num', v: c.value };
    const target = polyOf(tree, {});
    if (!target) return;
    for (const mistake of all) {
      let got;
      try { got = applyExprMistake(model, model.trees, mistake, ans, ''); } catch { got = null; }
      if (got && P.equal(got.poly, target)) { found.push(mistake); break; }
    }
  });
  return found;
}

/** Three distinct wrong expressions, preferring the source's kinds of mistakes. */
export function pickExprDistractors(model, trees, ans, fix, preferred = []) {
  const all = exprMistakesFor(model);
  const key = (mk) => JSON.stringify(mk);
  const order = [...preferred, ...all.filter((mk) => !preferred.some((p) => key(p) === key(mk)))];
  const chosen = [];
  const polys = [ans.poly];
  for (const mistake of order) {
    let got;
    try { got = applyExprMistake(model, trees, mistake, ans, fix); } catch { got = null; }
    if (!got || polys.some((q) => P.equal(q, got.poly))) continue;
    chosen.push({ ...got, mistake });
    polys.push(got.poly);
    if (chosen.length === 3) return chosen;
  }
  return null;
}
