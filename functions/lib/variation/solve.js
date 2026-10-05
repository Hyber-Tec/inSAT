// Solve a model exactly and decide which choices its answer makes correct.
//
// Everything here is exact (rational arithmetic on polynomial forms). The
// independent check in verify.js re-reads the rendered question and works
// numerically instead, so the two can disagree when either is wrong.

import * as R from './rational.js';
import * as P from './poly.js';
import { walk, symbols, inlineCalls, replaceAt, evalQ, same, NotExact } from './expr.js';
import { NotUnderstood } from './model.js';

const refuse = (why) => { throw new NotUnderstood(why); };

/** The pieces of a model for one set of trees (the source's, or a variant's). */
export function parts(model, trees = model.trees) {
  const defs = {};
  const relations = [];
  const conditions = [];
  const identities = [];
  let left = null;
  model.roles.forEach((role, i) => {
    const t = trees[i];
    if (role === 'def') defs[t.l.f] = { param: t.l.arg.name, body: t.r };
    else if (role === 'rel') relations.push(t);
    else if (role === 'cond') conditions.push(t);
    else if (role === 'idl') left = t;
    else if (role === 'idr') { identities.push({ k: 'rel', op: '=', l: left, r: t }); left = null; }
  });
  const target = model.ask.targetSpan !== null ? trees[model.ask.targetSpan] : model.ask.targetSym ? { k: 'sym', name: model.ask.targetSym } : null;
  return { defs, relations, conditions, identities, target };
}

/** A relation l = r as a polynomial (numerators cross-multiplied) and its denominators. */
export function relationPoly(rel, fns = {}) {
  const l = P.fromTree(rel.l, {}, fns);
  const r = P.fromTree(rel.r, {}, fns);
  return { poly: P.sub(P.mul(l.num, r.den), P.mul(r.num, l.den)), dens: [l.den, r.den] };
}

/** Each way of dropping the absolute values in a relation: the relation and the sign each argument must have. */
function absCases(rel) {
  const found = [];
  for (const [n, path] of walk(rel)) if (n.k === 'abs') found.push(path);
  if (!found.length) return [{ rel, signs: [] }];
  if (found.length > 2) refuse('more than two absolute values');
  // Only outermost absolute values; nested ones are not supported.
  if (found.some((p, i) => found.some((q, j) => i !== j && p.length > q.length && q.every((k, idx) => p[idx] === k)))) refuse('nested absolute values');
  const cases = [];
  for (let mask = 0; mask < 1 << found.length; mask += 1) {
    let r = rel;
    const signs = [];
    found.forEach((path, i) => {
      const negative = Boolean(mask & (1 << i));
      const arg = walkGet(rel, path).e;
      signs.push({ arg, negative });
      r = replaceAt(r, path, () => (negative ? { k: 'neg', e: { k: 'group', e: arg } } : { k: 'group', e: arg }));
    });
    cases.push({ rel: r, signs });
  }
  return cases;
}
const walkGet = (n, path) => path.reduce((node, k) => node[k], n);

function holds(rel, env) {
  const a = evalQ(rel.l, env);
  const b = evalQ(rel.r, env);
  const c = R.cmp(a, b);
  return { '=': c === 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0, '!=': c !== 0 }[rel.op];
}

function chainHolds(chain, env) {
  return chain.ops.every((op, i) => holds({ op, l: chain.items[i], r: chain.items[i + 1] }, env));
}

/**
 * Values of the constants for which the relations have no solution or
 * infinitely many, in the other variables: one linear equation Ax + B = 0
 * (none: A = 0 and B != 0; infinite: A = B = 0), or two linear equations in
 * two variables (determinant 0, then inconsistent or dependent).
 */
