// Exact polynomials and rational functions in several variables, and the
// solving the engine needs: roots of a polynomial in one variable, linear and
// substitution-solvable systems, and identities ("for all x").
//
// A polynomial is a Map from a monomial key ("x^2*y", "" for the constant) to
// { m: { x: 2, y: 1 }, c: rational }. A rational function is { num, den }.

import * as R from './rational.js';
import { NotExact } from './expr.js';

export class NotPolynomial extends Error {}

const monoKey = (m) => Object.keys(m).filter((v) => m[v]).sort()
  .map((v) => (m[v] === 1 ? v : `${v}^${m[v]}`)).join('*');

function put(p, m, c) {
  if (R.isZero(c)) return;
  const k = monoKey(m);
  const prev = p.get(k);
  const sum = prev ? R.add(prev.c, c) : c;
  if (R.isZero(sum)) p.delete(k);
  else p.set(k, { m: prev ? prev.m : { ...m }, c: sum });
}

export const constant = (q) => { const p = new Map(); put(p, {}, q); return p; };
export const variable = (name) => { const p = new Map(); put(p, { [name]: 1 }, R.ONE); return p; };
export const ZERO = new Map();

export function add(a, b) {
  const out = new Map();
  for (const { m, c } of a.values()) put(out, m, c);
  for (const { m, c } of b.values()) put(out, m, c);
  return out;
}
export const scale = (a, q) => { const out = new Map(); for (const { m, c } of a.values()) put(out, m, R.mul(c, q)); return out; };
export const neg = (a) => scale(a, R.Q(-1));
export const sub = (a, b) => add(a, neg(b));

export function mul(a, b) {
  const out = new Map();
  for (const x of a.values()) {
    for (const y of b.values()) {
      const m = { ...x.m };
      for (const [v, e] of Object.entries(y.m)) m[v] = (m[v] || 0) + e;
      if (Object.values(m).some((e) => e > 12)) throw new NotPolynomial('degree too high');
      put(out, m, R.mul(x.c, y.c));
    }
  }
  return out;
}

export function pow(a, k) {
  if (!Number.isInteger(k) || k < 0 || k > 12) throw new NotPolynomial('unsupported power');
  let out = constant(R.ONE);
  for (let i = 0; i < k; i += 1) out = mul(out, a);
  return out;
}

export const isZero = (a) => a.size === 0;
export const isConstant = (a) => a.size === 0 || (a.size === 1 && a.has(''));
export const constantValue = (a) => (a.get('')?.c) || R.ZERO;
export const equal = (a, b) => isZero(sub(a, b));

export function vars(a) {
  const out = new Set();
  for (const { m } of a.values()) for (const v of Object.keys(m)) out.add(v);
  return out;
}

export function degree(a, v) {
  let d = 0;
  for (const { m } of a.values()) d = Math.max(d, m[v] || 0);
  return d;
}

export function totalDegree(a) {
  let d = 0;
  for (const { m } of a.values()) d = Math.max(d, Object.values(m).reduce((s, e) => s + e, 0));
  return d;
}

/** Coefficients of `a` as a polynomial in v: out[k] multiplies v^k (each a polynomial in the rest). */
export function coeffsIn(a, v) {
  const out = Array.from({ length: degree(a, v) + 1 }, () => new Map());
  for (const { m, c } of a.values()) {
    const k = m[v] || 0;
    const rest = { ...m };
    delete rest[v];
    put(out[k], rest, c);
  }
  return out;
}

/** Substitute polynomials (or rationals) for variables. */
export function substitute(a, map) {
  let out = new Map();
  for (const { m, c } of a.values()) {
    let term = constant(c);
    for (const [v, e] of Object.entries(m)) {
      const val = map[v];
      const base = val === undefined ? variable(v) : val instanceof Map ? val : constant(val);
      term = mul(term, pow(base, e));
    }
    out = add(out, term);
  }
  return out;
}

export function evaluate(a, env) {
  const out = substitute(a, env);
  if (!isConstant(out)) throw new NotExact('unbound variables');
  return constantValue(out);
}

/** Univariate coefficient list (rationals, index = power) when only v occurs. */
export function univariate(a, v) {
  const extra = [...vars(a)].filter((x) => x !== v);
  if (extra.length) throw new NotPolynomial(`more than one unknown: ${[v, ...extra].join(', ')}`);
  return coeffsIn(a, v).map(constantValue);
}

// ------------------------------------------------------- rational functions

const RONE = () => constant(R.ONE);
export const rat = (num, den = RONE()) => ({ num, den });

