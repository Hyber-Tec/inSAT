// New numbers for an understood question.
//
// The numbers written in a question's math are its parameters. A variant keeps
// every tree exactly as written and changes only those numbers, each within a
// range around the original (a one-digit coefficient stays small, 22.80 keeps
// its cents, a multiple of 5 stays one), so the variant asks the same thing at
// the same difficulty. It is kept only when its answer has the source answer's
// shape: an integer stays an integer, a positive answer stays positive, the
// number of solutions is unchanged, and nothing grows out of proportion.

import * as R from './rational.js';
import * as P from './poly.js';
import { walk, same, getAt } from './expr.js';

/**
 * The parameters of a model: every number in its trees except exponents,
 * root indices and zeros. Numbers inside two copies of one subexpression
 * ("-7(13 - 5x) + 3 = -8(13 - 5x) + 21") move together, and so do numbers the
 * target shares with the givens ("if x/16 = 6, what is 16/x?"), since the
 * question often turns on that repetition.
 * Returns { params: [{ id, value, places, commas, sites }], siteParam: Map }.
 */
export function findParams(model) {
  const sites = []; // { span, path, node }
  model.trees.forEach((tree, span) => {
    for (const [node, path] of walk(tree)) {
      if (node.k !== 'num' || R.isZero(node.v)) continue;
      if (path.includes('exp') || path.includes('index')) continue;
      sites.push({ span, path, node });
    }
  });
  // Union-find over sites.
  const parent = sites.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const siteIndex = new Map(sites.map((s, i) => [`${s.span}:${s.path.join('.')}`, i]));

  // 1) Repeated nontrivial subtrees: tie corresponding numbers.
  const subtrees = [];
  model.trees.forEach((tree, span) => {
    for (const [node, path] of walk(tree)) {
      if (['add', 'mul', 'div', 'group', 'abs'].includes(node.k)) subtrees.push({ span, path, node });
    }
  });
  for (let i = 0; i < subtrees.length; i += 1) {
    for (let j = i + 1; j < subtrees.length; j += 1) {
      const a = subtrees[i];
      const b = subtrees[j];
      if (!same(a.node, b.node)) continue;
      for (const [n, rel] of walk(a.node)) {
        if (n.k !== 'num') continue;
        const x = siteIndex.get(`${a.span}:${[...a.path, ...rel].join('.')}`);
        const y = siteIndex.get(`${b.span}:${[...b.path, ...rel].join('.')}`);
        if (x !== undefined && y !== undefined) union(x, y);
      }
    }
  }
  // 2) Numbers in the target equal to a number in the givens.
  const t = model.ask.targetSpan;
  if (t !== null) {
    sites.forEach((s, i) => {
      if (s.span !== t) return;
      sites.forEach((o, j) => { if (o.span !== t && R.eq(o.node.v, s.node.v)) union(i, j); });
    });
  }
  const groups = new Map();
  sites.forEach((s, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(s);
  });
  const params = [...groups.values()].map((list, id) => {
    const first = list[0].node;
    return {
      id,
      value: first.v,
      places: Math.max(...list.map((s) => s.node.places || 0)),
      commas: list.some((s) => s.node.commas),
      sites: list.map(({ span, path }) => ({ span, path })),
    };
  });
  return { params };
}

/** Trees with parameter values replaced. */
export function instantiate(model, params, values) {
  const trees = model.trees.map((t) => structuredClone(t));
  params.forEach((p, i) => {
    for (const { span, path } of p.sites) {
      const node = getAt(trees[span], path);
      node.v = values[i];
    }
  });
  return trees;
}

// ------------------------------------------------------------------ ranges

/**
 * A new value for one parameter. Whole numbers stay whole, in a band around
 * the original: 2-12 for small numbers, and within about half to double the
 * size for larger ones. A multiple of 5 or 10 stays a multiple, so round
 * prices and percents stay round. A decimal keeps its number of places.
 */
export function draw(param, r) {
  const v = param.value;
  const places = param.places || 0;
  const scale = 10 ** places;
  const units = Math.round(R.toNumber(v) * scale);
  if (!R.isInt(R.mul(v, R.Q(scale)))) {
    // A literal that is not a terminating decimal cannot occur; keep it.
    return v;
  }
  let lo;
  let hi;
  if (places && units < 2 * scale) {
    // Below 2, a decimal keeps its whole part: a growth factor of 1.03 must
    // not become a decay factor of 0.82, nor 0.4 a whole number.
    const whole = Math.floor(units / scale) * scale;
    const frac = units - whole;
    lo = whole + Math.max(1, Math.floor(frac * 0.5));
    hi = Math.min(whole + scale - 1, whole + Math.max(frac * 2, frac + 2));
  } else if (units <= 1) { lo = 1; hi = 4; } else if (units <= 12) { lo = 2; hi = 12; } else { lo = Math.max(2, Math.floor(units * 0.5)); hi = Math.ceil(units * 1.6); }
  let step = 1;
  if (units >= 20 && units % 10 === 0) step = 10;
  else if (units >= 10 && units % 5 === 0) step = 5;
  // Money written with a zero in the last place (22.80) keeps it.
  if (places >= 1 && units % 10 === 0 && step === 1) step = 10;
  const k = Math.max(lo, Math.ceil(lo / step) * step);
  const count = Math.floor((hi - k) / step) + 1;
  if (count <= 1) return v;
  for (let tries = 0; tries < 8; tries += 1) {
    const pick = k + step * r.int(0, count - 1);
    // A decimal stays a decimal: 2.5 must not come out as 3.0.
    if (places && pick % scale === 0 && units % scale !== 0) continue;
    return R.Q(BigInt(pick), BigInt(scale));
  }
  return v;
}