function specialConstants(model, eqs, constants, kind) {
  const polys = eqs.map((r) => {
    const { poly, dens } = relationPoly(r);
    if (dens.some((d) => [...P.vars(d)].some((v) => !constants.has(v)))) refuse('variable denominators in a solution-count question');
    return poly;
  });
  const free = [...new Set(polys.flatMap((p) => [...P.vars(p)]))].filter((v) => !constants.has(v)).sort();
  if (free.length !== polys.length || free.length > 2) refuse('solution-count question of an unsupported shape');
  if (polys.some((p) => free.some((v) => P.degree(p, v) > 1))) refuse('solution-count question that is not linear');
  const at = (p, v, k) => P.coeffsIn(p, v)[k] || P.ZERO;
  const solveFor = (list) => {
    const vs = [...new Set(list.flatMap((p) => [...P.vars(p)]))];
    if (!vs.length) return list.every((p) => P.isZero(p)) ? [{}] : [];
    const res = P.solveSystem(list, vs);
    if (res.status === 'infinite') refuse('the constants are not determined');
    return res.status === 'solved' ? res.solutions : [];
  };
  const nonzeroAt = (p, sol) => { const v = P.substitute(p, sol); return !P.isConstant(v) || !R.isZero(P.constantValue(v)); };
  if (free.length === 1) {
    const [x] = free;
    const [p] = polys;
    const A = at(p, x, 1);
    const B = at(p, x, 0);
    if (kind === 'infinite') return solveFor([A, B].filter((q) => !P.isZero(q)));
    return solveFor([A].filter((q) => !P.isZero(q))).filter((sol) => nonzeroAt(B, sol));
  }
  const [x, y] = free;
  const [p, q] = polys;
  const [a1, b1, c1, a2, b2, c2] = [at(p, x, 1), at(p, y, 1), P.sub(P.ZERO, P.coeffsIn(P.coeffsIn(p, x)[0], y)[0] || P.ZERO),
    at(q, x, 1), at(q, y, 1), P.sub(P.ZERO, P.coeffsIn(P.coeffsIn(q, x)[0], y)[0] || P.ZERO)];
  const det = P.sub(P.mul(a1, b2), P.mul(a2, b1));
  const cx = P.sub(P.mul(a1, c2), P.mul(a2, c1));
  const cy = P.sub(P.mul(b1, c2), P.mul(b2, c1));
  const roots = solveFor([det].filter((d) => !P.isZero(d)));
  return roots.filter((sol) => {
    const inconsistent = nonzeroAt(cx, sol) || nonzeroAt(cy, sol);
    return kind === 'none' ? inconsistent : !inconsistent;
  });
}

/**
 * Every solution of the model's relations, as exact assignments.
 * Returns { unknowns, solutions, status } where status is 'solved', 'none'
 * or 'infinite' (the relations leave an unknown free).
 */
