// The predicted score (lib/prediction.js), on simulated students whose
// abilities are known: each answers as the model says a student of their
// ability would, through a full test assembled and scored as the app's are,
// and through skill sets on the skills their record shows as weakest, as the
// app recommends them. Their true score is what their abilities would earn on
// average on a full test. Seeded, so every run sees the same students.
//
//   npm run check:prediction

import test from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTY, MIX, READY, expectedSectionScore, predictScore, sectionSkills } from '../lib/prediction.js';
import { FULL_SAT_SPEC } from '../lib/blueprints.js';
import { routeFromModule1, sectionScaledScore } from '../lib/scoring.js';
import { SKILLS, domainForSkill } from '../lib/taxonomy.js';

let seed = 1;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-09-01');

/** A student: an ability per section, and each skill's offset from it. */
function student(rw = gauss(), math = gauss()) {
  const offset = {};
  for (const skills of Object.values(SKILLS)) for (const s of skills) offset[s] = 0.7 * gauss();
  return { theta: { rw, math }, offset };
}
const ability = (st, kind, skill) => st.theta[kind] + st.offset[skill];

/** What a student's abilities would earn on average on a full section. */
function trueScore(st, kind) {
  const [m1, m2] = FULL_SAT_SPEC.sections.find((s) => s.kind === kind).modules;
  const p = (mix, domains, n) => Object.entries(domains).reduce((sum, [d, count]) => sum + SKILLS[d].reduce((s, skill) => s
    + (count / n / SKILLS[d].length) * Object.entries(mix).reduce((a, [lvl, w]) => a + w * sigmoid(ability(st, kind, skill) - DIFFICULTY[lvl]), 0), 0), 0);
  return expectedSectionScore(kind, p(MIX[kind], m1.domains, m1.count),
    { easy: p(MIX.easy, m2.domains, m2.count), hard: p(MIX.hard, m2.domains, m2.count) });
}

function pick(mix) {
  const r = rand();
  let c = 0;
  for (const [d, w] of Object.entries(mix)) { c += w; if (r < c) return d; }
  return 'hard';
}

const answer = (st, kind, skill, difficulty, at, blank = false) => ({
  section: kind, domain: domainForSkill(skill), skill, difficulty, at,
  answered: !blank, correct: !blank && rand() < sigmoid(ability(st, kind, skill) - DIFFICULTY[difficulty]),
});

/** A full section, routed and scaled as the app does: its answers and its score. */
function fullSection(st, kind, at, blankRate = 0) {
  const [m1, m2] = FULL_SAT_SPEC.sections.find((s) => s.kind === kind).modules;
  const module = (domains, mix) => Object.entries(domains).flatMap(([d, count]) => Array.from({ length: count },
    () => answer(st, kind, SKILLS[d][Math.floor(rand() * SKILLS[d].length)], pick(mix), at, rand() < blankRate)));
  const first = module(m1.domains, MIX[kind]);
  const right1 = first.filter((a) => a.correct).length;
  const route = routeFromModule1(right1, m1.count, FULL_SAT_SPEC.routing.thresholdFraction);
  const second = module(m2.domains, MIX[route]);
  return { answers: [...first, ...second], score: sectionScaledScore(right1, m1.count, second.filter((a) => a.correct).length, m2.count, route) };
}

/** A skill set: `n` questions on each skill, at one difficulty. */
const skillSet = (st, kind, skills, n, difficulty, at) => skills.flatMap((skill) => Array.from({ length: n }, () => answer(st, kind, skill, difficulty, at)));

/** The skills a record shows as weakest, as the app picks them (lib/practice.js). */
function weakest(answers, kind, k) {
  const seen = new Map();
  for (const a of answers) {
    if (a.section !== kind) continue;
    const g = seen.get(a.skill) || { n: 0, right: 0 };
    g.n += 1;
    if (a.correct) g.right += 1;
    seen.set(a.skill, g);
  }
  const mastery = (s) => (seen.get(s).right + 1) / (seen.get(s).n + 2);
  return [...seen.keys()].filter((s) => seen.get(s).right < seen.get(s).n)
    .sort((a, b) => mastery(a) - mastery(b) || seen.get(b).n - seen.get(a).n).slice(0, k);
}

