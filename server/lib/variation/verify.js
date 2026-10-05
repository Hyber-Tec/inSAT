// Independent verification of a finished variant.
//
// The generator solves exactly, with polynomial algebra. This check starts
// over from the variant's rendered text, as a student would see it, and works
// numerically instead: it re-reads the question, finds the solutions by
// scanning and bisection (or Cramer's rule for a linear system) in floating
// point, evaluates what is asked, and requires the keyed choice, and only
// that choice, to match. It also checks that every math span renders in KaTeX
// exactly as the engine understood it and that the item is well formed.

import katex from 'katex';
import * as R from './rational.js';
import { parse, toTex, evalF, inlineCalls, symbols, same } from './expr.js';
import { readQuestion, readChoice, NotUnderstood } from './model.js';
import { parts } from './solve.js';
import { itemProblems, MATH_SPAN } from '../itemChecks.js';

const TOL = 1e-7;
const close = (a, b) => Math.abs(a - b) <= TOL * Math.max(1, Math.abs(a), Math.abs(b));

/** Every \( \) span of a string renders in KaTeX without error. */
function renderProblems(text) {
  const out = [];
  for (const [, tex] of String(text).matchAll(MATH_SPAN)) {
    try { katex.renderToString(tex, { throwOnError: true, strict: 'ignore' }); } catch (err) { out.push(`KaTeX cannot render \\(${tex}\\): ${err.message.split('\n')[0]}`); }
  }
  return out;
}

// ---------------------------------------------------------- numeric solving

/** Grid for a one-variable scan: dense near zero, geometric further out. */
const GRID = (() => {
  const pts = new Set([0]);
  for (let i = 1; i <= 4000; i += 1) { pts.add(i / 200); pts.add(-i / 200); } // |x| <= 20 at 0.005
  for (let t = Math.log(20); t <= Math.log(1e6); t += 0.002) { pts.add(Math.exp(t)); pts.add(-Math.exp(t)); }
  return [...pts].sort((a, b) => a - b);
})();

function bisect(f, a, b) {
  let fa = f(a);
  for (let i = 0; i < 200; i += 1) {
    const mid = (a + b) / 2;
    const fm = f(mid);
    if (!Number.isFinite(fm)) return NaN;
    if (fm === 0) return mid;
    if ((fm < 0) === (fa < 0)) { a = mid; fa = fm; } else b = mid;
  }
  return (a + b) / 2;
}

/** Local minimum of |f| on [a, b] (golden section), for roots that touch zero. */
function touch(f, a, b) {
  const g = (x) => Math.abs(f(x));
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  for (let i = 0; i < 200; i += 1) {
    if (g(c) < g(d)) b = d; else a = c;
    c = b - phi * (b - a);
    d = a + phi * (b - a);
  }
  return (a + b) / 2;
}

/** Real roots of f on the grid's range, or 'all' when f vanishes everywhere. */
export function numericRoots(f) {
  const probes = [-7.31, -2.17, -0.53, 0.37, 1.91, 4.63, 11.3];
  const scale = Math.max(1, ...probes.map((x) => Math.abs(f(x))).filter(Number.isFinite));
  if (probes.every((x) => Math.abs(f(x)) <= 1e-9 * scale)) return 'all';
  const roots = [];
  const add = (x) => {
    if (!Number.isFinite(x)) return;
    const fx = Math.abs(f(x));
    // A sign change across a pole is not a root.
    const local = Math.max(1, Math.abs(f(x + 1e-3)), Math.abs(f(x - 1e-3)));
    if (!(fx <= 1e-7 * local) || !Number.isFinite(fx)) return;
    if (!roots.some((r) => Math.abs(r - x) <= 1e-6 * Math.max(1, Math.abs(x)))) roots.push(x);
  };
  let prevX = GRID[0];
  let prev = f(prevX);
  const vals = [prev];
  for (let i = 1; i < GRID.length; i += 1) {
    const x = GRID[i];
    const fx = f(x);
    vals.push(fx);
    if (fx === 0) add(x);
    else if (Number.isFinite(prev) && Number.isFinite(fx) && prev !== 0 && (prev < 0) !== (fx < 0)) add(bisect(f, prevX, x));
    prevX = x;
    prev = fx;
  }
  // Roots where f touches zero without crossing: local minima of |f|.
  for (let i = 1; i < GRID.length - 1; i += 1) {
    const [a, b, c] = [vals[i - 1], vals[i], vals[i + 1]].map(Math.abs);
    if (b <= a && b <= c && Number.isFinite(b) && (vals[i - 1] < 0) === (vals[i + 1] < 0)) add(touch(f, GRID[i - 1], GRID[i + 1]));
  }
  return roots.sort((a, b) => a - b);
}

