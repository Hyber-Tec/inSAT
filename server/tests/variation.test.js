// The variation engine: reading the bank's notations, understanding a
// question only when its own solution reproduces the key, and producing
// variants that pass the independent check. Fixtures are written for these
// tests in the bank's three notations (LaTeX, ClassMarker, plain text); no
// bank content is copied here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as R from '../lib/variation/rational.js';
import * as P from '../lib/variation/poly.js';
import { parse, toTex, same } from '../lib/variation/expr.js';
import { segment } from '../lib/variation/text.js';
import { understand, vary, classify } from '../lib/variation/engine.js';
import { verifyVariant } from '../lib/variation/verify.js';
import { gridAnswer } from '../lib/variation/render.js';
import { lineageOf } from '../lib/lineage.js';

const mc = (question, choices, correctIdx, extra = {}) => ({ question, choices, correct_idx: correctIdx, answer_type: 'multiple-choice', ...extra });
const grid = (question, answer) => ({ question, choices: [], correct_idx: 0, answer_type: 'grid-in', answer_text: answer });

const FIXTURES = {
  subexpression: mc('If \\(4(x - 2) = 28\\), what is the value of \\(x - 2\\)?', ['\\(7\\)', '\\(9\\)', '\\(5\\)', '\\(24\\)'], 0),
  plainLinear: grid('If 5x - 3 = 2x + 12, what is the value of x?', '5'),
  classmarkerFraction: grid('If ^{x}/_{4} = 6, what is the value of ^{12}/_{x}?', '1/2'),
  system: mc('3x + 2y = 16\nx - y = 2\n\nThe solution to the given system of equations is (x, y). What is the value of x + y?', ['6', '4', '2', '-6'], 0),
  sumOfSolutions: grid('\\((x - 6)(x + 2) = 0\\)\n\nWhat is the sum of the solutions to the given equation?', '4'),
  absolute: grid('|x - 3| + 4 = 9\n\nWhat is the sum of the solutions to the given equation?', '6'),
  functionValue: mc('The function f is defined by f(x) = 2x^{2} - 5. What is the value of f(3)?', ['13', '31', '1', '-13'], 0),
  functionInput: grid('The function g is defined by \\(g(x) = \\frac{x + 4}{3}\\), and \\(g(a) = 5\\), where \\(a\\) is a constant. What is the value of \\(a\\)?', '11'),
  equivalent: mc('Which expression is equivalent to (x + 4)(2x − 3)?', ['2x^{2} + 5x − 12', '2x^{2} − 12', '2x^{2} + 11x − 12', '2x^{2} + 5x + 12'], 0),
  identity: grid('The expression \\(18x^{4} - 12x^{3}\\) is equivalent to \\(rx^{3}(3x - 2)\\), where \\(r\\) is a constant. What is the value of \\(r\\)?', '6'),
  noSolutionCount: mc('How many solutions does the equation 4x + 3 = 4x + 9 have?', ['Zero', 'Exactly one', 'Exactly two', 'Infinitely many'], 0),
};

// ------------------------------------------------------------------ parsing

test('the three notations parse to the same tree', () => {
  const latex = parse('\\frac{x + 1}{3} = 2x - 5');
  const classmarker = parse('^{(x + 1)}/_{3} = 2x − 5');
  assert.ok(same(latex, classmarker));
  assert.equal(toTex(latex), '\\frac{x + 1}{3} = 2x - 5');
  assert.equal(toTex(parse('R₁ = ^{34R₂}/_{(R₂ − 34)}')), 'R_{1} = \\frac{34R_{2}}{R_{2} - 34}');
});

test('ambiguous notation is refused, not guessed', () => {
  for (const bad of ['1/2x', 'x = √7fg /10', '5 ^{3}/_{4}', '(10x)2']) {
    assert.throws(() => parse(bad), bad);
  }
});

test('printing a tree and parsing it again gives the same tree', () => {
  for (const src of ['-7(13 - 5x) + 3 = -8(13 - 5x) + 21', '\\left|2x - 3\\right| + 1', '500(1.03)^{t}', 'y = 1,200 - 75m', '\\frac{2}{3}(3h) - \\frac{5}{2}(h - 1)']) {
    const t = parse(src);
    assert.ok(same(parse(toTex(t)), t), src);
  }
});