export function ratAdd(a, b) { return rat(add(mul(a.num, b.den), mul(b.num, a.den)), mul(a.den, b.den)); }
export function ratSub(a, b) { return rat(sub(mul(a.num, b.den), mul(b.num, a.den)), mul(a.den, b.den)); }
export function ratMul(a, b) { return rat(mul(a.num, b.num), mul(a.den, b.den)); }
export function ratDiv(a, b) {
  if (isZero(b.num)) throw new NotPolynomial('division by zero');
  return rat(mul(a.num, b.den), mul(a.den, b.num));
}
export function ratPow(a, k) {
  if (k < 0) return ratPow(ratDiv(rat(RONE()), a), -k);
  return rat(pow(a.num, k), pow(a.den, k));
}
/** a == b as rational functions (cross-multiplied). */
export const ratEqual = (a, b) => equal(mul(a.num, b.den), mul(b.num, a.den));

/**
 * A tree as a rational function of its symbols. `env` binds symbols to
 * rationals or polynomials; `fns` holds function definitions. Absolute values,
 * roots, pi and percent of a non-constant are not rational functions.
 */
export function fromTree(n, env = {}, fns = {}) {
  switch (n.k) {
    case 'num': return rat(constant(n.v));
    case 'sym': {
      const b = env[n.name];
      if (b === undefined) return rat(variable(n.name));
      return rat(b instanceof Map ? b : constant(b));
    }
    case 'group': return fromTree(n.e, env, fns);
    case 'neg': { const a = fromTree(n.e, env, fns); return rat(neg(a.num), a.den); }
    case 'pct': { const a = fromTree(n.e, env, fns); return rat(a.num, scale(a.den, R.Q(100))); }
    case 'add': return n.items.reduce((acc, { neg: minus, e }) => (minus ? ratSub : ratAdd)(acc, fromTree(e, env, fns)), rat(new Map()));
    case 'mul': return n.items.reduce((acc, e) => ratMul(acc, fromTree(e, env, fns)), rat(RONE()));
    case 'div': return ratDiv(fromTree(n.num, env, fns), fromTree(n.den, env, fns));
    case 'pow': {
      const e = fromTree(n.exp, env, fns);
      if (!isConstant(e.num) || !isConstant(e.den)) throw new NotPolynomial('variable exponent');
      const k = R.div(constantValue(e.num), constantValue(e.den));
      if (!R.isInt(k)) {
        // A fractional power of a constant can still be exact: 4^{1/2}.
        const base = fromTree(n.base, env, fns);
        if (isConstant(base.num) && isConstant(base.den) && k.d === 2n) {
          const root = R.sqrt(R.div(constantValue(base.num), constantValue(base.den)));
          if (root) return rat(constant(R.pow(root, Number(k.n))));
        }
        throw new NotPolynomial('fractional exponent');
      }
      return ratPow(fromTree(n.base, env, fns), Number(k.n));
    }
    case 'sqrt': {
      const a = fromTree(n.e, env, fns);
      if (n.index || !isConstant(a.num) || !isConstant(a.den)) throw new NotPolynomial('root of a variable');
      const root = R.sqrt(R.div(constantValue(a.num), constantValue(a.den)));
      if (!root) throw new NotPolynomial('irrational root');
      return rat(constant(root));
    }
    case 'call': {
      const f = fns[n.f];
      if (!f) throw new NotPolynomial(`unknown function ${n.f}`);
      const arg = fromTree(n.arg, env, fns);
      const body = fromTree(f.body, {}, fns);
      if (!isConstant(arg.den)) throw new NotPolynomial('rational argument');
      const inv = R.inv(constantValue(arg.den));
      const x = scale(arg.num, inv);
      return rat(substitute(body.num, { [f.param]: x }), substitute(body.den, { [f.param]: x }));
    }
    default: throw new NotPolynomial(`not a rational function: ${n.k}`);
  }
}

// -------------------------------------------------------- univariate roots

function integerDivisors(n) {
  n = n < 0n ? -n : n;
  if (n === 0n) return [0n];
  if (n > 10n ** 12n) throw new NotPolynomial('coefficients too large to factor');
  const out = [];
  for (let d = 1n; d * d <= n; d += 1n) {
    if (n % d === 0n) { out.push(d); if (d * d !== n) out.push(n / d); }
    if (d > 2000000n) throw new NotPolynomial('coefficients too large to factor');
  }
  return out;
}

const evalCoeffs = (cs, x) => cs.reduceRight((acc, c) => R.add(R.mul(acc, x), c), R.ZERO);

function trimCoeffs(cs) {
  const out = [...cs];
  while (out.length > 1 && R.isZero(out[out.length - 1])) out.pop();
  return out;
}