const shuffled = (xs) => xs.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Over `n` students: how often each section is ready, its mean error and bias, and how often the range holds the truth. */
function measure(n, make, kind = 'math') {
  const out = { ready: 0, errors: [], bias: [], covered: 0, spans: [] };
  for (let k = 0; k < n; k += 1) {
    const st = student();
    const p = predictScore(make(st))[kind];
    if (!p.ready) continue;
    const truth = trueScore(st, kind);
    out.ready += 1;
    out.errors.push(Math.abs(p.score - truth));
    out.bias.push(p.score - truth);
    out.spans.push(p.high - p.low);
    if (truth >= p.low - 5 && truth <= p.high + 5) out.covered += 1;
  }
  return { ready: out.ready / n, error: mean(out.errors), bias: mean(out.bias), coverage: out.covered / out.ready, span: mean(out.spans) };
}

test('with nothing answered there is nothing to predict', () => {
  const p = predictScore([]);
  assert.equal(p.total, null);
  assert.equal(p.answered, 0);
  for (const kind of ['rw', 'math']) assert.deepEqual(p[kind], { score: null, low: null, high: null, answered: 0, ready: false });
});

test('a full test is enough to go on, a skill set or two is not', () => {
  seed = 11;
  const full = measure(60, (st) => fullSection(st, 'math', T0).answers);
  assert.equal(full.ready, 1, 'every full test is ready');
  const oneSet = measure(60, (st) => skillSet(st, 'math', shuffled(sectionSkills('math')).slice(0, 3), 4, 'medium', T0));
  const twoSets = measure(60, (st) => [0, 1].flatMap((k) => skillSet(st, 'math', shuffled(sectionSkills('math')).slice(0, 3), 4, 'medium', T0 + k * DAY)));
  assert.equal(oneSet.ready, 0);
  assert.equal(twoSets.ready, 0);
  // Answers enough, but on three skills only: the rest of the section is open.
  const narrow = measure(40, (st) => skillSet(st, 'math', shuffled(sectionSkills('math')).slice(0, 3), 12, 'medium', T0));
  assert.ok(narrow.ready < 0.2, `three skills alone are rarely enough (${narrow.ready})`);
  // Practice that ranges over the section gets there too.
  const eightSets = measure(60, (st) => Array.from({ length: 8 }, (_, k) => skillSet(st, 'math', shuffled(sectionSkills('math')).slice(0, 3), 4, 'medium', T0 + k * DAY)).flat());
  assert.ok(eightSets.ready > 0.8, `eight sets over the section mostly are (${eightSets.ready})`);
  assert.ok(eightSets.coverage > 0.7, `and their range holds (${eightSets.coverage})`);
});

test('after a full test the prediction is nearer the truth than the test score, on its scale', () => {
  seed = 21;
  for (const kind of ['rw', 'math']) {
    const testErrors = [];
    const m = measure(150, (st) => {
      const { answers, score } = fullSection(st, kind, T0);
      testErrors.push(Math.abs(score - trueScore(st, kind)));
      return answers;
    }, kind);
    assert.ok(m.error < mean(testErrors), `${kind}: prediction off by ${m.error.toFixed(1)}, the test by ${mean(testErrors).toFixed(1)}`);
    assert.ok(Math.abs(m.bias) < 10, `${kind}: biased by ${m.bias.toFixed(1)}`);
  }
});

test('the range holds the true score about four times in five', () => {
  seed = 31;
  for (const kind of ['rw', 'math']) {
    const m = measure(200, (st) => fullSection(st, kind, T0).answers, kind);
    assert.ok(m.coverage > 0.7 && m.coverage < 0.95, `${kind}: covered ${(100 * m.coverage).toFixed(0)}%`);
  }
});

test('practising the weakest skills does not drag the prediction down', () => {
  seed = 41;
  const m = measure(100, (st) => {
    const answers = [...fullSection(st, 'math', T0).answers];
    for (let k = 1; k <= 20; k += 1) answers.push(...skillSet(st, 'math', weakest(answers, 'math', 3), 4, 'easy', T0 + k * DAY));
    return answers;
  });
  assert.ok(Math.abs(m.bias) < 15, `biased by ${m.bias.toFixed(1)}`);
  assert.ok(m.coverage > 0.7, `covered ${(100 * m.coverage).toFixed(0)}%`);
  assert.ok(m.error < 30, `off by ${m.error.toFixed(1)}`);
});

test('a hard question answered right counts for more than an easy one', () => {
  seed = 51;
  const st = student(0, 0);
  const base = fullSection(st, 'math', T0).answers;
  const extra = (difficulty) => sectionSkills('math').map((skill) => ({ section: 'math', domain: domainForSkill(skill), skill, difficulty, correct: true, answered: true, at: T0 }));
  const easy = predictScore([...base, ...extra('easy')]).math.score;
  const hard = predictScore([...base, ...extra('hard')]).math.score;
  assert.ok(hard > easy, `hard ${hard}, easy ${easy}`);
});

