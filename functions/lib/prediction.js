// A student's predicted SAT score: what their answers so far say they would
// most likely score on a full practice test here today, with a range. Every
// answered question counts, from tests and practice sets alike, not only the
// last test's score.
//
// The model is the simplest of item response theory (Rasch): a student
// answers a question right with probability σ(θ − b), where θ is their
// ability and b the question's difficulty, easy, medium and hard a logit apart
// (DIFFICULTY). So a hard question answered right says more than an easy one,
// and a run of easy questions answered right does not read as a high score.
//
// Each section has an ability, and each skill an offset from it of its own
// (SKILL), heavy-tailed: practice keeps returning to a student's weakest
// skills, and with a single ability for the whole section those answers would
// drag it down, though a test spreads its questions over every skill. A skill
// the student has not met is as likely as any to sit above or below the
// section's ability.
//
// The prediction is the score those abilities would earn, on average, on a
// full practice test: the blueprint's questions per domain, spread over each
// domain's skills, at the difficulty each module serves (MIX), Module 1
// routing Module 2, and the section scaled by the app's own scoring
// (lib/scoring.js), so a prediction and a practice test's score are on one
// scale. It is computed from SAMPLES draws of the abilities given the answers:
// their mean is the prediction, and 80% of them fall in its range.
//
// A student improves, so newer answers count more: an answer weighs half as
// much as one given HALF_LIFE_DAYS after it, counted back from the section's
// newest answer (so a prediction does not drift while nothing new comes in).
// A question left blank is left out: it says nothing of what the student
// knows. A section is predicted once there is enough to go on (READY): enough
// answers, over enough of what the test asks (a few skills alone leave the
// rest of the section open), and the student's level known, or the score
// known within a few dozen points anyway (at either end of the scale, where a
// level is hard to pin down and matters little).
//
// Pure: lib/practice.js reads the answers, lib/students.js caches the result
// on the student's account for the rosters. `npm run check:prediction` checks
// it on simulated students whose abilities are known.

import { FULL_SAT_SPEC } from './blueprints.js';
import { routeFromModule1, sectionScaledScore } from './scoring.js';
import { DOMAINS, SKILLS } from './taxonomy.js';

/** Bump when the model changes: predictions cached on accounts are recomputed. */
export const PREDICTION_MODEL = 1;

/** Where each difficulty sits on the ability scale, in logits. */
export const DIFFICULTY = { easy: -1, medium: 0, hard: 1 };

/** A section's ability before any answer: an average student, give or take a lot. */
export const PRIOR = { mean: 0, sd: 1.2 };

/** A skill's offset from its section's ability: a Student t of this scale and degrees of freedom. */
export const SKILL = { scale: 0.6, df: 3 };

/** Days after which an answer counts half as much as the newest. */
export const HALF_LIFE_DAYS = 30;

/**
 * When a section is predicted: at least `answers` of its questions answered,
 * in skills that make up at least `breadth` of a test's questions, and either
 * the section's ability known within `sd` (logits, one standard deviation) or
 * the score's 80% range within `span` points.
 */
export const READY = { answers: 30, breadth: 0.5, sd: 0.5, span: 100 };

/**
 * The difficulty of each module's questions. Module 1 takes the most exam-like
 * questions whatever their difficulty, the College Board's newest release
 * first, so its mix is that release's (measured on fresh students' full tests
 * on 2026-11-02: Reading and Writing is over half hard). Module 2 serves its
 * route's difficulty.
 */
export const MIX = {
  rw: { easy: 0.14, medium: 0.30, hard: 0.56 },
  math: { easy: 0.38, medium: 0.35, hard: 0.27 },
  easy: { easy: 1, medium: 0, hard: 0 },
  hard: { easy: 0, medium: 0, hard: 1 },
};

// Draws a prediction rests on, from a fixed seed: the same answers always give
// the same prediction.
const SAMPLES = 400;
const SEED = 20261102;

const LEVELS = ['easy', 'medium', 'hard'];
const DAY_MS = 24 * 3600 * 1000;