test('segmentation finds bare math in prose and leaves words, tables and compounds alone', () => {
  const seg = segment('If 3x + 5 = 20, what is the value of x in the xy-plane?\nx | y\n1 | 5');
  assert.equal(seg.spans.length, 1);
  assert.equal(seg.spans[0].src, '3x + 5 = 20');
  assert.deepEqual(seg.numbers.map((n) => n.text), ['1', '5']);
  assert.equal(segment('x + 5y = 5\nx - 5y = 3').spans.length, 2, 'two lines are two equations');
});

// ------------------------------------------------------------------ algebra

test('exact solving: extraneous roots, systems, and the no-solution cases', () => {
  const eq = (s) => { const t = parse(s); const l = P.fromTree(t.l); const r = P.fromTree(t.r); return { p: P.sub(P.mul(l.num, r.den), P.mul(r.num, l.den)), dens: [l.den, r.den] }; };
  const a = eq('\\frac{1}{x - 2} = \\frac{3}{x^{2} - 4}');
  const res = P.solveSystem([a.p], ['x'], { nonzero: a.dens });
  assert.deepEqual(res.solutions.map((s) => R.toPlain(s.x)), ['1'], 'x = 2 is extraneous');
  const sys = P.solveSystem([eq('2x + 4y = 13').p, eq('x - 3y = -11').p], ['x', 'y']);
  assert.equal(R.toPlain(sys.solutions[0].x), '-1/2');
  assert.equal(P.solveSystem([eq('3x + y = 21').p, eq('6x + 2y = 40').p], ['x', 'y']).status, 'none');
  assert.equal(P.solveSystem([eq('3x + y = 21').p, eq('6x + 2y = 42').p], ['x', 'y']).status, 'infinite');
  const surd = P.realRoots([R.Q(4), R.Q(6), R.Q(1)]).roots[0];
  assert.equal(`${R.toPlain(surd.a)} ${R.toPlain(surd.b)} ${surd.c}`, '-3 1 5');
});

test('grid-in answers accept what the SAT accepts', () => {
  assert.deepEqual(gridAnswer(R.Q(2, 3)).accepted, ['2/3', '0.667', '0.666', '.6667', '.6666']);
  assert.deepEqual(gridAnswer(R.Q(-7)).accepted, ['-7']);
  assert.equal(gridAnswer(R.Q(123457, 7)), null, 'does not fit the grid');
});

// ------------------------------------------------------------ understanding

test('every fixture is understood: the engine reproduces its key', () => {
  for (const [name, item] of Object.entries(FIXTURES)) {
    const u = understand(item);
    assert.ok(u.ok, `${name}: ${u.reason} ${u.detail || ''}`);
  }
});

test('a question whose key the engine does not reproduce is left alone', () => {
  const wrongKey = { ...FIXTURES.subexpression, correct_idx: 1 };
  assert.equal(understand(wrongKey).reason, 'solution differs from the key');
  const wrongGrid = { ...FIXTURES.plainLinear, answer_text: '4' };
  assert.equal(understand(wrongGrid).ok, false);
  const unreadable = mc('If x = √7fg /10, which expression gives g?', ['\\(1\\)', '\\(2\\)', '\\(3\\)', '\\(4\\)'], 0);
  assert.equal(understand(unreadable).ok, false);
});

test('classification follows the structure of the question', () => {
  const skill = (name) => classify(understand(FIXTURES[name]).model, understand(FIXTURES[name]).answer)[0];
  assert.equal(skill('plainLinear'), 'Linear equations in one variable');
  assert.equal(skill('system'), 'Systems of two linear equations in two variables');
  assert.equal(skill('sumOfSolutions'), 'Nonlinear equations in one variable and systems of equations in two variables');
  assert.equal(skill('functionValue'), 'Nonlinear functions');
  assert.equal(skill('functionInput'), 'Linear functions');
  assert.equal(skill('equivalent'), 'Equivalent expressions');
  assert.equal(skill('identity'), 'Equivalent expressions');
});