export function solveRelations(model, pieces) {
  const { defs, relations, identities, conditions, target } = pieces;
  // Constants are what an identity or a solution-count condition determines.
  const constants = new Set(model.constants.keys());
  if (target?.k === 'sym') constants.add(target.name);
  let eqs = relations.map((r) => inlineCalls(r, defs));
  let ids = identities.map((r) => inlineCalls(r, defs));
  const asksConstant = target?.k === 'sym' && constants.has(target.name) && model.ask.kind === 'value';
  if (model.special && asksConstant && eqs.length) {
    const sols = specialConstants(model, eqs, constants, model.special);
    return { unknowns: [...constants].filter((c) => sols.some((s) => c in s)), solutions: sols, status: sols.length ? 'solved' : 'none' };
  }
  // An identity holds for every value of its other variables: each
  // coefficient in those variables vanishes, which pins the constants down.
  const idPolys = [];
  for (const r of ids) {
    const { poly } = relationPoly(r);
    const free = [...P.vars(poly)].filter((v) => !constants.has(v));
    let coeffs = [poly];
    for (const v of free) coeffs = coeffs.flatMap((c) => P.coeffsIn(c, v));
    idPolys.push(...coeffs.filter((c) => !P.isZero(c)));
  }
  if (!eqs.length && !idPolys.length) refuse('no equation to solve');
  const inlined = eqs;
  const unknowns = [...new Set([...inlined.flatMap((r) => [...symbols(r)]), ...idPolys.flatMap((p) => [...P.vars(p)])])].sort();
  if (!unknowns.length) refuse('equations without unknowns');
  if (unknowns.length > 3) refuse('more than three unknowns');
  // Absolute values: solve every case, keep solutions consistent with it.
  const caseLists = inlined.map(absCases);
  if (caseLists.reduce((n, c) => n * c.length, 1) > 8) refuse('too many absolute-value cases');
  const combos = caseLists.reduce((acc, list) => acc.flatMap((prev) => list.map((c) => [...prev, c])), [[]]);
  const found = [];
  let infinite = false;
  for (const combo of combos) {
    let res;
    const polys = [...idPolys];
    const nonzero = [];
    for (const { rel } of combo) {
      const { poly, dens } = relationPoly(rel);
      polys.push(poly);
      nonzero.push(...dens);
    }
    try {
      res = P.solveSystem(polys, unknowns, { nonzero });
    } catch (err) {
      if (err instanceof P.NotPolynomial) refuse(err.message);
      throw err;
    }
    if (res.status === 'infinite') { infinite = true; continue; }
    if (res.status !== 'solved') continue;
    for (const sol of res.solutions) {
      const consistent = combo.every(({ signs }) => signs.every(({ arg, negative }) => {
        const v = evalQ(arg, sol);
        return negative ? R.sign(v) <= 0 : R.sign(v) >= 0;
      }));
      if (consistent) found.push(sol);
    }
  }
  if (infinite) {
    if (combos.length > 1) refuse('absolute value with infinitely many solutions');
    return { unknowns, solutions: [], status: 'infinite' };
  }
  // Conditions from the question: inequalities and declared signs.
  const kept = found.filter((sol) => {
    for (const c of conditions) {
      try {
        const inl = inlineCalls(c, defs);
        if (!(inl.k === 'chain' ? chainHolds(inl, sol) : holds(inl, sol))) return false;
      } catch (err) {
        if (err instanceof NotExact) refuse('condition cannot be checked exactly');
        throw err;
      }
    }
    for (const [name, sign] of model.constants) if (sign && name in sol && R.sign(sol[name]) !== sign) return false;
    return true;
  });
  const seen = new Set();
  const solutions = kept.filter((s) => {
    const k = unknowns.map((u) => R.key(s[u])).join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { unknowns, solutions, status: solutions.length ? 'solved' : 'none' };
}

/**
 * The answer to the model's question.
 *   { type: 'number', value }            one value
 *   { type: 'set', values }              every solution (ascending)
 *   { type: 'count', value }             0, 1, 2 ... or 'infinite'
 *   { type: 'none' }                     no value satisfies the question
 *   { type: 'expr', rat, tree }          the target, for equivalence asks
 */
export function answer(model, trees = model.trees) {
  const pieces = parts(model, trees);
  const { kind } = model.ask;
  if (kind === 'equivalent' || kind === 'equivalentAbove') {
    if (!pieces.target) refuse('nothing to be equivalent to');
    if (pieces.relations.length || pieces.conditions.length > 1) refuse('equivalence with extra relations');
    const inl = inlineCalls(pieces.target, pieces.defs);
    try { return { type: 'expr', rat: P.fromTree(inl), tree: pieces.target }; } catch (err) {
      if (err instanceof P.NotPolynomial) refuse(err.message);
      throw err;
    }
  }
  if (kind === 'value' && !pieces.relations.length && !pieces.identities.length) {
    if (!pieces.target) refuse('nothing asked');
    const t = inlineCalls(pieces.target, pieces.defs);
    if (!symbols(t).size) {
      try { return { type: 'number', value: evalQ(t), solved: { unknowns: [], solutions: [{}], status: 'solved' } }; } catch (err) {
        if (err instanceof NotExact) refuse(`not exact: ${err.message}`);
        throw err;
      }
    }
    // "What is h(x + 3)?": the answer is an expression.
    try { return { type: 'expr', rat: P.fromTree(t), tree: pieces.target }; } catch (err) {
      if (err instanceof P.NotPolynomial) refuse(err.message);
      throw err;
    }
  }
  const solved = solveRelations(model, pieces);
  const { unknowns, solutions, status } = solved;
  const single = () => {
    if (unknowns.length !== 1) refuse('solutions asked of more than one unknown');
    return unknowns[0];
  };
  const values = () => {
    const v = single();
    return solutions.map((s) => s[v]).sort(R.cmp);
  };
  switch (kind) {
    case 'count': {
      if (status === 'infinite') return { type: 'count', value: 'infinite', solved };
      single();
      return { type: 'count', value: solutions.length, solved };
    }
    case 'sum': case 'product': case 'positive': case 'negative': case 'greatest': case 'least': case 'all': case 'one': case 'solution': {
      if (status === 'infinite') refuse('infinitely many solutions');
      const vs = values();
      if (!vs.length) return { type: 'none', solved };
      if (kind === 'sum') return { type: 'number', value: vs.reduce(R.add, R.ZERO), solved };
      if (kind === 'product') return { type: 'number', value: vs.reduce(R.mul, R.ONE), solved };
      if (kind === 'all' || kind === 'one') return { type: 'set', values: vs, solved };
      if (kind === 'greatest') return { type: 'number', value: vs[vs.length - 1], solved };
      if (kind === 'least') return { type: 'number', value: vs[0], solved };
      if (kind === 'solution') {
        if (vs.length !== 1) refuse('"the solution" of an equation with several');
        return { type: 'number', value: vs[0], solved };
      }
      const pick = vs.filter((v) => R.sign(v) === (kind === 'positive' ? 1 : -1));
      if (pick.length !== 1) refuse(`not exactly one ${kind} solution`);
      return { type: 'number', value: pick[0], solved };
    }
    case 'value': {
      if (status === 'infinite') refuse('value asked of an underdetermined system');
      if (status === 'none') return { type: 'none', solved };
      const t = inlineCalls(pieces.target, pieces.defs);
      const extra = [...symbols(t)].filter((s) => !unknowns.includes(s));
      if (extra.length) refuse(`target uses ${extra.join(', ')}, which no equation determines`);
      let value = null;
      for (const s of solutions) {
        let v;
        try { v = evalQ(t, s); } catch (err) {
          if (err instanceof NotExact) refuse(`target not exact: ${err.message}`);
          throw err;
        }
        if (value && !R.eq(value, v)) refuse('the target takes more than one value');
        value = v;
      }
      return { type: 'number', value, solved };
    }
    case 'mustBeTrue': case 'sameSolution':
      if (status !== 'solved') refuse(`${kind} for a system that is not solved`);
      return { type: 'solutions', solved };
    default:
      return refuse(`ask "${kind}" not supported yet`);
  }
}

// ------------------------------------------------------------ choice truth

const COUNT_WORDS = [
  [/^(?:zero|no|none|there (?:are|is) no)\b/i, 0],
  [/^(?:exactly )?one\b/i, 1],
  [/^(?:exactly )?two\b/i, 2],
  [/^(?:exactly )?three\b/i, 3],
  [/^infinitely many\b/i, 'infinite'],
];

function countOf(choice) {
  if (choice.kind === 'number' && R.isInt(choice.value)) return Number(choice.value.n);
  if (choice.kind !== 'text') return null;
  const t = choice.text.trim();
  for (const [re, v] of COUNT_WORDS) if (re.test(t)) return v;
  return null;
}

const NONE_TEXT = /\bno (?:value|solution|real solution)s?\b|\bthere is no\b/i;
const INFINITE_TEXT = /\binfinitely many\b/i;

/** Solution set a choice states: "x = -7 and x = 1", "-7 and 1", "x = 3". */
function choiceSet(choice, variable) {
  if (choice.kind === 'number') return [choice.value];
  const rels = choice.kind === 'rels' ? choice.trees : choice.kind === 'rel' ? [choice.tree] : null;
  if (rels) {
    const out = [];
    for (const r of rels) {
      if (r.k !== 'rel' || r.op !== '=' || r.l.k !== 'sym' || (variable && r.l.name !== variable)) return null;
      try { out.push(evalQ(r.r)); } catch { return null; }
    }
    return out;
  }
  if (choice.kind === 'text' && choice.trees && /^[\s\d,and−\-.⟦⟧]*$/.test(choice.text.replace(/\\\(|\\\)|\\frac\{\d+\}\{\d+\}/g, ''))) {
    try { return choice.trees.map((t) => evalQ(t)); } catch { return null; }
  }
  return null;
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.some((y) => R.eq(x, y)));

/** Indices of the choices the answer makes correct. */
export function correctChoices(model, ans, choices = model.choices) {
  const out = [];
  choices.forEach((c, i) => {
    if (choiceIsCorrect(model, ans, c)) out.push(i);
  });
  return out;
}

function choiceIsCorrect(model, ans, c) {
  switch (ans.type) {
    case 'number':
      if (c.kind === 'number') return R.eq(c.value, ans.value);
      return false;
    case 'none':
      return c.kind === 'text' && NONE_TEXT.test(c.text);
    case 'count': {
      const v = countOf(c);
      return v !== null && v === ans.value;
    }
    case 'set': {
      const var0 = ans.solved.unknowns[0];
      const set = choiceSet(c, var0);
      if (!set) return false;
      return model.ask.kind === 'one' ? set.length === 1 && ans.values.some((v) => R.eq(v, set[0])) : sameSet(set, ans.values);
    }
    case 'expr': {
      let tree = c.kind === 'expr' ? c.tree : c.kind === 'number' ? (c.tree || { k: 'num', v: c.value }) : null;
      // "h(x + 3) = 2x^{2} + 5x - 6" states the target's value on its right.
      if (!tree && c.kind === 'rel' && c.tree.k === 'rel' && c.tree.op === '=' && same(c.tree.l, ans.tree)) tree = c.tree.r;
      if (!tree) return false;
      try { return P.ratEqual(P.fromTree(tree), ans.rat); } catch { return false; }
    }
    case 'solutions': {
      const sols = ans.solved.solutions;
      if (model.ask.kind === 'mustBeTrue') {
        if (c.kind !== 'rel' || c.tree.k !== 'rel') return false;
        try { return sols.every((s) => holds(c.tree, s)); } catch { return false; }
      }
      // sameSolution: the choice equation has exactly the question's solutions.
      if (c.kind !== 'rel' || c.tree.k !== 'rel' || c.tree.op !== '=') return false;
      try {
        const { poly, dens } = relationPoly(c.tree);
        const res = P.solveSystem([poly], ans.solved.unknowns, { nonzero: dens });
        if (res.status !== 'solved') return false;
        const key = (s) => ans.solved.unknowns.map((u) => R.key(s[u])).join('|');
        return res.solutions.length === sols.length && res.solutions.every((s) => sols.some((t) => key(s) === key(t)));
      } catch { return false; }
    }
    default:
      return false;
  }
}

/** Whether a grid-in entry states the answer exactly (or as the SAT's decimal entry). */
export function gridStates(ans, text, accepted = []) {
  const entries = [text, ...(accepted || [])].filter((e) => e !== null && e !== undefined && String(e).trim());
  const values = ans.type === 'number' ? [ans.value] : ans.type === 'set' ? ans.values : [];
  if (!values.length) return false;
  return entries.length > 0 && entries.every((e) => {
    let q;
    try { q = R.parse(String(e).replace(/\s+/g, '').replace(/[−]/g, '-').replace(/(\d),(?=\d{3}\b)/g, '$1')); } catch { return false; }
    return values.some((v) => R.eq(q, v) || gridApprox(v).includes(R.toDecimal(q) ?? ''));
  });
}

/** Decimal entries the SAT accepts for a value that does not fit exactly: rounded or truncated to fill the grid. */
export function gridApprox(v) {
  const out = new Set();
  const width = R.sign(v) < 0 ? 6 : 5;
  const intDigits = R.abs(v).n / R.abs(v).d;
  const room = width - (R.sign(v) < 0 ? 1 : 0) - String(intDigits).length - 1;
  for (let places = 1; places <= Math.max(1, room); places += 1) {
    out.add(R.approx(v, places, 'round'));
    out.add(R.approx(v, places, 'trunc'));
  }
  return [...out].map((s) => s.replace(/^(-?)0\./, '$1.')).concat([...out]);
}