// The ability grid (θ) and the offset grid (δ) share a step, so θ + δ falls
// on a third grid, indexed by the sum of their indices.
const STEP = 0.05;
const THETA_MIN = -5;
const THETAS = 201; // θ from -5 to 5
const DELTA_HALF = 60; // δ from -3 to 3
const DELTAS = 2 * DELTA_HALF + 1;
const SUMS = THETAS + DELTAS - 1;
const thetaAt = (i) => THETA_MIN + i * STEP;
const sumAt = (m) => THETA_MIN + (m - DELTA_HALF) * STEP;

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
/** log σ(z), without overflow. */
const logSigmoid = (z) => (z >= 0 ? -Math.log1p(Math.exp(-z)) : z - Math.log1p(Math.exp(z)));

function logSumExp(xs) {
  let max = -Infinity;
  for (const x of xs) if (x > max) max = x;
  if (max === -Infinity) return max;
  let s = 0;
  for (const x of xs) s += Math.exp(x - max);
  return max + Math.log(s);
}

/** The cumulative distribution of log weights. */
function cumulative(logWeights) {
  const z = logSumExp(logWeights);
  const out = new Float64Array(logWeights.length);
  let c = 0;
  for (let k = 0; k < logWeights.length; k += 1) {
    c += Math.exp(logWeights[k] - z);
    out[k] = c;
  }
  return out;
}

