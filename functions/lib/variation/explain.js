// Worked explanations, built from the actual trees and the exact solution.
// Every number a sentence states is computed here; nothing is assumed about
// the question beyond what the model already verified. Math goes inside
// \( \) and no sentence names a choice by its letter (choices are shuffled).

import * as R from './rational.js';
import * as P from './poly.js';
import { toTex, numTex, inlineCalls, symbols, evalQ, walk, same, replaceAt } from './expr.js';
import { parts, relationPoly } from './solve.js';

export const m = (tex) => `\\(${tex}\\)`;
/** A computed number as the SAT prints it: 1,150 with a comma, fractions stacked. */
export const num = (q) => numTex(q, { commas: R.isInt(q) && R.cmp(R.abs(q), R.Q(1000)) >= 0 });
const leaf = (q) => ({ k: 'num', v: R.abs(q), places: 0, commas: R.isInt(q) && R.cmp(R.abs(q), R.Q(1000)) >= 0 });
const polyTex = (p, order) => toTex(P.toTree(p, order));
const joinAnd = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`);
const joinOr = (list) => (list.length <= 2 ? list.join(' or ') : `${list.slice(0, -1).join(', ')}, or ${list[list.length - 1]}`);

/** A tree with values plugged in for display: 5(2)^{3} + 3, x + 5 -> 1 + 5, 13 - 3(-4). */
export function plugIn(tree, env) {
  const put = (n, parent) => {
    if (n.k === 'sym' && n.name in env) {
      const v = env[n.name];
      const negative = R.sign(v) < 0;
      const node = negative ? { k: 'neg', e: leaf(v) } : leaf(v);
      // Parentheses where juxtaposition or a sign would misread: 3(2), (-4)^{2}, 5 - (-3).
      const tight = parent && (parent.k === 'mul' || parent.k === 'pow' || parent.k === 'neg' || (parent.k === 'add' && negative) || (parent.k === 'call'));
      return tight && parent.k !== 'call' ? { k: 'group', e: node } : node;
    }
    const out = { ...n };
    for (const key of ['e', 'arg', 'num', 'den', 'base', 'exp', 'l', 'r', 'index']) if (n[key]) out[key] = put(n[key], n);
    if (n.items) out.items = n.items.map((it) => (n.k === 'add' ? { ...it, e: put(it.e, n) } : put(it, n)));
    return out;
  };
  return put(tree, null);
}

/** Calls replaced by their values for display: 5f(4) - g(4) -> 5(7) - 4. */
function callsAsValues(t, defs, env) {
  const visit = (n, parent) => {
    if (n.k === 'call' && defs[n.f]) {
      const v = evalQ(inlineCalls(n, defs), env);
      const node = R.sign(v) < 0 ? { k: 'neg', e: leaf(v) } : leaf(v);
      const tight = parent && (parent.k === 'mul' || parent.k === 'pow' || (R.sign(v) < 0 && parent.k === 'add'));
      return tight ? { k: 'group', e: node } : node;
    }
    const out = { ...n };
    for (const key of ['e', 'arg', 'num', 'den', 'base', 'exp', 'l', 'r', 'index']) if (n[key]) out[key] = visit(n[key], n);
    if (n.items) out.items = n.items.map((it) => (n.k === 'add' ? { ...it, e: visit(it.e, n) } : visit(it, n)));
    return out;
  };
  return visit(t, null);
}

/** "target = shown = value", dropping repeats. */
function chainTex(parts_) {
  const out = [];
  for (const p of parts_) if (out[out.length - 1] !== p) out.push(p);
  return out.join(' = ');
}

/** The target evaluated at the solution: "x + 5 = 1 + 5 = 6". */
function evaluated(target, env, value, defs = {}) {
  const shown = plugIn(callsAsValues(target, defs, env), env);
  return chainTex([toTex(target), toTex(shown), num(value)]);
}

/** Each function value the target uses: "f(6) = 3(6) + 5 = 23". */
function callValues(target, defs, env) {
  const out = [];
  const seen = new Set();
  for (const [n] of walk(target)) {
    if (n.k !== 'call' || !defs[n.f]) continue;
    const key = toTex(n);
    if (seen.has(key)) continue;
    seen.add(key);
    const f = defs[n.f];
    const argVal = evalQ(inlineCalls(n.arg, defs), env);
    const v = evalQ(inlineCalls(n, defs), env);
    out.push(chainTex([key, toTex(plugIn(f.body, { [f.param]: argVal })), num(v)]));
  }
  return out;
}

const lcmBig = (a, b) => { const g = (x, y) => (y ? g(y, x % y) : x); return (a * b) / g(a, b); };
function coefLcd(p) {
  let l = 1n;
  for (const { c } of p.values()) l = lcmBig(l, c.d);
  return l;
}
const hasAbs = (t) => [...walk(t)].some(([n]) => n.k === 'abs');
const hasCall = (t) => [...walk(t)].some(([n]) => n.k === 'call');

/** "Since f(x) = 2x - 161, the equation f(x) = 91 says 2x - 161 = 91." */
function substituteDefinitions(rel, defs) {
  const used = [...new Set([...walk(rel)].filter(([n]) => n.k === 'call' && defs[n.f]).map(([n]) => n.f))];
  const def = used.map((f) => m(`${f}(${defs[f].param}) = ${toTex(defs[f].body)}`));
  const inlined = substituteForDisplay(rel, defs);
  return `Since ${joinAnd(def)}, the equation ${m(toTex(rel))} says ${m(toTex(inlined))}.`;
}

/** Calls replaced by their bodies, parenthesized only where needed. */
function substituteForDisplay(t, defs) {
  const visit = (n, parent) => {
    if (n.k === 'call' && defs[n.f]) {
      const f = defs[n.f];
      const arg = visit(n.arg, null);
      let body = arg.k === 'sym' && arg.name === f.param ? f.body : bodyWith(f.body, f.param, arg);
      const loose = body.k === 'add' || body.k === 'neg';
      if (loose && parent && (parent.k === 'mul' || parent.k === 'pow' || parent.k === 'neg' || parent.k === 'add')) body = { k: 'group', e: body };
      return body;
    }
    const out = { ...n };
    for (const key of ['e', 'arg', 'num', 'den', 'base', 'exp', 'l', 'r', 'index']) if (n[key]) out[key] = visit(n[key], n);
    if (n.items) out.items = n.items.map((it) => (n.k === 'add' ? { ...it, e: visit(it.e, n) } : visit(it, n)));
    return out;
  };
  return visit(t, null);
}
function bodyWith(body, param, arg) {
  const visit = (n, parent) => {
    if (n.k === 'sym' && n.name === param) {
      const atomic = arg.k === 'num' || arg.k === 'sym';
      return atomic && !(parent && (parent.k === 'mul' || parent.k === 'pow') && arg.k === 'num') ? arg : { k: 'group', e: arg };
    }
    const out = { ...n };
    for (const key of ['e', 'arg', 'num', 'den', 'base', 'exp', 'l', 'r', 'index']) if (n[key]) out[key] = visit(n[key], n);
    if (n.items) out.items = n.items.map((it) => (n.k === 'add' ? { ...it, e: visit(it.e, n) } : visit(it, n)));
    return out;
  };
  return visit(body, null);
}

// ------------------------------------------------------------ one variable

/** A linear equation's last steps: "Collecting ... gives 3x = 13. Dividing ... gives x = 13/3." */
function linearFinish(left, right, x, steps) {
  const cs = P.univariate(P.sub(left, right), x);
  let a = cs[1];
  let b = R.neg(cs[0]);
  if (R.sign(a) < 0) { a = R.neg(a); b = R.neg(b); }
  const lx = P.coeffsIn(left, x);
  const rx = P.coeffsIn(right, x);
  const isolated = (lx.length === 2 && P.isConstant(right) && P.isZero(lx[0] || P.ZERO))
    || (rx.length === 2 && P.isConstant(left) && P.isZero(rx[0] || P.ZERO));
  const ax = R.eq(a, R.ONE) ? x : `${num(a)}${x}`;
  if (!isolated) steps.push(`Collecting the ${m(x)}-terms on one side and the constants on the other gives ${m(`${ax} = ${num(b)}`)}.`);
  const root = R.div(b, a);
  if (!R.eq(a, R.ONE)) steps.push(`Dividing both sides by ${m(num(a))} gives ${m(`${x} = ${num(root)}`)}.`);
  return root;
}

/** The two sides of a relation with constant denominators cleared, and the sentence that did it. */
function cleared(rel, x, steps) {
  const l = P.fromTree(rel.l);
  const r = P.fromTree(rel.r);
  if (!P.isConstant(l.den) || !P.isConstant(r.den)) {
    const left = P.mul(l.num, r.den);
    const right = P.mul(r.num, l.den);
    steps.push(`Multiplying both sides by the denominators gives ${m(`${polyTex(left, [x])} = ${polyTex(right, [x])}`)}.`);
    return { left, right };
  }
  let left = P.scale(l.num, R.inv(P.constantValue(l.den)));
  let right = P.scale(r.num, R.inv(P.constantValue(r.den)));
  const lcd = lcmBig(coefLcd(left), coefLcd(right));
  if (lcd > 1n) {
    left = P.scale(left, R.Q(lcd));
    right = P.scale(right, R.Q(lcd));
    steps.push(`Multiplying both sides by ${m(String(lcd))} clears the fractions: ${m(`${polyTex(left, [x])} = ${polyTex(right, [x])}`)}.`);
  } else if (!simpleSide(rel.l) || !simpleSide(rel.r)) {
    steps.push(`${hasGroup(rel) ? 'Distributing and combining' : 'Combining'} like terms gives ${m(`${polyTex(left, [x])} = ${polyTex(right, [x])}`)}.`);
  }
  return { left, right };
}

/** A side that is already a sum of unlike terms with no parentheses: nothing to distribute or combine. */
function simpleSide(t) {
  const terms = t.k === 'add' ? t.items.map((it) => it.e) : [t.k === 'neg' ? t.e : t];
  const keys = [];
  for (const e of terms) {
    if ([...walk(e)].some(([n]) => n.k === 'group' || n.k === 'div' || n.k === 'abs' || n.k === 'call')) return false;
    let p;
    try { p = P.fromTree(e).num; } catch { return false; }
    if (p.size !== 1) return false;
    const [k] = p.keys();
    if (keys.includes(k)) return false;
    keys.push(k);
  }
  return true;
}
const hasGroup = (t) => [...walk(t)].some(([n]) => n.k === 'group');

/** Steps for one equation in one unknown; returns the roots it reaches. */
function oneVariable(rel, x, steps) {
  const square = squareRoots(rel, x, steps);
  if (square) return square;
  const { left, right } = cleared(rel, x, steps);
  let diff = P.sub(left, right);
  const cs = P.univariate(diff, x);
  const deg = cs.length - 1;
  if (deg === 1) return [linearFinish(left, right, x, steps)];
  if (deg === 0) {
    steps.push(R.isZero(cs[0])
      ? `Collecting terms gives ${m('0 = 0')}, which is true for every value of ${m(x)}.`
      : `Collecting terms leaves ${m(`0 = ${num(R.neg(cs[0]))}`)}, which is never true, so no value of ${m(x)} satisfies the equation.`);
    return R.isZero(cs[0]) ? 'all' : [];
  }
  if (R.sign(cs[deg]) < 0) diff = P.neg(diff);
  const c = P.univariate(diff, x);
  const { roots } = P.realRoots(c);
  const say = (list) => joinOr(list.map((q) => m(`${x} = ${num(q)}`)));
  if (deg === 2 && R.isZero(c[1]) && roots.length === 2 && !roots.some((q) => q.surd)) {
    // ax^2 = k: a square root, both signs.
    const k = R.div(R.neg(c[0]), c[2]);
    steps.push(`Solving for ${m(`${x}^{2}`)} gives ${m(`${x}^{2} = ${num(k)}`)}, so ${say(roots)}.`);
    return roots;
  }
  const standard = `${polyTex(diff, [x])} = 0`;
  const factored = rel.r.k === 'num' && R.isZero(rel.r.v) && rel.l.k === 'mul' && rel.l.items.filter((f) => f.k === 'group').length >= 2;
  if (factored) {
    steps.push(`A product is ${m('0')} only when one of its factors is ${m('0')}, so ${say(roots)}.`);
    return roots;
  }
  steps.push(`Moving every term to one side gives ${m(standard)}.`);
  if (deg === 2 && roots.length && !roots.some((q) => q.surd)) {
    const lead = c[2];
    const factor = (q) => (R.isZero(q) ? x : `(${x} ${R.sign(q) > 0 ? '-' : '+'} ${num(R.abs(q))})`);
    const body = roots.length === 2 ? `${factor(roots[0])}${factor(roots[1])}` : `${factor(roots[0])}^{2}`;
    const g = R.eq(lead, R.ONE) ? '' : num(lead);
    steps.push(`Factoring gives ${m(`${g}${body} = 0`)}, so ${say(roots)}.`);
  } else if (!roots.length) {
    const disc = R.sub(R.mul(c[1], c[1]), R.mul(R.Q(4), R.mul(c[2], c[0])));
    steps.push(`Its discriminant is ${m(num(disc))}, which is negative, so the equation has no real solutions.`);
  } else {
    steps.push(`Its real solutions are ${joinAnd(roots.filter((q) => !q.surd).map((q) => m(num(q))))}.`);
  }
  return roots;
}

/** "(x - 44)^{2} = 4": take square roots instead of expanding. */
function squareRoots(rel, x, steps) {
  for (const [sq, c] of [[rel.l, rel.r], [rel.r, rel.l]]) {
    if (sq.k !== 'pow' || sq.exp.k !== 'num' || !R.eq(sq.exp.v, R.Q(2)) || symbols(c).size) continue;
    const inner = sq.base.k === 'group' ? sq.base.e : sq.base;
    let k;
    try { k = evalQ(c); } catch { return null; }
    const root = R.sqrt(k);
    if (!root || R.isZero(root)) return null;
    let p;
    try { p = P.fromTree(inner); } catch { return null; }
    if (!P.isConstant(p.den) || P.degree(p.num, x) !== 1 || P.vars(p.num).size !== 1) return null;
    const lin = P.univariate(P.scale(p.num, R.inv(P.constantValue(p.den))), x);
    const roots = [root, R.neg(root)].map((v) => R.div(R.sub(v, lin[0]), lin[1])).sort(R.cmp);
    const t = toTex(inner);
    steps.push(`Taking the square root of both sides gives ${m(`${t} = ${num(root)}`)} or ${m(`${t} = ${num(R.neg(root))}`)}, so ${joinOr(roots.map((q) => m(`${x} = ${num(q)}`)))}.`);
    return roots;
  }
  return null;
}

/**
 * An equation where the unknown appears only inside copies of the target
 * ("-7(13 - 5x) + 3 = -8(13 - 5x) + 21, what is 13 - 5x?"): solve for the
 * target as one quantity.
 */
function asOneQuantity(rel, target, x, value, steps) {
  try { return quantitySteps(rel, target, x, value, steps); } catch { return false; }
}
function quantitySteps(rel, target, x, value, steps) {
  const u = 'u̅'; // a symbol no question uses
  let replaced = rel;
  for (const [node, path] of [...walk(rel)].reverse()) {
    if (same(node, target) || (node.k === 'group' && same(node.e, target))) replaced = replaceAt(replaced, path, () => ({ k: 'sym', name: u }));
  }
  if (symbols(replaced).has(x)) return false;
  const { poly } = relationPoly(replaced);
  if (P.degree(poly, u) !== 1) return false;
  steps.push(`The unknown appears only in ${m(toTex(target))}, so treat ${m(toTex(target))} as a single quantity.`);
  const l = P.fromTree(replaced.l);
  const r = P.fromTree(replaced.r);
  const L = P.scale(l.num, R.inv(P.constantValue(l.den)));
  const Rr = P.scale(r.num, R.inv(P.constantValue(r.den)));
  const cs = P.univariate(P.sub(L, Rr), u);
  let a = cs[1];
  let b = R.neg(cs[0]);
  if (R.sign(a) < 0) { a = R.neg(a); b = R.neg(b); }
  const t = toTex(target);
  const wrapped = target.k === 'div' ? `\\left(${t}\\right)` : target.k === 'add' ? `(${t})` : t;
  // Already "a(target) = b": one division finishes it.
  const oneSide = (side, other) => P.isConstant(other) && P.coeffsIn(side, u).length === 2 && P.isZero(P.coeffsIn(side, u)[0] || P.ZERO);
  if (oneSide(L, Rr) || oneSide(Rr, L)) {
    if (!R.eq(a, R.ONE)) steps.push(`Dividing both sides by ${m(num(a))} gives ${m(`${t} = ${num(value)}`)}.`);
    else steps.push(`So ${m(`${t} = ${num(value)}`)}.`);
  } else if (R.eq(a, R.ONE)) {
    steps.push(`Collecting its terms on one side and the constants on the other gives ${m(`${t} = ${num(value)}`)}.`);
  } else {
    steps.push(`Collecting its terms on one side and the constants on the other gives ${m(`${num(a)}${wrapped} = ${num(b)}`)}, so ${m(`${t} = ${num(value)}`)}.`);
  }
  return true;
}

/** |E| isolated: "|2x - 20| = 38, so 2x - 20 = 38 or 2x - 20 = -38." */
function absSteps(rel, x, roots, steps) {
  const found = [...walk(rel)].filter(([n]) => n.k === 'abs');
  if (found.length === 1) {
    const [node, path] = found[0];
    const a = 'a̅';
    const replaced = replaceAt(rel, path, () => ({ k: 'sym', name: a }));
    if (!symbols(replaced).has(x)) {
      const { poly } = relationPoly(replaced);
      const cs = P.univariate(poly, a);
      if (cs.length === 2) {
        const v = R.div(R.neg(cs[0]), cs[1]);
        const inner = toTex(node.e);
        if (R.sign(v) < 0) {
          steps.push(`Isolating the absolute value gives ${m(`${toTex(node)} = ${num(v)}`)}, which no value satisfies.`);
          return;
        }
        steps.push(`Isolating the absolute value gives ${m(`${toTex(node)} = ${num(v)}`)}, so ${R.isZero(v) ? m(`${inner} = 0`) : `${m(`${inner} = ${num(v)}`)} or ${m(`${inner} = ${num(R.neg(v))}`)}`}.`);
        steps.push(`Solving ${R.isZero(v) ? 'it' : 'each'} gives ${joinOr(roots.map((q) => m(`${x} = ${num(q)}`)))}.`);
        return;
      }
    }
  }
  steps.push(`Checking both signs of the expression inside the absolute value gives ${joinOr(roots.map((q) => m(`${x} = ${num(q)}`)))}.`);
}

// ------------------------------------------------------------------ systems

/** Coefficients of a linear relation in two unknowns: cx*x + cy*y = c, with fractions cleared. */
function linearForm(rel, x, y) {
  const { poly } = relationPoly(rel);
  const scaled = P.scale(poly, R.Q(coefLcd(poly)));
  const at = (p, v, k) => P.constantValue(P.coeffsIn(p, v)[k] || P.ZERO);
  const cx = at(scaled, x, 1);
  const rest = P.coeffsIn(scaled, x)[0] || P.ZERO;
  const cy = at(rest, y, 1);
  const c = R.neg(at(rest, y, 0));
  // Keep the x coefficient positive where there is one, as written by hand.
  const flip = R.sign(cx) < 0 || (R.isZero(cx) && R.sign(cy) < 0);
  return flip ? { cx: R.neg(cx), cy: R.neg(cy), c: R.neg(c) } : { cx, cy, c };
}

function formTex({ cx, cy, c }, x, y) {
  const p = P.add(P.scale(P.variable(x), cx), P.scale(P.variable(y), cy));
  return `${polyTex(p, [x, y])} = ${num(c)}`;
}

/** Two linear equations in two unknowns, by substitution where it is natural, else elimination. */
function linearSystem(rels, [x, y], sol, steps) {
  // An equation solved for one unknown ("y = 6x"): substitute it.
  for (let i = 0; i < 2; i += 1) {
    for (const [side, other] of [['l', 'r'], ['r', 'l']]) {
      const s = rels[i][side];
      if (s.k !== 'sym' || ![x, y].includes(s.name) || symbols(rels[i][other]).has(s.name)) continue;
      const v = s.name;
      const u = v === x ? y : x;
      if (!symbols(rels[1 - i]).has(v)) continue;
      const into = rels[1 - i];
      const sub = replaceSym(into, v, { k: 'group', e: rels[i][other] });
      steps.push(`Substituting ${m(`${toTex(rels[i][other])}`)} for ${m(v)} in ${m(toTex(into))} gives ${m(toTex(sub))}.`);
      oneVariable(sub, u, steps);
      steps.push(`Then ${m(chainTex([v, toTex(plugIn(rels[i][other], { [u]: sol[u] })), num(sol[v])]))}.`);
      return;
    }
  }
  const [e1, e2] = rels.map((r) => linearForm(r, x, y));
  const written = rels.map((r) => toTex(r));
  const standard = [formTex(e1, x, y), formTex(e2, x, y)];
  if (standard.some((s, i) => s !== written[i])) steps.push(`Written in the same form, the equations are ${m(standard[0])} and ${m(standard[1])}.`);
  // An equation in one unknown: solve it first.
  for (const [i, e] of [e1, e2].entries()) {
    const only = R.isZero(e.cy) ? x : R.isZero(e.cx) ? y : null;
    if (!only) continue;
    const other = only === x ? y : x;
    steps.push(`The ${i ? 'second' : 'first'} equation gives ${m(`${only} = ${num(sol[only])}`)}; substituting it into the ${i ? 'first' : 'second'} equation gives ${m(`${other} = ${num(sol[other])}`)}.`);
    return;
  }
  // Eliminate the unknown whose coefficients combine most simply.
  const cost = (a, b) => Number(lcmBig(R.abs(a).n, R.abs(b).n));
  const elimY = cost(e1.cy, e2.cy) <= cost(e1.cx, e2.cx);
  const [k1, k2] = elimY ? [e1.cy, e2.cy] : [e1.cx, e2.cx];
  const l = lcmBig(R.abs(k1).n, R.abs(k2).n);
  const m1 = R.Q(l / R.abs(k1).n);
  const m2 = R.Q(l / R.abs(k2).n);
  const sameSign = R.sign(k1) === R.sign(k2);
  const gone = elimY ? y : x;
  const kept = elimY ? x : y;
  const keptOf = (e) => (elimY ? e.cx : e.cy);
  const a = sameSign ? R.sub(R.mul(keptOf(e1), m1), R.mul(keptOf(e2), m2)) : R.add(R.mul(keptOf(e1), m1), R.mul(keptOf(e2), m2));
  const b = sameSign ? R.sub(R.mul(e1.c, m1), R.mul(e2.c, m2)) : R.add(R.mul(e1.c, m1), R.mul(e2.c, m2));
  const scaled = [[m1, 'first'], [m2, 'second']].filter(([k]) => !R.eq(k, R.ONE)).map(([k, w]) => `the ${w} equation by ${m(num(k))}`);
  const op = sameSign ? 'subtracting the second from the first' : 'adding the equations';
  const lead = scaled.length ? `Multiplying ${joinAnd(scaled)} and then ${op}` : `${op.charAt(0).toUpperCase()}${op.slice(1)}`;
  const ax = R.eq(a, R.ONE) ? kept : R.eq(a, R.Q(-1)) ? `-${kept}` : `${num(a)}${kept}`;
  steps.push(`${lead} eliminates ${m(gone)}: ${m(`${ax} = ${num(b)}`)}, so ${m(`${kept} = ${num(sol[kept])}`)}.`);
  steps.push(`Substituting this value into either equation gives ${m(`${gone} = ${num(sol[gone])}`)}.`);
}

function replaceSym(tree, name, by) {
  const visit = (n) => {
    if (n.k === 'sym' && n.name === name) return by;
    const out = { ...n };
    for (const key of ['e', 'arg', 'num', 'den', 'base', 'exp', 'l', 'r', 'index']) if (n[key]) out[key] = visit(n[key]);
    if (n.items) out.items = n.items.map((it) => (n.k === 'add' ? { ...it, e: visit(it.e) } : visit(it)));
    return out;
  };
  return visit(tree);
}

// --------------------------------------------------------------- the whole

/**
 * The explanation of the correct answer, and a one-sentence summary for the
 * wrong-choice explanations to point back to.
 */
export function explain(model, trees, ans) {
  const pieces = parts(model, trees);
  const { defs, target } = pieces;
  const steps = [];
  const kind = model.ask.kind;

  if (ans.type === 'expr') return expressionSteps(pieces, ans);

  // Values of functions, no equation to solve.
  if (!pieces.relations.length && !pieces.identities.length) {
    const vals = callValues(target, defs, {});
    const whole = evaluated(target, {}, ans.value, defs);
    if (vals.length === 1 && target.k === 'call') steps.push(`Substituting into the definition gives ${m(vals[0])}.`);
    else {
      if (vals.length) steps.push(`From the definition${vals.length > 1 ? 's' : ''}, ${joinAnd(vals.map(m))}.`);
      steps.push(`Therefore, ${m(whole)}.`);
    }
    return { text: steps.join(' '), summary: `The value is ${m(`${toTex(target)} = ${num(ans.value)}`)}.` };
  }

  if (pieces.identities.length || (model.special && target?.k === 'sym')) return identitySteps(model, pieces, ans);

  const { unknowns, solutions } = ans.solved;
  const rels = pieces.relations;
  const inl = rels.map((r) => inlineCalls(r, defs));
  const solveOne = (rel, rawRel, x, sol) => {
    if (hasCall(rawRel)) steps.push(substituteDefinitions(rawRel, defs));
    const shown = hasCall(rawRel) ? substituteForDisplay(rawRel, defs) : rawRel;
    if (hasAbs(rel)) absSteps(shown, x, solutions.map((s) => s[x]).sort(R.cmp), steps);
    else if (!(target && target.k !== 'sym' && kind === 'value' && sol && asOneQuantity(rel, target, x, ans.value, steps))) oneVariable(shown, x, steps);
  };
  if (unknowns.length === 1 && rels.length === 1) {
    solveOne(inl[0], rels[0], unknowns[0], solutions[0]);
  } else if (rels.length === unknowns.length && inl.every((r) => symbols(r).size === 1) && new Set(inl.map((r) => [...symbols(r)][0])).size === rels.length) {
    // Separate facts, one unknown each: "g(a) = 26 and g(6) = b".
    inl.forEach((r, i) => {
      const x = [...symbols(r)][0];
      const raw = rels[i];
      const isEval = raw.r.k === 'sym' && raw.r.name === x && !symbols(raw.l).size;
      if (isEval) steps.push(`Also, ${m(chainTex([x, toTex(raw.l), toTex(plugIn(substituteForDisplay(raw.l, defs), {})), num(solutions[0][x])]))}.`);
      else solveOne(r, raw, x, solutions[0]);
    });
  } else if (unknowns.length === 2 && rels.length === 2 && inl.every((r) => { try { return P.totalDegree(relationPoly(r).poly) <= 1; } catch { return false; } })) {
    linearSystem(inl, unknowns, solutions[0], steps);
  } else if (solutions.length === 1) {
    steps.push(`Solving the equations gives ${joinAnd(unknowns.map((u) => m(`${u} = ${num(solutions[0][u])}`)))}.`);
  } else {
    steps.push(`The solutions are ${joinAnd(solutions.map((s) => `(${joinAnd(unknowns.map((u) => m(`${u} = ${num(s[u])}`)))})`))}.`);
  }

  const x = unknowns[0];
  const values = solutions.map((s) => s[x]).sort(R.cmp);
  let summary;
  switch (kind) {
    case 'sum': summary = `The solutions are ${joinAnd(values.map((v) => m(num(v))))}, so their sum is ${m(num(ans.value))}.`; break;
    case 'product': summary = `The solutions are ${joinAnd(values.map((v) => m(num(v))))}, so their product is ${m(num(ans.value))}.`; break;
    case 'positive': case 'negative': case 'greatest': case 'least': {
      const word = { positive: 'positive', negative: 'negative', greatest: 'greater', least: 'lesser' }[kind];
      summary = values.length > 1 ? `The solutions are ${joinAnd(values.map((v) => m(num(v))))}, and the ${word} one is ${m(num(ans.value))}.` : `The only solution is ${m(num(ans.value))}.`;
      break;
    }
    case 'count':
      summary = ans.value === 'infinite' ? 'Every value satisfies the equation, so it has infinitely many solutions.'
        : `The equation has ${['no', 'exactly one', 'exactly two', 'exactly three'][ans.value]} solution${ans.value === 1 ? '' : 's'}.`;
      break;
    default:
      summary = target && target.k !== 'sym' ? `So ${m(evaluated(target, solutions[0], ans.value, defs))}.` : `So ${m(`${target ? target.name : x} = ${num(ans.value)}`)}.`;
  }
  const said = ans.type === 'number' && steps.join(' ').includes(m(`${target?.k === 'sym' ? target.name : '\u0000'} = ${num(ans.value)}`))
    || (target && target.k !== 'sym' && steps.join(' ').includes(`${toTex(target)} = ${num(ans.value)}\\)`));
  if (!said || kind !== 'value') steps.push(summary);
  // The wrong-choice explanations end on the shortest correct route.
  const short = kind === 'value' && target && target.k !== 'sym' && solutions.length === 1 && !said
    ? `Solving gives ${joinAnd(unknowns.map((u) => m(`${u} = ${num(solutions[0][u])}`)))}, so ${m(evaluated(target, solutions[0], ans.value, defs))}.`
    : summary;
  return { text: steps.join(' '), summary: short };
}

/** Identities (coefficients match) and constants that make a solution count. */
function identitySteps(model, pieces, ans) {
  const steps = [];
  const k = pieces.target.name;
  if (pieces.identities.length) {
    const [id] = pieces.identities;
    const lhs = P.fromTree(inlineCalls(id.l, pieces.defs));
    const rhs = P.fromTree(inlineCalls(id.r, pieces.defs));
    const free = [...new Set([...P.vars(lhs.num), ...P.vars(rhs.num)])].filter((v) => v !== k && !model.constants.has(v));
    const order = [k, ...[...model.constants.keys()].filter((c) => c !== k), ...free];
    if (P.isConstant(lhs.den) && P.isConstant(rhs.den)) {
      const L = P.scale(lhs.num, R.inv(P.constantValue(lhs.den)));
      const Rr = P.scale(rhs.num, R.inv(P.constantValue(rhs.den)));
      const lt = polyTex(L, order);
      const rt = polyTex(Rr, order);
      if (lt !== toTex(id.l) || rt !== toTex(id.r)) steps.push(`${hasGroup(id) ? 'Distributing' : 'Combining like terms'} gives ${m(lt)} on one side and ${m(rt)} on the other.`);
    }
    steps.push(`Equivalent expressions have equal coefficients, so ${m(`${k} = ${num(ans.value)}`)}.`);
  } else {
    steps.push(model.special === 'infinite'
      ? 'An equation has infinitely many solutions when both sides are the same expression, so the coefficients of the variable and the constant terms must match.'
      : 'A linear equation has no solution when the variable terms cancel but the constant terms do not.');
    steps.push(`That happens when ${m(`${k} = ${num(ans.value)}`)}.`);
  }
  return { text: steps.join(' '), summary: `The value is ${m(`${k} = ${num(ans.value)}`)}.` };
}

/** "Distributing each term of the first factor over the second gives ..., which simplifies to ..." */
function expressionSteps(pieces, ans) {
  const { defs, target } = pieces;
  const key = ans.display || P.toTree(ans.rat.num, ans.order || []);
  const order = ans.order || [];
  const shown = hasCall(target) ? substituteForDisplay(target, defs) : target;
  const steps = [];
  if (hasCall(target)) steps.push(`Using the definitions, ${m(`${toTex(target)} = ${toTex(shown)}`)}.`);
  const t = shown.k === 'group' ? shown.e : shown;
  if (t.k === 'mul' && t.items.length === 2 && t.items.every((f) => f.k === 'group' && f.e.k === 'add' && f.e.items.length === 2)) {
    const [a, b] = t.items.map((f) => f.e.items.map(({ neg, e }) => { const p = P.fromTree(e).num; return neg ? P.neg(p) : p; }));
    const prods = a.flatMap((p) => b.map((q) => P.mul(p, q)));
    const expanded = prods.map((p, i) => {
      const tt = polyTex(p, order);
      return i === 0 ? tt : tt.startsWith('-') ? `- ${tt.slice(1)}` : `+ ${tt}`;
    }).join(' ');
    steps.push(`Distributing each term of the first factor over the second gives ${m(expanded)}, which simplifies to ${m(toTex(key))}.`);
  } else {
    steps.push(`Distributing and combining like terms in ${m(toTex(shown))} gives ${m(toTex(key))}.`);
  }
  return { text: steps.join(' '), summary: `The expression ${m(toTex(target))} is equivalent to ${m(toTex(key))}.` };
}