/** Divide by (x - r), assuming r is a root. */
function deflate(cs, r) {
  const n = cs.length - 1;
  const out = new Array(n);
  let carry = R.ZERO;
  for (let i = n; i >= 1; i -= 1) {
    carry = R.add(R.mul(carry, r), cs[i]);
    out[i - 1] = carry;
  }
  return out;
}

/** Largest k with k^2 dividing n, and the square-free rest. */
function squareFree(n) {
  let out = 1n;
  let rest = n;
  for (let p = 2n; p * p <= rest; p += 1n) {
    while (rest % (p * p) === 0n) { rest /= p * p; out *= p; }
    if (p > 100000n) break;
  }
  return [out, rest];
}

/**
 * Real roots of a polynomial given by rational coefficients (index = power).
 * Rational roots come back as rationals; a remaining quadratic factor with an
 * irrational pair comes back as surds { a, b, c } = a +- b*sqrt(c). Anything
 * left of higher degree throws: the engine only varies what it can solve.
 * Returns { roots, all } where `all` is true when every x is a root.
 */
export function realRoots(coeffs) {
  let cs = trimCoeffs(coeffs);
  if (cs.length === 1) return { roots: [], all: R.isZero(cs[0]) };
  // Clear denominators so the rational-root test runs on integers.
  const gcd = (x, y) => (y ? gcd(y, x % y) : x);
  const lcm = cs.reduce((acc, c) => (acc * c.d) / gcd(acc, c.d), 1n);
  cs = cs.map((c) => R.mul(c, R.Q(lcm)));
  const roots = [];
  // x = 0 as many times as the constant term vanishes.
  while (cs.length > 1 && R.isZero(cs[0])) {
    if (!roots.some((r) => R.isZero(r))) roots.push(R.ZERO);
    cs = cs.slice(1);
  }
  for (;;) {
    const deg = cs.length - 1;
    if (deg <= 0) break;
    if (deg === 1) { roots.push(R.neg(R.div(cs[0], cs[1]))); break; }
    if (deg === 2) {
      const [c, b, a] = cs;
      const disc = R.sub(R.mul(b, b), R.mul(R.Q(4), R.mul(a, c)));
      if (R.sign(disc) < 0) break;
      const root = R.sqrt(disc);
      const twoA = R.mul(R.Q(2), a);
      if (root) {
        roots.push(R.div(R.sub(R.neg(b), root), twoA));
        if (!R.isZero(root)) roots.push(R.div(R.add(R.neg(b), root), twoA));
      } else {
        // a +- b*sqrt(c) with c square-free: disc = (p/q) -> sqrt(p*q)/q.
        const [k, free] = squareFree(disc.n * disc.d);
        const bb = R.abs(R.div(R.Q(k, disc.d), twoA));
        roots.push({ a: R.div(R.neg(b), twoA), b: bb, c: free, surd: true });
      }
      break;
    }
    // Rational root theorem on the integer coefficients.
    const lead = cs[deg].n;
    const tail = cs[0].n;
    let found = null;
    for (const p of integerDivisors(tail)) {
      for (const q of integerDivisors(lead)) {
        for (const s of [1n, -1n]) {
          const r = R.Q(s * p, q);
          if (R.isZero(evalCoeffs(cs, r))) { found = r; break; }
        }
        if (found) break;
      }
      if (found) break;
    }
    if (!found) throw new NotPolynomial(`no rational root of a degree-${deg} factor`);
    if (!roots.some((r) => !r.surd && R.eq(r, found))) roots.push(found);
    cs = trimCoeffs(deflate(cs, found));
  }
  // Distinct, ascending (a surd pair counts as its two values).
  const uniq = [];
  for (const r of roots) if (r.surd || !uniq.some((u) => !u.surd && R.eq(u, r))) uniq.push(r);
  return { roots: uniq, all: false };
}

/** Numeric value(s) of a root, for ordering and the independent checks. */
export const rootValues = (r) => (r.surd
  ? [R.toNumber(r.a) - R.toNumber(r.b) * Math.sqrt(Number(r.c)), R.toNumber(r.a) + R.toNumber(r.b) * Math.sqrt(Number(r.c))]
  : [R.toNumber(r)]);

// ----------------------------------------------------------------- systems

/**
 * Solve polynomial equations (each `p = 0`) for `unknowns`, exactly.
 * Returns { status: 'solved', solutions: [ {v: rational} ] } with every
 * solution when the system is determined, { status: 'none' } when it has no
 * solution, and { status: 'infinite' } when some unknown stays free. Throws
 * NotPolynomial when it is beyond the solver (irrational solutions, a degree
 * with no rational root). `nonzero` lists denominators that must not vanish.
 */