/** Whether each g_i(x, y) is affine, judged at a few points. */
function affine(g) {
  const at = (x, y) => g(x, y);
  const o = at(0, 0);
  const dx = at(1, 0) - o;
  const dy = at(0, 1) - o;
  return [[2, 3], [-1.5, 4.25], [7, -2]].every(([x, y]) => close(at(x, y), o + dx * x + dy * y)) ? { o, dx, dy } : null;
}

/**
 * Numeric solutions of the relations: [{ name: value }], 'all', or throws
 * when the shape is beyond the numeric solver (the variant is then rejected).
 */
function numericSolutions(rels, fns, unknowns) {
  const gs = rels.map((rel) => {
    const l = inlineCalls(rel.l, fns);
    const r = inlineCalls(rel.r, fns);
    return (env) => evalF(l, env) - evalF(r, env);
  });
  if (unknowns.length === 1) {
    const [x] = unknowns;
    // Several equations in one unknown: roots of the first that satisfy the rest.
    const roots = numericRoots((v) => gs[0]({ [x]: v }));
    if (roots === 'all') {
      if (gs.length === 1) return 'all';
      throw new Error('numeric solver: identity among several equations');
    }
    return roots.filter((v) => gs.slice(1).every((g) => Math.abs(g({ [x]: v })) <= 1e-7 * Math.max(1, Math.abs(v)))).map((v) => ({ [x]: v }));
  }
  if (unknowns.length === 2 && gs.length === 2) {
    const [x, y] = unknowns;
    const lin = gs.map((g) => affine((a, b) => g({ [x]: a, [y]: b })));
    if (lin.every(Boolean)) {
      const [p, q] = lin;
      const det = p.dx * q.dy - q.dx * p.dy;
      if (Math.abs(det) < 1e-12) {
        // Parallel or the same line.
        const consistent = Math.abs(p.dx * q.o - q.dx * p.o) < 1e-9 && Math.abs(p.dy * q.o - q.dy * p.o) < 1e-9;
        return consistent ? 'all' : [];
      }
      return [{ [x]: (-p.o * q.dy + q.o * p.dy) / det, [y]: (-q.o * p.dx + p.o * q.dx) / det }];
    }
    // One equation solved for a variable: substitute and scan.
    for (let i = 0; i < 2; i += 1) {
      const rel = rels[i];
      for (const [side, other] of [['l', 'r'], ['r', 'l']]) {
        const s = rel[side];
        if (s.k !== 'sym' || !unknowns.includes(s.name) || symbols(rel[other]).has(s.name)) continue;
        const free = unknowns.find((u) => u !== s.name);
        const expr = inlineCalls(rel[other], fns);
        const g = gs[1 - i];
        const f = (v) => g({ [free]: v, [s.name]: evalF(expr, { [free]: v }) });
        const roots = numericRoots(f);
        if (roots === 'all') return 'all';
        return roots.map((v) => ({ [free]: v, [s.name]: evalF(expr, { [free]: v }) }));
      }
    }
  }
  if (unknowns.length === gs.length && unknowns.length <= 3) {
    // Linear systems of any size by elimination in floating point.
    const n = unknowns.length;
    const base = Object.fromEntries(unknowns.map((u) => [u, 0]));
    const rows = gs.map((g) => {
      const o = g(base);
      const coef = unknowns.map((u) => g({ ...base, [u]: 1 }) - o);
      const check = unknowns.map((u, i) => (i + 2) * 1.37);
      const env = Object.fromEntries(unknowns.map((u, i) => [u, check[i]]));
      if (!close(g(env), o + coef.reduce((s, c, i) => s + c * check[i], 0))) throw new Error('numeric solver: nonlinear system');
      return [...coef, -o];
    });
    for (let c = 0; c < n; c += 1) {
      let piv = c;
      for (let r = c + 1; r < n; r += 1) if (Math.abs(rows[r][c]) > Math.abs(rows[piv][c])) piv = r;
      if (Math.abs(rows[piv][c]) < 1e-12) throw new Error('numeric solver: singular system');
      [rows[c], rows[piv]] = [rows[piv], rows[c]];
      for (let r = 0; r < n; r += 1) {
        if (r === c) continue;
        const k = rows[r][c] / rows[c][c];
        for (let j = c; j <= n; j += 1) rows[r][j] -= k * rows[c][j];
      }
    }
    return [Object.fromEntries(unknowns.map((u, i) => [u, rows[i][n] / rows[i][i]]))];
  }
  throw new Error('numeric solver: unsupported system');
}