test('more right answers never lower the prediction', () => {
  seed = 61;
  const st = student(0.3, 0.3);
  const answers = fullSection(st, 'math', T0).answers;
  let last = predictScore(answers).math.score;
  for (const a of answers.filter((x) => !x.correct).slice(0, 12)) {
    a.correct = true;
    const next = predictScore(answers).math.score;
    assert.ok(next >= last, `${next} after ${last}`);
    last = next;
  }
});

test('a question left blank is left out', () => {
  seed = 71;
  const answers = fullSection(student(0.5, 0.5), 'rw', T0, 0.2).answers;
  assert.ok(answers.some((a) => !a.answered));
  const all = predictScore(answers);
  const answeredOnly = predictScore(answers.filter((a) => a.answered));
  assert.deepEqual(all.rw, answeredOnly.rw);
  assert.equal(all.rw.answered, answers.filter((a) => a.answered).length);
});

test('newer answers count more, and the prediction holds still while nothing new comes in', () => {
  seed = 81;
  const errors = { weighted: [], flat: [] };
  for (let k = 0; k < 60; k += 1) {
    const st = student();
    const early = fullSection(st, 'math', T0).answers;
    st.theta.math += 1;
    const late = fullSection(st, 'math', T0 + 60 * DAY).answers;
    const truth = trueScore(st, 'math');
    errors.weighted.push(Math.abs(predictScore([...early, ...late]).math.score - truth));
    errors.flat.push(Math.abs(predictScore([...early, ...late].map((a) => ({ ...a, at: T0 + 60 * DAY }))).math.score - truth));
  }
  assert.ok(mean(errors.weighted) < mean(errors.flat), `weighted ${mean(errors.weighted).toFixed(1)}, flat ${mean(errors.flat).toFixed(1)}`);
  // Only how old answers are against the newest matters, not today's date.
  const answers = fullSection(student(), 'math', T0).answers;
  const later = answers.map((a) => ({ ...a, at: a.at + 90 * DAY }));
  assert.deepEqual(predictScore(answers), predictScore(later));
});

test('the total is the sum of its sections, each in range and to tens', () => {
  seed = 91;
  for (let k = 0; k < 20; k += 1) {
    const st = student();
    const p = predictScore([...fullSection(st, 'rw', T0).answers, ...fullSection(st, 'math', T0).answers]);
    assert.ok(p.rw.ready && p.math.ready && p.total);
    assert.equal(p.total.score, p.rw.score + p.math.score);
    for (const [part, lo, hi] of [[p.rw, 200, 800], [p.math, 200, 800], [p.total, 400, 1600]]) {
      assert.ok(lo <= part.low && part.low <= part.score && part.score <= part.high && part.high <= hi, JSON.stringify(part));
      for (const x of [part.low, part.score, part.high]) assert.equal(x % 10, 0);
    }
  }
  const mathOnly = predictScore(fullSection(student(), 'math', T0).answers);
  assert.equal(mathOnly.total, null);
  assert.equal(mathOnly.rw.ready, false);
  assert.equal(mathOnly.math.ready, true);
});

test('the same answers always give the same prediction, quickly', () => {
  seed = 101;
  const st = student();
  const answers = [...fullSection(st, 'rw', T0).answers, ...fullSection(st, 'math', T0).answers];
  for (let k = 1; k <= 30; k += 1) answers.push(...skillSet(st, 'math', weakest(answers, 'math', 3), 4, 'easy', T0 + k * DAY));
  const first = predictScore(answers);
  const started = performance.now();
  for (let k = 0; k < 10; k += 1) assert.deepEqual(predictScore(answers), first);
  const ms = (performance.now() - started) / 10;
  assert.ok(ms < 100, `${ms.toFixed(1)} ms for ${answers.length} answers`);
});

test('a perfect record is predicted near the top of the scale', () => {
  seed = 111;
  const answers = fullSection(student(4, 4), 'math', T0).answers.map((a) => ({ ...a, correct: true }));
  const p = predictScore(answers).math;
  assert.ok(p.ready, 'a perfect score is known well enough');
  assert.ok(p.score >= 740, `predicted ${p.score}`);
  assert.ok(answers.length >= READY.answers);
});