/**
 * New values for every parameter. Parameters that differ in the source are
 * drawn so they differ here too, rather than rejecting the collision later.
 */
export function drawAll(params, r) {
  const values = [];
  params.forEach((p, i) => {
    let v = draw(p, r);
    for (let t = 0; t < 16 && values.some((w, j) => R.eq(w, v) && !R.eq(params[j].value, p.value)); t += 1) v = draw(p, r);
    values.push(v);
  });
  return values;
}

// -------------------------------------------------------------- the shapes

/** Largest absolute coefficient anywhere in an answer's work, as a size guard. */
function magnitude(q) { return Math.abs(R.toNumber(q)); }

/** The shape of one number: integer or not, its sign, its denominator, its size. */
export function shape(q) {
  return {
    int: R.isInt(q),
    sign: R.sign(q),
    den: Number(q.d),
    places: R.decimalPlaces(q),
    size: magnitude(q),
  };
}

/**
 * Whether a variant's value keeps the source's shape. Fractions stay
 * fractions with a small denominator; terminating decimals keep no more
 * places than the source; sizes stay within a factor of the original.
 */
export function sameShape(src, out) {
  const a = shape(src);
  const b = shape(out);
  if (a.int !== b.int || a.sign !== b.sign) return false;
  if (!a.int) {
    if (b.den > Math.max(12, a.den * 2)) return false;
    if ((a.places === null) !== (b.places === null)) return false;
    if (a.places !== null && b.places > Math.max(a.places, 1)) return false;
  }
  const limit = Math.max(20, a.size * 4);
  return b.size <= limit && (a.size < 2 || b.size >= Math.min(a.size / 5, 2));
}

/** The size of the numbers a solver meets: every coefficient of every relation, cleared. */
export function workSize(polys) {
  let max = 0;
  for (const p of polys) for (const { c } of p.values()) max = Math.max(max, Math.abs(R.toNumber(c)));
  return max;
}

export { P };

// ------------------------------------------------------------ invariants

const gcdBig = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };

/**
 * Numbers that differ in the source differ in the variant. Otherwise a draw
 * can put the same number in two places by chance, "4p - (2p - 3p)" becoming
 * "7p - (7p - 8p)", and the question reads differently than it was written.
 */
export function keepsDistinct(params, values) {
  for (let i = 0; i < params.length; i += 1) {
    for (let j = i + 1; j < params.length; j += 1) {
      if (!R.eq(params[i].value, params[j].value) && R.eq(values[i], values[j])) return false;
    }
  }
  return true;
}

/** The literal coefficient multiplying a whole numerator: 5 in 5(2 - x), 3 in 3, else 1. */
function leadCoefficient(n) {
  if (n.k === 'num') return n.v;
  if (n.k === 'mul' && n.items[0].k === 'num') return n.items[0].v;
  return R.ONE;
}

/**
 * Written fractions keep their character: a fraction in lowest terms stays in
 * lowest terms (3/4 never becomes 7/7 or 2/10), a proper fraction stays
 * proper, and a coefficient over a denominator ("5(2 - x)/10") shares a
 * factor with it only when the source's did.
 */
export function fractionsKeepShape(srcTrees, trees) {
  for (let t = 0; t < trees.length; t += 1) {
    const a = [...walk(srcTrees[t])];
    const b = [...walk(trees[t])];
    for (let i = 0; i < a.length; i += 1) {
      const [x] = a[i];
      const [y] = b[i];
      if (x.k !== 'div' || x.den.k !== 'num') continue;
      const cx = leadCoefficient(x.num);
      const cy = leadCoefficient(y.num);
      const dx = x.den.v;
      const dy = y.den.v;
      if (!R.isInt(cx) || !R.isInt(dx) || !R.isInt(cy) || !R.isInt(dy)) continue;
      const reducedX = gcdBig(cx.n, dx.n) === 1n;
      const reducedY = gcdBig(cy.n, dy.n) === 1n;
      if (reducedX && !reducedY) return false;
      if (x.num.k === 'num') {
        const vx = R.div(cx, dx);
        const vy = R.div(cy, dy);
        if (R.isInt(vx) !== R.isInt(vy)) return false;
        if ((R.cmp(R.abs(vx), R.ONE) < 0) !== (R.cmp(R.abs(vy), R.ONE) < 0)) return false;
      }
    }
  }
  return true;
}

/**
 * The monomials a relation has once expanded stay the same: a source whose
 * equation has no x-term ("(x - 5)(x + 5) = 11") keeps having none, so a
 * difference of squares stays one.
 */
export function sameMonomials(srcPolys, polys) {
  if (srcPolys.length !== polys.length) return false;
  return srcPolys.every((p, i) => {
    const q = polys[i];
    if (p.size !== q.size) return false;
    for (const k of p.keys()) if (!q.has(k)) return false;
    return true;
  });
}

/**
 * How a linear target relates to the side of a linear equation it comes
 * from: target = k * side + c. "8x + 7 = 79, what is 80x + 70?" has k = 10,
 * c = 0, and the question turns on seeing that; a variant must keep k whole
 * when it was whole, c zero when it was zero, and k's sign.
 */
export function linearLink(targetPoly, sidePoly, x) {
  const t = P.coeffsIn(targetPoly, x);
  const s = P.coeffsIn(sidePoly, x);
  if (t.length !== 2 || s.length !== 2 || !P.isConstant(t[1]) || !P.isConstant(s[1]) || !P.isConstant(t[0]) || !P.isConstant(s[0])) return null;
  const k = R.div(P.constantValue(t[1]), P.constantValue(s[1]));
  const c = R.sub(P.constantValue(t[0]), R.mul(k, P.constantValue(s[0])));
  return { kWhole: R.isInt(k), kSign: R.sign(k), cZero: R.isZero(c) };
}