const numberOf = (choice) => (choice.kind === 'number' ? R.toNumber(choice.value) : null);

// Random points for checking two expressions are the same function.
const POINTS = [[1.37, -0.61, 2.29], [-2.43, 1.87, 0.73], [3.11, 2.57, -1.39], [0.59, -3.21, 1.63], [-1.13, 0.47, -2.71], [2.03, -1.79, 3.47]];

function sameFunction(a, b, vars, fns = {}) {
  const ai = inlineCalls(a, fns);
  const bi = inlineCalls(b, fns);
  let compared = 0;
  for (const pt of POINTS) {
    const env = Object.fromEntries(vars.map((v, i) => [v, pt[i % pt.length] + i * 0.11]));
    const x = evalF(ai, env);
    const y = evalF(bi, env);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    compared += 1;
    if (!close(x, y)) return false;
  }
  return compared >= 4;
}

// ------------------------------------------------------------------ verdict

/**
 * { verified, errors } for a finished variant in the engine's item shape.
 * `expect` is { askKind } from the source model: the variant must be read
 * as asking the same kind of question.
 */
export function verifyVariant(item, expect) {
  const errors = [...itemProblems(item)];
  for (const text of [item.question, ...(item.choices || []), ...Object.values(item.rationale || {})]) errors.push(...renderProblems(text));
  if (errors.length) return { verified: false, errors };

  let model;
  try { model = readQuestion(item); } catch (err) {
    if (err instanceof NotUnderstood) return { verified: false, errors: [`the variant cannot be re-read: ${err.message}`] };
    throw err;
  }
  if (model.ask.kind !== expect.askKind) return { verified: false, errors: [`the variant reads as a "${model.ask.kind}" question, not "${expect.askKind}"`] };
  // What KaTeX shows is what the engine solved: each span re-parses to the same tree.
  for (const [i, sp] of model.seg.spans.entries()) {
    try {
      if (!same(parse(toTex(model.trees[i]), { functions: model.functions }), model.trees[i])) errors.push(`span ${i} does not print back to itself`);
    } catch { errors.push(`span ${i} does not re-parse`); }
    void sp;
  }
  if (errors.length) return { verified: false, errors };

  try {
    const verdict = judge(model, item);
    return verdict;
  } catch (err) {
    return { verified: false, errors: [`independent check failed: ${err.message}`] };
  }
}

