// Formulas over a question's numbers, found by exhaustive search.
//
// A word problem states its quantities in prose ("$0.75 for every 12
// pencils", "20 pencils") and its answer is some arithmetic combination of
// them. This module finds every combination, up to a size, that produces a
// given value: the numbers are the atoms, joined by + - * /, with a few small
// constants a question may use without stating (100 for a percent, 1 for
// "1 + r", 2 for halving). The search runs in floating point for speed, over
// every subset of the atoms, and every hit is then checked exactly.
//
// A value is bound to a formula only when the smallest formulas that produce
// it are all the same formula, algebraically (0.75 * 20 / 12 and 20 / 12 * 0.75
// are one formula; 0.75 * 20 / 12 and 15 / 12 are not the same thing). Two
// different smallest formulas mean the engine cannot tell what the number
// is, and the question is left alone.

import * as R from './rational.js';
import * as P from './poly.js';

const OPS = ['+', '-', '*', '/'];

/** A formula tree: { atom: i } | { op, a, b }. Atoms index into the atom list. */
export function evalFloat(f, xs) {
  if ('atom' in f) return xs[f.atom];
  const a = evalFloat(f.a, xs);
  const b = evalFloat(f.b, xs);
  switch (f.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    default: return b === 0 ? NaN : a / b;
  }
}

export function evalExact(f, qs) {
  if ('atom' in f) return qs[f.atom];
  const a = evalExact(f.a, qs);
  const b = evalExact(f.b, qs);
  switch (f.op) {
    case '+': return R.add(a, b);
    case '-': return R.sub(a, b);
    case '*': return R.mul(a, b);
    default: return R.div(a, b);
  }
}

export const atomsOf = (f, out = new Set()) => {
  if ('atom' in f) out.add(f.atom);
  else { atomsOf(f.a, out); atomsOf(f.b, out); }
  return out;
};

export const sizeOf = (f) => ('atom' in f ? 1 : sizeOf(f.a) + sizeOf(f.b));

/** The formula as a rational function of symbols a0, a1, ...: for equivalence. */
function symbolic(f, atoms) {
  if ('atom' in f) {
    const at = atoms[f.atom];
    // Unvaried atoms (constants, fixed facts) are numbers, not symbols.
    return at.fixed ? P.rat(P.constant(at.value)) : P.rat(P.variable(`a${f.atom}`));
  }
  const a = symbolic(f.a, atoms);
  const b = symbolic(f.b, atoms);
  switch (f.op) {
    case '+': return P.ratAdd(a, b);
    case '-': return P.ratSub(a, b);
    case '*': return P.ratMul(a, b);
    default: return P.ratDiv(a, b);
  }
}

export function equivalent(f, g, atoms) {
  try { return P.ratEqual(symbolic(f, atoms), symbolic(g, atoms)); } catch { return false; }
}

const key = (v) => (Number.isFinite(v) ? v.toPrecision(11) : 'x');

/**
 * Every distinct formula over `atoms` (each atom used at most once, at most
 * `maxAtoms` of them). Formulas are told apart as functions, not by their
 * value on the question's numbers: each is also evaluated at a random point
 * where the varying atoms take other values, so two formulas that agree on
 * the question's numbers only by coincidence stay distinct.
 * atoms: [{ value: rational, fixed: bool }]. Returns { byMask } where
 * byMask: Map<mask, Map<functionKey, { f, v, w, size }>>.
 */
export const MASK_CAP = 60000;

export function enumerate(atoms, { maxAtoms = 4, seed = 7 } = {}) {
  const n = atoms.length;
  const xs = atoms.map((a) => R.toNumber(a.value));
  // A random point for the varying atoms, the same values for the fixed ones.
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const ws = atoms.map((a, i) => (a.fixed ? xs[i] : xs[i] * (1.37 + rand()) + 0.731 * (i + 1)));
  const byMask = new Map();
  let truncated = false;
  const bits = (m) => { let c = 0; for (let x = m; x; x &= x - 1) c += 1; return c; };
  const add = (mask, f, v, w, size, unit) => {
    if (unit === null || !Number.isFinite(v) || !Number.isFinite(w) || Math.abs(v) > 1e12) return;
    let m = byMask.get(mask);
    if (!m) byMask.set(mask, (m = new Map()));
    const k = `${key(w)}|${unit}`;
    if (m.has(k)) return;
    // A search that could not finish cannot show a formula is the only one.
    if (m.size >= MASK_CAP) { truncated = true; return; }
    m.set(k, { f, v, w, size, unit });
  };
  // Percent as a unit: 70% and the 100 it is out of carry it, a product adds
  // units and a quotient subtracts them, and a sum needs equal units, so
  // "1 + 10%" or "231 + 10%" is no formula at all.
  const same = (a, b) => (a === b ? a : null);
  for (let i = 0; i < n; i += 1) {
    // A constant the question never states (100 for a percent, 1, 60) costs
    // two steps: a formula that leans on unstated constants must clearly beat
    // the alternatives to be believed.
    const u = atoms[i].pct || 0;
    add(1 << i, { atom: i }, xs[i], ws[i], atoms[i].constant ? 2 : 1, u);
    // A stated number squared (an area, a radius in a circle's equation):
    // the one way an atom counts twice.
    // Only where squaring is geometry (atoms[i].square), and never a percent.
    if (atoms[i].square && !u) add(1 << i, { op: '*', a: { atom: i }, b: { atom: i } }, xs[i] * xs[i], ws[i] * ws[i], 2, 0);
  }
  const masks = [];
  for (let m = 1; m < 1 << n; m += 1) if (bits(m) <= maxAtoms) masks.push(m);
  masks.sort((a, b) => bits(a) - bits(b));
  for (const mask of masks) {
    if (bits(mask) < 2) continue;
    for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
      const other = mask ^ sub;
      if (sub < other) continue;
      const A = byMask.get(sub);
      const B = byMask.get(other);
      if (!A || !B) continue;
      for (const a of A.values()) {
        for (const b of B.values()) {
          const size = a.size + b.size;
          add(mask, { op: '+', a: a.f, b: b.f }, a.v + b.v, a.w + b.w, size, same(a.unit, b.unit));
          add(mask, { op: '*', a: a.f, b: b.f }, a.v * b.v, a.w * b.w, size, a.unit + b.unit);
          add(mask, { op: '-', a: a.f, b: b.f }, a.v - b.v, a.w - b.w, size, same(a.unit, b.unit));
          add(mask, { op: '-', a: b.f, b: a.f }, b.v - a.v, b.w - a.w, size, same(a.unit, b.unit));
          if (b.v !== 0 && b.w !== 0) add(mask, { op: '/', a: a.f, b: b.f }, a.v / b.v, a.w / b.w, size, a.unit - b.unit);
          if (a.v !== 0 && a.w !== 0) add(mask, { op: '/', a: b.f, b: a.f }, b.v / a.v, b.w / a.w, size, b.unit - a.unit);
        }
      }
    }
  }
  return { byMask, xs, truncated };
}