// ---------------------------------------------------------------- variation

test('every fixture yields variants that pass the independent check', () => {
  for (const [name, item] of Object.entries(FIXTURES)) {
    const u = understand(item);
    const out = vary(u, { count: 3, seed: 5 });
    assert.ok(out.variants.length >= 1, `${name}: ${JSON.stringify(out.rejected)}`);
    for (const v of out.variants) {
      assert.notEqual(v.question, item.question, `${name}: a variant must differ`);
      const again = verifyVariant(v, { askKind: u.model.ask.kind });
      assert.ok(again.verified, `${name}: ${again.errors.join('; ')}`);
      if (v.answerType !== 'grid-in') {
        assert.equal(new Set(v.choices).size, 4, `${name}: four distinct choices`);
        for (const [i, letter] of ['A', 'B', 'C', 'D'].entries()) {
          if (i === v.correctIdx) assert.ok(!(letter in v.rationale), `${name}: no why-wrong on the key`);
          else assert.match(v.rationale[letter], /^This\b/, `${name}: every wrong choice explained`);
        }
      }
    }
  }
});

test('the independent check rejects a variant with a wrong key or a wrong grid answer', () => {
  const mcItem = understand(FIXTURES.subexpression);
  const [v] = vary(mcItem, { count: 1, seed: 9 }).variants;
  const moved = { ...v, correctIdx: (v.correctIdx + 1) % 4, rationale: { ...v.rationale } };
  assert.equal(verifyVariant(moved, { askKind: 'value' }).verified, false);
  const gridItem = understand(FIXTURES.plainLinear);
  const [g] = vary(gridItem, { count: 1, seed: 9 }).variants;
  assert.equal(verifyVariant({ ...g, answerText: String(Number(g.answerText) + 1) }, { askKind: 'value' }).verified, false);
});

test('variants keep the structure the question turns on', () => {
  // The target stays a subexpression of the equation, and its numbers move together.
  const u = understand(FIXTURES.subexpression);
  for (const v of vary(u, { count: 3, seed: 3 }).variants) {
    const m = v.question.match(/If \\\((\d+)\(x - (\d+)\) = (\d+)\\\), what is the value of \\\(x - (\d+)\\\)/);
    assert.ok(m, v.question);
    assert.equal(m[2], m[4], 'the same subexpression in the equation and the question');
  }
  // A fraction in lowest terms stays in lowest terms and proper.
  const f = understand(grid('If \\(\\frac{3}{4}x + 2 = 11\\), what is the value of \\(x\\)?', '12'));
  for (const v of vary(f, { count: 3, seed: 3 }).variants) {
    const [, n, d] = v.question.match(/\\frac\{(\d+)\}\{(\d+)\}/);
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    assert.equal(gcd(Number(n), Number(d)), 1, v.question);
    assert.ok(Number(n) < Number(d), v.question);
  }
});

test('the same seed makes the same variants', () => {
  const u = understand(FIXTURES.system);
  const a = vary(u, { count: 2, seed: 42 }).variants.map((v) => v.question);
  const b = vary(understand(FIXTURES.system), { count: 2, seed: 42 }).variants.map((v) => v.question);
  assert.deepEqual(a, b);
});

test('a question and its variants share one lineage', () => {
  assert.equal(lineageOf({ id: 'src', variant_of: null }), 'src');
  assert.equal(lineageOf({ id: 'v1', variant_of: 'src' }), 'src');
});

// -------------------------------------------------------------- word problems

const word = (question, choices, correctIdx, rationale = {}) => ({ ...mc(question, choices, correctIdx), rationale });
const wgrid = (question, answer, rationale = {}) => ({ ...grid(question, answer), rationale });

test('a word problem binds its key and distractors to formulas of its numbers and varies them', () => {
  const gym = word('A gym charges a one-time fee of $40 plus $15 per month. What is the total cost of a membership lasting 12 months?', ['$220', '$180', '$55', '$660'], 0);
  const u = understand(gym);
  assert.ok(u.ok && u.kind === 'word', u.reason);
  const out = vary(u, { count: 3, seed: 4 });
  assert.ok(out.variants.length >= 2, JSON.stringify(out.rejected));
  for (const v of out.variants) {
    const [fee, rate, months] = [...v.question.matchAll(/\$?(\d+)/g)].map((m) => Number(m[1]));
    const key = v.choices[v.correctIdx];
    assert.equal(key, `$${fee + rate * months}`, v.question);
    for (const [i, letter] of ['A', 'B', 'C', 'D'].entries()) if (i !== v.correctIdx) assert.match(v.rationale[letter], /^This\b/);
  }
});