function judge(model, item) {
  const pieces = parts(model);
  const { defs, relations, conditions, identities, target } = pieces;
  const kind = model.ask.kind;
  const choices = item.answerType === 'grid-in' ? null : model.choices;
  const keyed = item.answerType === 'grid-in' ? R.toNumber(R.parse(item.answerText)) : null;
  const fail = (msg) => ({ verified: false, errors: [msg] });

  // Equivalent expressions: the same function at random points.
  if (kind === 'equivalent' || kind === 'equivalentAbove' || (kind === 'value' && !relations.length && !identities.length && symbols(inlineCalls(target, defs)).size)) {
    const vars = [...symbols(inlineCalls(target, defs))];
    const ok = choices.map((c) => {
      let tree = c.tree || (c.kind === 'number' ? { k: 'num', v: c.value } : null);
      if (c.kind === 'rel' && c.tree.k === 'rel' && same(c.tree.l, target)) tree = c.tree.r;
      return tree ? sameFunction(tree, target, vars, defs) : false;
    });
    return oneKeyed(ok, item, fail);
  }

  // A constant fixed by an identity or by a solution count.
  if (identities.length || (model.special && target?.k === 'sym' && model.constants.has(target.name))) {
    const k = target.name;
    const test = (value) => {
      if (identities.length) {
        return identities.every((id) => {
          const vars = [...symbols(id)].filter((v) => v !== k);
          if (vars.some((v) => model.constants.has(v))) throw new Error('an identity with several constants');
          return sameFunction(substituteNumber(id.l, k, value), substituteNumber(id.r, k, value), vars.length ? vars : ['x']);
        });
      }
      // Solution count with k fixed: count the solutions numerically.
      const rels = relations.map((r) => ({ ...r, l: substituteNumber(r.l, k, value), r: substituteNumber(r.r, k, value) }));
      const others = [...new Set(rels.flatMap((r) => [...symbols(r)]))];
      if (others.some((o) => model.constants.has(o))) throw new Error('several constants in a solution-count question');
      const sols = numericSolutions(rels, defs, others);
      return model.special === 'infinite' ? sols === 'all' : Array.isArray(sols) && sols.length === 0;
    };
    const values = item.answerType === 'grid-in' ? null : choices.map(numberOf);
    if (values) return oneKeyed(values.map((v) => v !== null && test(v)), item, fail);
    return test(keyed) ? { verified: true, errors: [] } : fail('the keyed value does not make the question true');
  }

  // Values of functions only.
  if (kind === 'value' && !relations.length) {
    const v = evalF(inlineCalls(target, defs), {});
    return compareNumber(v, item, choices, keyed, fail);
  }

  const unknowns = [...new Set(relations.flatMap((r) => [...symbols(inlineCalls(r, defs))]))].sort();
  let sols = numericSolutions(relations, defs, unknowns);
  if (sols === 'all') {
    if (kind === 'count') return countVerdict('infinite', item, choices, fail);
    return fail('infinitely many solutions');
  }
  // Conditions stated in the question (x > 0, a is positive).
  sols = sols.filter((s) => conditions.every((c) => conditionHolds(inlineCalls(c, defs), s))
    && [...model.constants].every(([name, sign]) => !sign || !(name in s) || Math.sign(s[name]) === sign));
  const xs = () => {
    if (unknowns.length !== 1) throw new Error('solutions of several unknowns');
    return sols.map((s) => s[unknowns[0]]).sort((a, b) => a - b);
  };
  switch (kind) {
    case 'count': return countVerdict(sols.length, item, choices, fail);
    case 'sum': return compareNumber(xs().reduce((a, b) => a + b, 0), item, choices, keyed, fail);
    case 'product': return compareNumber(xs().reduce((a, b) => a * b, 1), item, choices, keyed, fail);
    case 'greatest': { const v = xs(); return v.length ? compareNumber(v[v.length - 1], item, choices, keyed, fail) : fail('no solutions'); }
    case 'least': { const v = xs(); return v.length ? compareNumber(v[0], item, choices, keyed, fail) : fail('no solutions'); }
    case 'positive': case 'negative': {
      const v = xs().filter((x) => (kind === 'positive' ? x > 0 : x < 0));
      return v.length === 1 ? compareNumber(v[0], item, choices, keyed, fail) : fail(`${v.length} ${kind} solutions`);
    }
    case 'solution': {
      const v = xs();
      return v.length === 1 ? compareNumber(v[0], item, choices, keyed, fail) : fail(`${v.length} solutions`);
    }
    case 'value': {
      if (!sols.length) return fail('no solution');
      const t = inlineCalls(target, defs);
      const values = sols.map((s) => evalF(t, s));
      if (values.some((v) => !close(v, values[0]))) return fail('the target takes several values');
      return compareNumber(values[0], item, choices, keyed, fail);
    }
    default:
      return fail(`no independent check for "${kind}" questions`);
  }
}