/**
 * The distinct formulas that produce `target` (a rational), smallest first.
 * `tolerance` allows a rounded target: |value - target| <= tolerance.
 * `must` is a bitmask of atoms every returned formula must use.
 */
export function formulasFor(space, atoms, target, { tolerance = 0, must = 0, units = null } = {}) {
  const t = R.toNumber(target);
  const hits = [];
  for (const [mask, m] of space.byMask) {
    if ((mask & must) !== must) continue;
    for (const e of m.values()) {
      if (units && !units.includes(e.unit)) continue;
      if (Math.abs(e.v - t) > (tolerance || 1e-9 * Math.max(1, Math.abs(t)))) continue;
      let ok;
      try {
        const v = evalExact(e.f, atoms.map((a) => a.value));
        ok = tolerance ? Math.abs(R.toNumber(v) - t) <= tolerance + 1e-12 : R.eq(v, target);
      } catch { ok = false; }
      if (ok) hits.push({ f: e.f, size: e.size, mask });
    }
  }
  return hits.sort((a, b) => a.size - b.size);
}

/**
 * The single formula a value is bound to, or null: the smallest formulas
 * producing it must all be the same function (they are distinct entries
 * only when they differ as functions, so more than one is ambiguous, unless
 * they are equivalent after all).
 */
export function bindValue(space, atoms, target, { margin = 1, ...options } = {}) {
  const hits = formulasFor(space, atoms, target, options);
  if (!hits.length) return null;
  // Every formula within `margin` of the smallest size must be the same one:
  // when a different formula reaches the value at nearly the same cost, the
  // value says nothing about which one the question means (9 is 3 squared,
  // or 2 + 4 + 3).
  const near = hits.filter((h) => h.size <= hits[0].size + margin);
  const [first] = near;
  if (near.some((h) => !equivalent(h.f, first.f, atoms))) return { ambiguous: true, formulas: near };
  return { f: first.f, size: first.size, mask: first.mask };
}

// ------------------------------------------------------------------ display

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 };

/**
 * Nested divisions folded into one fraction, as a person writes them:
 * a/(b/c) -> (a*c)/b, (a/b)/c -> a/(b*c), (a/b)*c -> (a*c)/b.
 */
export function tidy(f) {
  if ('atom' in f) return f;
  const a = tidy(f.a);
  const b = tidy(f.b);
  const div = (x) => !('atom' in x) && x.op === '/';
  if (f.op === '/' && div(b)) return tidy({ op: '/', a: { op: '*', a, b: b.b }, b: b.a });
  if (f.op === '/' && div(a)) return tidy({ op: '/', a: a.a, b: { op: '*', a: a.b, b } });
  if (f.op === '*' && div(a)) return tidy({ op: '/', a: { op: '*', a: a.a, b }, b: a.b });
  if (f.op === '*' && div(b)) return tidy({ op: '/', a: { op: '*', a, b: b.a }, b: b.b });
  return { op: f.op, a, b };
}

/** A formula as LaTeX with the atoms' shown values: "\frac{0.75 \times 20}{12}". */
export function formulaTex(f, shown, parentOp = null, right = false) {
  if (parentOp === null) f = tidy(f);
  if ('atom' in f) return shown[f.atom];
  if (f.op === '/') return `\\frac{${formulaTex(f.a, shown)}}{${formulaTex(f.b, shown)}}`;
  const a = formulaTex(f.a, shown, f.op, false);
  const b = formulaTex(f.b, shown, f.op, true);
  const tex = `${a} ${f.op === '*' ? '\\times' : f.op} ${b}`;
  const needs = parentOp && parentOp !== '/' && (PREC[f.op] < PREC[parentOp] || (right && (parentOp === '-' ) && PREC[f.op] === PREC[parentOp]));
  return needs ? `(${tex})` : tex;
}

export { OPS };