test('facts of the world never vary: stated conversions and numbers inside a stated formula', () => {
  const conversion = wgrid('A trail is 12 miles long. How long is the trail in kilometers? (Use 1 mile = 1.6 kilometers.)', '19.2');
  const mm = wgrid('A snail moves 650 millimeters per minute. If there are 10 millimeters in a centimeter, how many centimeters does it move in 7 minutes?', '455');
  const law = wgrid('The function f(x) = 180(x - 2) gives the sum of the interior angles, in degrees, of a polygon with x sides. What is the sum of the interior angles of a polygon with 9 sides?', '1260');
  for (const [item, keep] of [[conversion, /1 mile = 1\.6 kilometers/], [mm, /10 millimeters in a centimeter/], [law, /f\(x\) = 180\(x - 2\)/]]) {
    const u = understand(item);
    assert.ok(u.ok, `${item.question}: ${u.reason}`);
    const out = vary(u, { count: 2, seed: 8 });
    assert.ok(out.variants.length, JSON.stringify(out.rejected));
    for (const v of out.variants) assert.match(v.question, keep);
  }
});

test('a number that more than one formula could explain is refused, not guessed', () => {
  // 9 is 3 squared, but also 4 + 2 + 3: the question cannot say which.
  const circle = word('A circle in the xy-plane has center (4, -2) and radius 3. Which equation could define the circle?',
    ['(x - 4)^{2} + (y + 2)^{2} = 9', '(x + 4)^{2} + (y - 2)^{2} = 9', '(x - 4)^{2} + (y + 2)^{2} = 3', '(x + 4)^{2} + (y - 2)^{2} = 3'], 0);
  assert.equal(understand(circle).ok, false);
});

test('percent is a unit: a percent is never added to a plain number', () => {
  // 231 / (1 + 10) is 21 only because the increase happens to be 10%. With
  // percent as a unit that reading is no formula, and the engine finds the
  // real one, 231p / (100 + p), written with each number once.
  const growth = understand(wgrid('After a 10% increase, a school has 231 students. How many more students does it have than before the increase?', '21'));
  assert.ok(growth.ok, growth.reason);
  for (const v of vary(growth, { count: 3, seed: 6 }).variants) {
    const [p, total] = [...v.question.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(Number(v.answerText), (total * p) / (100 + p), v.question);
  }
});

test('percents carry a unit: 380% of n is 38 gives n = 38 * 100 / 380', () => {
  const u = understand(word('If 380% of n is 38, what is the value of n?', ['10', '144.4', '3.8', '38'], 0));
  assert.ok(u.ok, u.reason);
  for (const v of vary(u, { count: 3, seed: 2 }).variants) {
    const [p, whole] = [...v.question.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(Number(v.choices[v.correctIdx].replace(/,/g, '')), (whole * 100) / p, v.question);
  }
});

test('a constant of the world is never read as a coincidence of the stated numbers', () => {
  // 180 = 5 * 9 * 2 * 2 on these numbers; the real 180 is degrees in pi radians.
  const angle = word('The measure of angle M is \\(\\frac{2\\pi}{9}\\) radians. The measure of angle N is 5 times the measure of angle M. Which expression represents the measure, in degrees, of angle N?',
    ['\\(\\frac{2}{9}(180)(5)\\)', '\\(\\frac{2}{9}(90)(5)\\)', '\\(\\frac{9}{2}(180)(5)\\)', '\\(\\frac{2}{9}(360)(5)\\)'], 0);
  const u = understand(angle);
  if (!u.ok) return; // refusing is safe
  for (const v of vary(u, { count: 3, seed: 1 }).variants) assert.match(v.choices[v.correctIdx], /\(180\)/, v.question);
});