function substituteNumber(tree, name, value) {
  const q = R.parse(String(value));
  const rep = (n) => {
    if (n.k === 'sym' && n.name === name) {
      const leaf = { k: 'num', v: R.abs(q), places: 0, commas: false };
      return { k: 'group', e: R.sign(q) < 0 ? { k: 'neg', e: leaf } : leaf };
    }
    const out = { ...n };
    for (const key of ['e', 'arg', 'num', 'den', 'base', 'exp', 'l', 'r', 'index']) if (n[key]) out[key] = rep(n[key]);
    if (n.items) out.items = n.items.map((it) => (n.k === 'add' ? { ...it, e: rep(it.e) } : rep(it)));
    return out;
  };
  return rep(tree);
}

function conditionHolds(c, env) {
  const ops = c.k === 'chain' ? c.ops : [c.op];
  const items = c.k === 'chain' ? c.items : [c.l, c.r];
  return ops.every((op, i) => {
    const a = evalF(items[i], env);
    const b = evalF(items[i + 1], env);
    return { '<': a < b, '>': a > b, '<=': a <= b + 1e-12, '>=': a >= b - 1e-12, '!=': !close(a, b), '=': close(a, b) }[op];
  });
}

/** Exactly one choice matches the value, and it is the keyed one (or the grid-in answer states it). */
function compareNumber(v, item, choices, keyed, fail) {
  if (!Number.isFinite(v)) return fail('the independent value is not a number');
  if (!choices) return close(v, keyed) ? { verified: true, errors: [] } : fail(`grid-in answer ${item.answerText}, independent value ${v}`);
  return oneKeyed(choices.map((c) => { const n = numberOf(c); return n !== null && close(n, v); }), item, fail, v);
}

function oneKeyed(ok, item, fail, v = null) {
  const hits = ok.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) return fail(`${hits.length} choices match the independent answer${v === null ? '' : ` ${v}`}`);
  if (hits[0] !== item.correctIdx) return fail(`the independent answer${v === null ? '' : ` ${v}`} matches choice ${hits[0]}, not the keyed ${item.correctIdx}`);
  return { verified: true, errors: [] };
}

const COUNT = [[/^(?:zero|no|none|there (?:are|is) no)\b/i, 0], [/^(?:exactly )?one\b/i, 1], [/^(?:exactly )?two\b/i, 2], [/^infinitely many\b/i, 'infinite']];
function countVerdict(n, item, choices, fail) {
  if (!choices) return fail('count question as a grid-in');
  const read = (c) => {
    if (c.kind === 'number' && R.isInt(c.value)) return Number(c.value.n);
    const t = String(c.text || '').trim();
    for (const [re, v] of COUNT) if (re.test(t)) return v;
    return null;
  };
  return oneKeyed(choices.map((c) => read(c) === n), item, fail);
}

export { readChoice };