/** The index a uniform draw u falls on in a cumulative distribution. */
function draw(cdf, u) {
  const target = u * cdf[cdf.length - 1];
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Seeded uniform random numbers (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A skill's offset: its density on the δ grid (normalized), and its
// cumulative distribution.
const OFFSET_PRIOR = (() => {
  const raw = Array.from({ length: DELTAS }, (_, j) => {
    const d = ((j - DELTA_HALF) * STEP) / SKILL.scale;
    return (1 + (d * d) / SKILL.df) ** (-(SKILL.df + 1) / 2);
  });
  const z = raw.reduce((a, b) => a + b, 0);
  return Float64Array.from(raw, (x) => x / z);
})();
const OFFSET_PRIOR_CDF = OFFSET_PRIOR.reduce((cdf, x, j) => { cdf[j] = (j ? cdf[j - 1] : 0) + x; return cdf; }, new Float64Array(DELTAS));

// σ(θ + δ − b) for each point of the sum grid, at each difficulty.
const P_RIGHT = Array.from({ length: SUMS }, (_, m) => LEVELS.map((d) => sigmoid(sumAt(m) - DIFFICULTY[d])));

/**
 * What one skill's answers (weighted counts per difficulty) say: for each θ_i,
 * the log likelihood of the answers with the skill's offset integrated out,
 * and the offset's distribution given θ_i (for drawing it).
 */
function skillEvidence(counts) {
  // The answers' likelihood on the sum grid, relative to its peak.
  const ll = new Float64Array(SUMS);
  let peak = -Infinity;
  for (let m = 0; m < SUMS; m += 1) {
    let s = 0;
    for (const d of LEVELS) {
      const { n, right } = counts[d];
      if (!n) continue;
      const z = sumAt(m) - DIFFICULTY[d];
      s += right * logSigmoid(z) + (n - right) * logSigmoid(-z);
    }
    ll[m] = s;
    if (s > peak) peak = s;
  }
  const lik = Float64Array.from(ll, (x) => Math.exp(x - peak));
  const logLik = new Float64Array(THETAS);
  for (let i = 0; i < THETAS; i += 1) {
    let s = 0;
    for (let j = 0; j < DELTAS; j += 1) s += OFFSET_PRIOR[j] * lik[i + j];
    logLik[i] = Math.log(s) + peak;
  }
  const cdfs = new Map();
  const offsetCdf = (i) => {
    if (!cdfs.has(i)) {
      const cdf = new Float64Array(DELTAS);
      let c = 0;
      for (let j = 0; j < DELTAS; j += 1) { c += OFFSET_PRIOR[j] * lik[i + j]; cdf[j] = c; }
      cdfs.set(i, cdf);
    }
    return cdfs.get(i);
  };
  return { logLik, offsetCdf };
}

/** The binomial distribution of right answers out of n at probability p. */
function binomial(n, p) {
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
  const out = new Float64Array(n + 1);
  out[0] = (1 - q) ** n;
  for (let k = 0; k < n; k += 1) out[k + 1] = (out[k] * (n - k) * q) / ((k + 1) * (1 - q));
  return out;
}

/**
 * The full SAT's shape for one section: each module's questions and their
 * shares per skill (a domain's questions spread evenly over its skills), the
 * difficulty they are served at, the routing bar, and the scaled score of
 * every result (c1 right in Module 1, c2 in Module 2).
 */
function testShape(kind) {
  const section = FULL_SAT_SPEC.sections.find((s) => s.kind === kind);
  const [m1, m2] = section.modules;
  const shares = (domains, n) => new Map(Object.entries(domains)
    .flatMap(([domain, count]) => SKILLS[domain].map((skill) => [skill, count / n / SKILLS[domain].length])));
  const threshold = FULL_SAT_SPEC.routing.thresholdFraction;
  const n1 = m1.count;
  const n2 = m2.count;
  const routes = Array.from({ length: n1 + 1 }, (_, c1) => routeFromModule1(c1, n1, threshold));
  const scaled = routes.map((route, c1) => Array.from({ length: n2 + 1 }, (_, c2) => sectionScaledScore(c1, n1, c2, n2, route)));
  return {
    n1, n2, routes, scaled,
    modules: [
      { shares: shares(m1.domains, n1), mix: MIX[kind] },
      { shares: shares(m2.domains, n2), mix: MIX.easy },
      { shares: shares(m2.domains, n2), mix: MIX.hard },
    ],
  };
}
const SHAPES = { rw: testShape('rw'), math: testShape('math') };

/**
 * The expected scaled score of a full section whose Module 1 questions are
 * each right with probability p1, and Module 2's with p2.easy or p2.hard by
 * the route Module 1 earns.
 */
export function expectedSectionScore(kind, p1, p2) {
  const { n1, n2, routes, scaled } = SHAPES[kind];
  const first = binomial(n1, p1);
  const second = { easy: binomial(n2, p2.easy), hard: binomial(n2, p2.hard) };
  let total = 0;
  for (let c1 = 0; c1 <= n1; c1 += 1) {
    if (first[c1] < 1e-15) continue;
    const dist = second[routes[c1]];
    const row = scaled[c1];
    let e = 0;
    for (let c2 = 0; c2 <= n2; c2 += 1) e += dist[c2] * row[c2];
    total += first[c1] * e;
  }
  return total;
}

/**
 * Draws of the score a full section would earn on average, given a section's
 * answers ({ domain, skill, difficulty, correct, weight }); how well the
 * answers pin the section's ability down (its standard deviation); and the
 * share of a test's questions in skills the answers touch.
 */
function sectionDraws(kind, answers, rand) {
  const shape = SHAPES[kind];
  const testSkills = [...shape.modules[0].shares.keys()];
  // A question filed under none of the College Board's skills still tells of
  // the section, as a skill of its own.
  const counts = new Map();
  for (const a of answers) {
    const key = shape.modules[0].shares.has(a.skill) ? a.skill : `${a.domain}|${a.skill}`;
    if (!counts.has(key)) counts.set(key, Object.fromEntries(LEVELS.map((d) => [d, { n: 0, right: 0 }])));
    const c = counts.get(key)[LEVELS.includes(a.difficulty) ? a.difficulty : 'medium'];
    c.n += a.weight;
    if (a.correct) c.right += a.weight;
  }
  const evidence = new Map([...counts].map(([skill, c]) => [skill, skillEvidence(c)]));

  const logPost = Array.from({ length: THETAS }, (_, i) => {
    let s = -0.5 * ((thetaAt(i) - PRIOR.mean) / PRIOR.sd) ** 2;
    for (const e of evidence.values()) s += e.logLik[i];
    return s;
  });
  const thetaCdf = cumulative(logPost);
  let m1 = 0;
  let m2 = 0;
  for (let i = 0; i < THETAS; i += 1) {
    const w = thetaCdf[i] - (i ? thetaCdf[i - 1] : 0);
    m1 += w * thetaAt(i);
    m2 += w * thetaAt(i) ** 2;
  }

  // Each test skill's share of each module's questions, at its difficulties.
  const weights = testSkills.map((skill) => shape.modules.map((mod) => {
    const share = mod.shares.get(skill);
    return [share * mod.mix.easy, share * mod.mix.medium, share * mod.mix.hard];
  }));
  const skillEvidenceOf = testSkills.map((skill) => evidence.get(skill) || null);
  const draws = new Float64Array(SAMPLES);
  for (let k = 0; k < SAMPLES; k += 1) {
    const i = draw(thetaCdf, rand());
    const p = [0, 0, 0];
    for (let s = 0; s < testSkills.length; s += 1) {
      const e = skillEvidenceOf[s];
      const right = P_RIGHT[i + draw(e ? e.offsetCdf(i) : OFFSET_PRIOR_CDF, rand())];
      for (let t = 0; t < 3; t += 1) {
        const w = weights[s][t];
        p[t] += w[0] * right[0] + w[1] * right[1] + w[2] * right[2];
      }
    }
    draws[k] = expectedSectionScore(kind, p[0], { easy: p[1], hard: p[2] });
  }
  const breadth = testSkills.reduce((sum, skill) => sum + (evidence.has(skill) ? shape.modules[0].shares.get(skill) : 0), 0);
  return { draws, sd: Math.sqrt(Math.max(0, m2 - m1 * m1)), breadth };
}

const round10 = (x) => Math.round(x / 10) * 10;

/** A score's mean and 80% range from its draws, to tens and within [lo, hi]. */
function summarize(draws, lo, hi) {
  const sorted = [...draws].sort((a, b) => a - b);
  const at = (q) => {
    const x = (sorted.length - 1) * q;
    const k = Math.floor(x);
    return sorted[k] + (x - k) * ((sorted[k + 1] ?? sorted[k]) - sorted[k]);
  };
  const clamp = (x) => Math.max(lo, Math.min(hi, round10(x)));
  const score = clamp(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  return {
    score,
    low: Math.min(score, clamp(at(0.1))),
    high: Math.max(score, clamp(at(0.9))),
    span: at(0.9) - at(0.1),
  };
}

/**
 * The prediction from a student's answers, each { section: 'rw' | 'math',
 * domain, skill, difficulty, correct, answered, at } (`answered` false for a
 * question left blank, `at` when its session was finished). Each section is
 * { score, low, high, answered, ready }, its numbers null until it is ready;
 * `total` is null until both are.
 */
export function predictScore(answers) {
  const out = { answered: 0, total: null };
  const rand = random(SEED);
  const ready = {};
  for (const kind of ['rw', 'math']) {
    const mine = answers.filter((a) => a.section === kind && a.answered !== false);
    out.answered += mine.length;
    out[kind] = { score: null, low: null, high: null, answered: mine.length, ready: false };
    if (mine.length < READY.answers) continue;
    const time = (a) => (a.at ? new Date(a.at).getTime() : NaN);
    const newest = mine.reduce((m, a) => (time(a) > m ? time(a) : m), -Infinity);
    const weighted = mine.map((a) => {
      const age = Number.isFinite(time(a)) ? Math.max(0, (newest - time(a)) / DAY_MS) : 0;
      return { ...a, weight: 0.5 ** (age / HALF_LIFE_DAYS) };
    });
    const { draws, sd, breadth } = sectionDraws(kind, weighted, rand);
    const { span, ...range } = summarize(draws, 200, 800);
    if (breadth < READY.breadth || (sd > READY.sd && span > READY.span)) continue;
    ready[kind] = draws;
    out[kind] = { ...range, answered: mine.length, ready: true };
  }
  if (ready.rw && ready.math) {
    // The total is its sections' sum, as on the SAT; its range is the sum's own.
    const { low, high } = summarize(ready.rw.map((x, k) => x + ready.math[k]), 400, 1600);
    const score = out.rw.score + out.math.score;
    out.total = { score, low: Math.min(score, low), high: Math.max(score, high) };
  }
  return out;
}

/** The College Board's skills of a section. */
export const sectionSkills = (kind) => DOMAINS[kind].flatMap((d) => SKILLS[d]);