export function solveSystem(eqs, unknowns, { nonzero = [] } = {}) {
  function solve(list, open) {
    const live = list.filter((p) => !isZero(p));
    if (live.some((p) => isConstant(p))) return { status: 'none' };
    if (!live.length) return open.length ? { status: 'infinite' } : { status: 'solved', solutions: [{}] };
    if (live.some((p) => [...vars(p)].some((v) => !open.includes(v)))) {
      throw new NotPolynomial('an equation holds a symbol that is not an unknown');
    }
    // 1) An equation linear in some unknown with a constant coefficient:
    // solve for that unknown and substitute (Gaussian elimination, generalized).
    for (const p of live) {
      for (const v of open) {
        const cs = coeffsIn(p, v);
        if (cs.length !== 2 || !isConstant(cs[1])) continue;
        const expr = scale(neg(cs[0]), R.inv(constantValue(cs[1])));
        const rest = live.filter((q) => q !== p).map((q) => substitute(q, { [v]: expr }));
        const inner = solve(rest, open.filter((u) => u !== v));
        if (inner.status !== 'solved') return inner;
        const solutions = [];
        for (const sol of inner.solutions) {
          const val = substitute(expr, sol);
          if (!isConstant(val)) return { status: 'infinite' };
          solutions.push({ ...sol, [v]: constantValue(val) });
        }
        return { status: 'solved', solutions };
      }
    }
    // 2) An equation in one unknown: try each of its roots.
    for (const p of live) {
      const vs = [...vars(p)];
      if (vs.length !== 1) continue;
      const [v] = vs;
      const { roots } = realRoots(univariate(p, v));
      if (roots.some((r) => r.surd)) throw new NotPolynomial('irrational solutions');
      const solutions = [];
      for (const r of roots) {
        const rest = live.filter((q) => q !== p).map((q) => substitute(q, { [v]: r }));
        const inner = solve(rest, open.filter((u) => u !== v));
        if (inner.status === 'infinite') return inner;
        if (inner.status === 'solved') solutions.push(...inner.solutions.map((sol) => ({ ...sol, [v]: r })));
      }
      return solutions.length ? { status: 'solved', solutions } : { status: 'none' };
    }
    throw new NotPolynomial('system not solvable by substitution');
  }

  const want = [...unknowns];
  const out = solve(eqs, want);
  if (out.status !== 'solved') return out;
  const seen = new Set();
  const solutions = out.solutions.filter((sol) => {
    // A root that zeroes a denominator of the original equation is extraneous.
    if (nonzero.some((d) => { const v = substitute(d, sol); return isConstant(v) && R.isZero(constantValue(v)); })) return false;
    const k = want.map((v) => R.key(sol[v])).join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return solutions.length ? { status: 'solved', solutions } : { status: 'none' };
}

// ----------------------------------------------------------------- printing

/**
 * A polynomial as a tree in standard form: descending degree in `order`'s
 * first variable, then the next. Coefficients print as integers, decimals or
 * fractions; a coefficient of 1 is left out.
 */
export function toTree(p, order = []) {
  const vs = [...new Set([...order, ...[...vars(p)].sort()])];
  const terms = [...p.values()].sort((x, y) => {
    for (const v of vs) {
      const d = (y.m[v] || 0) - (x.m[v] || 0);
      if (d) return d;
    }
    return 0;
  });
  if (!terms.length) return { k: 'num', v: R.ZERO, places: 0, commas: false };
  const items = terms.map(({ m, c }) => {
    const factors = [];
    const mag = R.abs(c);
    const monomial = vs.filter((v) => m[v]).map((v) => (m[v] === 1 ? { k: 'sym', name: v } : { k: 'pow', base: { k: 'sym', name: v }, exp: { k: 'num', v: R.Q(m[v]), places: 0, commas: false } }));
    if (!R.eq(mag, R.ONE) || !monomial.length) {
      factors.push(R.isInt(mag) || R.decimalPlaces(mag) !== null
        ? { k: 'num', v: mag, places: 0, commas: false }
        : { k: 'div', num: { k: 'num', v: R.Q(mag.n), places: 0, commas: false }, den: { k: 'num', v: R.Q(mag.d), places: 0, commas: false }, style: 'frac' });
    }
    factors.push(...monomial);
    const e = factors.length === 1 ? factors[0] : { k: 'mul', items: factors, explicit: false };
    return { neg: R.sign(c) < 0, e };
  });
  if (items.length === 1) return items[0].neg ? { k: 'neg', e: items[0].e } : items[0].e;
  return { k: 'add', items };
}
