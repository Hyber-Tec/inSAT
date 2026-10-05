// Deterministic SAT math item templates.
//
// Every template computes its own answer key in code and derives distractors
// from named student errors, so a generated item is correct by construction --
// no model call, no verification pass, no cost. Each distractor carries a
// student-facing explanation of the mistake that produces it, shown when a
// student reviews a question they missed. A template plus a seed always
// yields the same item, so the bank is reproducible and any bad item traces
// back to one template.
//
// Reading & Writing is deliberately NOT templated: those questions are novel
// prose, and a template only ever produces the same passage with the nouns
// swapped. Those go through the model (see generate.js / batch.js).

import { rng, frac, gcd, lead, term, round } from './rng.js';

const LETTERS = ['A', 'B', 'C', 'D'];

/**
 * Assemble four options from a correct answer and candidate distractors.
 *
 * Each distractor is `[value, why]`: the wrong answer and a student-facing
 * explanation of the mistake that produces it. A bare value is still accepted,
 * with no explanation. A duplicate or empty distractor is dropped together with
 * its explanation.
 *
 * Returns null when fewer than three distinct distractors survive, which tells
 * the caller to re-roll with another seed rather than ship a padded question.
 * Otherwise returns `{ choices, correctIdx, why }`, where `why[i]` explains
 * choice i and is null for the correct one.
 */
function choiceSet(r, correct, distractors) {
  const key = String(correct);
  const seen = new Set([key]);
  const kept = [];
  for (const d of distractors) {
    const [value, why = null] = Array.isArray(d) ? d : [d];
    if (value === null || value === undefined) continue;
    const s = String(value);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    kept.push({ value: s, why });
  }
  if (kept.length < 3) return null;
  const four = r.shuffle([{ value: key, why: null }, ...kept.slice(0, 3)]);
  return {
    choices: four.map((o) => o.value),
    correctIdx: four.findIndex((o) => o.value === key),
    why: four.map((o) => o.why),
  };
}

/**
 * Why each wrong choice is wrong, keyed by its letter in this item's own
 * choice order. The app shuffles choices per student and remaps these letters
 * itself, so no explanation may name a letter.
 */
const whyWrong = ({ why, correctIdx }) =>
  Object.fromEntries(why.flatMap((w, i) => (i === correctIdx || !w ? [] : [[LETTERS[i], w]])));

/** A multiple-choice item, explaining the correct answer and every wrong one. */
const mc = (question, set, rationale, extra = {}) =>
  set && {
    question,
    answerType: 'multiple-choice',
    choices: set.choices,
    correctIdx: set.correctIdx,
    rationale: { correct: rationale, ...whyWrong(set) },
    ...extra,
  };

/** A number written after an operator or under an exponent: parenthesized only when negative. */
const paren = (n) => (n < 0 ? `(${n})` : String(n));

/** `\frac{n}{d}` as written, followed by its reduced form when that reads differently. */
function ratio(n, d) {
  const raw = `\\frac{${n}}{${d}}`;
  const reduced = frac(n, d);
  return reduced === raw ? raw : `${raw} = ${reduced}`;
}

/** A grid-in (student-produced response) item. */
const grid = (question, answerText, rationale) => ({
  question,
  answerType: 'grid-in',
  choices: [],
  correctIdx: 0,
  answerText: String(answerText),
  rationale: { correct: rationale },
});

/** A polynomial in x from its coefficients, highest power first, with zero terms left out. */
function poly(...coefs) {
  const top = coefs.length - 1;
  const terms = coefs
    .map((k, i) => [k, top - i === 0 ? '' : top - i === 1 ? 'x' : `x^${top - i}`])
    .filter(([k]) => k !== 0);
  if (!terms.length) return '0';
  return terms.map(([k, sym], i) => (i === 0 ? lead(k, sym) : term(k, sym))).join(' ');
}

/** A whole number with thousands separators, as the SAT prints it: 48,000. */
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A phrase with its first letter capitalized, to open a sentence. */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "a" or "an" before a number as it is read aloud: an 8-mile trip, an 11-year-old, a 12-year-old. */
const an = (n) => (/^(?:8\d?|11|18)$/.test(String(n)) ? 'an' : 'a');

const PYTHAG = [[3, 4, 5], [6, 8, 10], [5, 12, 13], [9, 12, 15], [8, 15, 17], [7, 24, 25], [20, 21, 29]];

// Contexts for a line of best fit y = mx + b: what x and y measure, the range
// of slopes (in tenths), intercepts and x-values that keep the predictions
// realistic, and the two questions such a line answers. `change` lists the
// larger x-value first.
const BEST_FIT = [
  {
    setup: 'A teacher recorded the number of hours \\(x\\) that each student in a class spent studying for a test and the student\'s score \\(y\\), in points, on the test.',
    slopes: [15, 25, 35],
    intercepts: [45, 60],
    xs: [2, 10],
    one: 'hour', many: 'hours', what: 'score', unit: 'points',
    change: (hi, lo) => `how many more points is the predicted score for a student who studied ${hi} hours than for a student who studied ${lo} hours?`,
    reverse: (y) => `a student who studied for how many hours would have a predicted score of ${y} points?`,
  },
  {
    setup: 'A forester measured the age \\(x\\), in years, and the height \\(y\\), in feet, of each of 40 pine trees in a forest.',
    slopes: [8, 12, 15, 25],
    intercepts: [2, 9],
    xs: [2, 20],
    one: 'year', many: 'years', what: 'height', unit: 'feet',
    change: (hi, lo) => `how many feet taller is the predicted height of ${an(hi)} ${hi}-year-old tree than that of ${an(lo)} ${lo}-year-old tree?`,
    reverse: (y) => `at what age, in years, would a tree have a predicted height of ${y} feet?`,
  },
  {
    setup: 'A restaurant recorded the distance \\(x\\), in miles, and the time \\(y\\), in minutes, of each of its deliveries during one week.',
    slopes: [15, 25, 35],
    intercepts: [8, 20],
    xs: [2, 12],
    one: 'mile', many: 'miles', what: 'delivery time', unit: 'minutes',
    change: (hi, lo) => `how many minutes longer is the predicted time for ${an(hi)} ${hi}-mile delivery than for ${an(lo)} ${lo}-mile delivery?`,
    reverse: (y) => `what is the distance, in miles, of a delivery with a predicted time of ${y} minutes?`,
  },
  {
    setup: 'A restaurant manager recorded the number of employees \\(x\\) working each shift and the number of orders \\(y\\) completed during that shift.',
    slopes: [65, 75, 85],
    intercepts: [10, 30],
    xs: [2, 12],
    one: 'employee', many: 'employees', what: 'number of orders', unit: 'orders',
    change: (hi, lo) => `how many more orders are predicted for a shift with ${hi} employees than for a shift with ${lo} employees?`,
    reverse: (y) => `how many employees would be working a shift for which ${y} completed orders are predicted?`,
  },
];

// Surveys of a random sample drawn from a whole population: where, who, what
// those surveyed said, and the group of the whole population it estimates.
const SURVEYS = [
  { place: 'A city', members: 'registered voters', whose: "the city's registered voters", said: 'said they support building a new public library', asked: 'registered voters in the city who support building a new public library' },
  { place: 'A university', members: 'students', whose: "the university's students", said: 'said they ride the campus shuttle at least once a week', asked: 'students at the university who ride the campus shuttle at least once a week' },
  { place: 'A company', members: 'employees', whose: "the company's employees", said: 'said they would prefer a four-day workweek', asked: 'employees at the company who would prefer a four-day workweek' },
  { place: 'A county', members: 'households', whose: "the county's households", said: 'reported having at least one pet', asked: 'households in the county that have at least one pet' },
  { place: 'A state park', members: 'annual pass holders', whose: "the park's annual pass holders", said: 'said they would use a new bike trail', asked: 'annual pass holders who would use a new bike trail' },
];

// Studies of a treatment and an outcome. Each can be run with or without a
// random sample and with or without random assignment, so one context gives
// four different studies with four different right conclusions. `from` names
// the population on first mention and `pop` refers back to it; `treat` and
// `ing` are the treatment as a verb phrase and as a gerund; `result` is the
// difference observed, `effect` the same outcome as a noun phrase, and
// `measure` what the outcome measures.
const STUDIES = [
  {
    people: 'adults', from: 'adults who live in a large city', pop: 'adults who live in the city',
    treat: 'drink a cup of green tea every day', ing: 'drinking a cup of green tea every day',
    result: 'had significantly lower blood pressure', effect: 'lower blood pressure', measure: 'blood pressure',
  },
  {
    people: 'students', from: 'students at a large high school', pop: 'students at the school',
    treat: 'study with a flashcard app', ing: 'studying with a flashcard app',
    result: 'earned significantly higher quiz scores', effect: 'higher quiz scores', measure: 'quiz scores',
  },
  {
    people: 'employees', from: 'employees of a large company', pop: 'employees of the company',
    treat: 'work at a standing desk', ing: 'working at a standing desk',
    result: 'reported significantly less back pain', effect: 'less back pain', measure: 'back pain',
  },
  {
    people: 'adults', from: 'adults who live in a large county', pop: 'adults who live in the county',
    treat: 'take a 20-minute walk after dinner', ing: 'taking a 20-minute walk after dinner',
    result: 'slept significantly longer', effect: 'longer sleep', measure: 'how long they sleep',
  },
  {
    people: 'students', from: 'students at a large university', pop: 'students at the university',
    treat: 'listen to classical music while studying', ing: 'listening to classical music while studying',
    result: 'scored significantly higher on a reading test', effect: 'higher reading test scores', measure: 'reading test scores',
  },
  {
    people: 'patients', from: 'patients at a large clinic', pop: 'patients at the clinic',
    treat: 'use a reminder app for their medication', ing: 'using a reminder app for medication',
    result: 'missed significantly fewer doses', effect: 'fewer missed doses', measure: 'how many doses they miss',
  },
  {
    people: 'residents', from: 'residents of a large town', pop: 'residents of the town',
    treat: 'eat a serving of nuts every day', ing: 'eating a serving of nuts every day',
    result: 'had significantly lower cholesterol levels', effect: 'lower cholesterol levels', measure: 'cholesterol levels',
  },
  {
    people: 'drivers', from: 'drivers insured by a large insurance company', pop: 'drivers insured by the company',
    treat: 'use a phone app that tracks their driving', ing: 'using a phone app that tracks driving',
    result: 'had significantly fewer speeding incidents', effect: 'fewer speeding incidents', measure: 'how often they speed',
  },
  {
    people: 'teenagers', from: 'teenagers who live in a large state', pop: 'teenagers who live in the state',
    treat: 'stop using screens an hour before bed', ing: 'not using screens in the hour before bed',
    result: 'reported significantly better sleep quality', effect: 'better sleep quality', measure: 'sleep quality',
  },
  {
    people: 'members', from: 'members of a large gym chain', pop: 'members of the gym chain',
    treat: 'do a 10-minute stretching routine before each workout', ing: 'doing a 10-minute stretching routine before each workout',
    result: 'reported significantly fewer injuries', effect: 'fewer injuries', measure: 'how often they are injured',
  },
  {
    people: 'customers', from: 'customers of a large grocery chain', pop: 'customers of the grocery chain',
    treat: 'plan their meals with a meal-planning app', ing: 'planning meals with a meal-planning app',
    result: 'spent significantly less on groceries each week', effect: 'lower weekly grocery spending', measure: 'grocery spending',
  },
  {
    people: 'adults', from: 'adults over 65 who live in a large city', pop: 'adults over 65 who live in the city',
    treat: 'do puzzles for 30 minutes a day', ing: 'doing puzzles for 30 minutes a day',
    result: 'scored significantly higher on a memory test', effect: 'higher memory test scores', measure: 'memory test scores',
  },
];

export const MATH_TEMPLATES = [
  // ---------------------------------------------------------------- algebra
  {
    id: 'alg-linear-solve',
    domain: 'algebra',
    skill: 'Linear equations in one variable',
    difficulty: 'easy',
    build(r) {
      const a = r.int(2, 9);
      const k = r.nonZero(-6, 6);
      const x = r.nonZero(-9, 9);
      const b = a * k;
      const c = a * (x + k);
      const fix = `${b < 0 ? `Adding ${-b} to` : `Subtracting ${b} from`} both sides gives \\(${a}x = ${c - b}\\), so \\(x = ${x}\\).`;
      const set = choiceSet(r, x, [
        [x + 2 * k, `This ${b < 0 ? `subtracts ${-b} from` : `adds ${b} to`} both sides instead of ${b < 0 ? 'adding' : 'subtracting'} it, which leads to \\(${a}x = ${c + b}\\) and \\(x = ${x + 2 * k}\\). ${fix}`],
        [a * x, `This is the value of \\(${a}x\\), not \\(x\\). Dividing \\(${a}x = ${c - b}\\) by ${a} gives \\(x = ${x}\\).`],
        [-x, `This has the wrong sign. ${fix}`],
        [x + k, `This divides \\(${c}\\) by ${a} and ignores the \\(${term(b, '')}\\) on the left. ${fix}`],
      ]);
      return mc(
        `If \\(${lead(a, 'x')} ${term(b, '')} = ${c}\\), what is the value of \\(x\\)?`,
        set,
        `${b < 0 ? `Add ${-b} to` : `Subtract ${b} from`} both sides to get \\(${a}x = ${c - b}\\), then divide by ${a}: \\(x = ${x}\\).`,
      );
    },
  },
  {
    id: 'alg-slope',
    domain: 'algebra',
    skill: 'Linear equations in two variables',
    topic: 'Slope of a line through two points',
    difficulty: 'easy',
    build(r) {
      const x1 = r.int(-8, 8);
      const dx = r.nonZero(-6, 6);
      const x2 = x1 + dx;
      const y1 = r.int(-8, 8);
      const dy = r.nonZero(-9, 9);
      const y2 = y1 + dy;
      const fix = `Slope is the change in \\(y\\) over the change in \\(x\\): \\(${ratio(dy, dx)}\\).`;
      const set = choiceSet(r, frac(dy, dx), [
        [frac(dx, dy), `This divides the change in \\(x\\), \\(${dx}\\), by the change in \\(y\\), \\(${dy}\\). ${fix}`],
        [frac(-dy, dx), `This subtracts the \\(y\\)-values in the opposite order from the \\(x\\)-values: \\(\\frac{${y1} - ${paren(y2)}}{${x2} - ${paren(x1)}}\\). Subtracting both in the same order gives \\(${ratio(dy, dx)}\\).`],
        // Opposite x-coordinates sum to 0, and a sum over 0 is no value at all
        // (frac would hand back the bare numerator), so that draw re-rolls.
        [x2 + x1 === 0 ? null : frac(y2 + y1, x2 + x1), `This adds the coordinates, \\(\\frac{${y2} + ${paren(y1)}}{${x2} + ${paren(x1)}}\\), instead of subtracting them. ${fix}`],
      ]);
      return mc(
        `A line passes through the points \\((${x1}, ${y1})\\) and \\((${x2}, ${y2})\\). What is the slope of the line?`,
        set,
        `Slope is \\(\\frac{y_2 - y_1}{x_2 - x_1} = \\frac{${y2} - ${paren(y1)}}{${x2} - ${paren(x1)}} = ${frac(dy, dx)}\\).`,
      );
    },
  },
  {
    id: 'alg-system',
    domain: 'algebra',
    skill: 'Systems of two linear equations in two variables',
    topic: 'Systems of two linear equations',
    difficulty: 'medium',
    build(r) {
      const x = r.nonZero(-7, 7);
      const y = r.nonZero(-7, 7);
      const a1 = r.nonZero(-5, 5);
      const b1 = r.nonZero(-5, 5);
      const a2 = r.nonZero(-5, 5);
      const b2 = r.nonZero(-5, 5);
      if (a1 * b2 - a2 * b1 === 0) return null; // parallel or identical lines
      const c1 = a1 * x + b1 * y;
      const c2 = a2 * x + b2 * y;
      const sum = `The question asks for \\(x + y\\), which is \\(${x} ${term(y, '')} = ${x + y}\\).`;
      const set = choiceSet(r, x + y, [
        [x, `This is just the value of \\(x\\). ${sum}`],
        [y, `This is just the value of \\(y\\). ${sum}`],
        [x - y, `This subtracts \\(y\\) instead of adding it: \\(${x} - ${paren(y)} = ${x - y}\\). ${sum}`],
        [-(x + y), `This is the sum with the wrong sign. With \\(x = ${x}\\) and \\(y = ${y}\\), \\(x + y = ${x + y}\\).`],
      ]);
      return mc(
        `\\(${lead(a1, 'x')} ${term(b1, 'y')} = ${c1}\\)\n\\(${lead(a2, 'x')} ${term(b2, 'y')} = ${c2}\\)\n\nThe system above has a unique solution \\((x, y)\\). What is the value of \\(x + y\\)?`,
        set,
        `Solving the system gives \\(x = ${x}\\) and \\(y = ${y}\\), so \\(x + y = ${x + y}\\).`,
      );
    },
  },
  {
    id: 'alg-linear-model',
    domain: 'algebra',
    skill: 'Linear functions',
    topic: 'Linear functions in context',
    difficulty: 'easy',
    build(r) {
      const fee = r.int(15, 80);
      const rate = r.int(3, 25);
      const months = r.int(4, 18);
      const total = fee + rate * months;
      const subject = r.pick([
        ['A gym charges a one-time membership fee of', 'and', 'per month'],
        ['A studio charges a one-time registration fee of', 'and', 'per month'],
      ]);
      const fix = `\\(${fee} + ${rate}(${months}) = ${total}\\)`;
      const set = choiceSet(r, `$${total}`, [
        [`$${rate * months}`, `This leaves out the one-time $${fee} fee. The total is the fee plus ${months} monthly charges: ${fix}.`],
        [`$${(fee + rate) * months}`, `This charges the $${fee} fee every month. It is paid once, so the total is ${fix}.`],
        [`$${fee + rate}`, `This counts only one month of the $${rate} charge. For ${months} months the total is ${fix}.`],
      ]);
      return mc(
        `${subject[0]} $${fee} ${subject[1]} $${rate} ${subject[2]}. What is the total cost of a membership lasting ${months} months?`,
        set,
        `The total is the one-time fee plus the monthly charge: \\(${fee} + ${rate}(${months}) = ${total}\\).`,
      );
    },
  },

  // ---------------------------------------------------------- advanced math
  {
    id: 'adv-quadratic-roots',
    domain: 'advanced-math',
    skill: 'Nonlinear equations in one variable and systems of equations in two variables',
    topic: 'Solving quadratic equations',
    difficulty: 'medium',
    build(r) {
      const p = r.nonZero(-8, 8);
      const q = r.nonZero(-8, 8);
      if (p === q) return null;
      const b = -(p + q);
      const c = p * q;
      const fmt = (m, n) => `\\(x = ${Math.min(m, n)}\\) and \\(x = ${Math.max(m, n)}\\)`;
      const factored = `\\((x ${term(-p, '')})(x ${term(-q, '')}) = 0\\)`;
      const set = choiceSet(r, fmt(p, q), [
        [fmt(-p, -q), `This uses the constants in the factors of ${factored} as the solutions, which gets both signs wrong. Setting each factor equal to 0 gives ${fmt(p, q)}.`],
        [fmt(p, -q), `This gets \\(x = ${p}\\) right but gives the other solution the wrong sign. The factor \\(x ${term(-q, '')}\\) is 0 when \\(x = ${q}\\), not \\(x = ${-q}\\).`],
        [fmt(b, c), `This lists the equation's coefficients, \\(${b}\\) and \\(${c}\\), as if they were the solutions. Factoring gives ${factored}, so the solutions are ${fmt(p, q)}.`],
      ]);
      return mc(
        `What are the solutions to \\(x^2 ${term(b, 'x')} ${term(c, '')} = 0\\)?`,
        set,
        `The expression factors as \\((x ${term(-p, '')})(x ${term(-q, '')}) = 0\\), so \\(x = ${p}\\) or \\(x = ${q}\\).`,
      );
    },
  },
  {
    id: 'adv-vertex',
    domain: 'advanced-math',
    skill: 'Nonlinear functions',
    topic: 'Vertex form of a parabola',
    difficulty: 'medium',
    build(r) {
      const a = r.nonZero(-3, 3);
      const h = r.nonZero(-7, 7);
      const k = r.nonZero(-9, 9);
      const zero = `\\(x ${term(-h, '')} = 0\\)`;
      const set = choiceSet(r, `\\((${h}, ${k})\\)`, [
        [`\\((${-h}, ${k})\\)`, `This uses the \\(${-h}\\) in \\((x ${term(-h, '')})\\) as the \\(x\\)-coordinate. The vertex is where ${zero}, at \\(x = ${h}\\), so it is \\((${h}, ${k})\\).`],
        [`\\((${k}, ${h})\\)`, `This swaps the coordinates. The vertex \\((h, k)\\) lists \\(h = ${h}\\) first, so it is \\((${h}, ${k})\\).`],
        [`\\((${-h}, ${-k})\\)`, `This flips the signs of both coordinates. The vertex is where ${zero}, at \\(x = ${h}\\), and its \\(y\\)-coordinate is the constant \\(${k}\\), so it is \\((${h}, ${k})\\).`],
      ]);
      return mc(
        `The function \\(f(x) = ${a === 1 ? '' : a === -1 ? '-' : a}(x ${term(-h, '')})^2 ${term(k, '')}\\) is graphed in the xy-plane. What is the vertex of the graph?`,
        set,
        `In vertex form \\(a(x - h)^2 + k\\), the vertex is \\((h, k) = (${h}, ${k})\\).`,
      );
    },
  },
  {
    id: 'adv-exponential',
    domain: 'advanced-math',
    skill: 'Nonlinear functions',
    topic: 'Exponential growth and decay',
    difficulty: 'medium',
    build(r) {
      const principal = r.int(2, 20) * 100;
      const pct = r.pick([5, 10, 20, 25, 50]);
      const years = r.int(2, 3);
      const growth = r.chance(0.6);
      const factor = growth ? 1 + pct / 100 : 1 - pct / 100;
      // principal * (m / 100)^n to the nearest hundredth, computed on integers.
      // In floating point an exact half (1000 * 0.95^3 = 857.375) can land just
      // under it and round down to 857.37.
      const hundredths = (m, n) => Math.round((principal * m ** n) / 100 ** (n - 1)) / 100;
      const exact = hundredths(growth ? 100 + pct : 100 - pct, years);
      const simple = round(principal * (1 + (growth ? 1 : -1) * (pct / 100) * years), 2);
      const compound = `\\(${principal}(${factor})^{${years}}\\)`;
      const set = choiceSet(r, exact, [
        [simple > 0 ? simple : null, `This ${growth ? 'adds' : 'subtracts'} ${pct}% of the starting ${principal}, which is ${(principal / 100) * pct}, every year. Each year's change is ${pct}% of the current population, so after ${years} years it is ${compound}.`],
        [hundredths(growth ? 100 + pct : 100 - pct, years + 1), `This applies the ${pct}% ${growth ? 'increase' : 'decrease'} ${years + 1} times, one time too many. After ${years} years the population is ${compound}.`],
        [hundredths(growth ? pct : 100 + pct, years), growth
          ? `This multiplies by \\(${pct / 100}\\) each year, which finds only the ${pct}% increase, not the new population. A ${pct}% increase multiplies by \\(1 + ${pct / 100} = ${factor}\\), so the population is ${compound}.`
          : `This multiplies by \\(1 + ${pct / 100}\\) each year, which is a ${pct}% increase. A ${pct}% decrease multiplies by \\(1 - ${pct / 100} = ${factor}\\), so the population is ${compound}.`],
      ]);
      const verb = growth ? 'increases' : 'decreases';
      return mc(
        `A population of ${principal} ${verb} by ${pct}% each year. To the nearest hundredth, what is the population after ${years} years?`,
        set,
        `Each year multiplies the population by \\(${factor}\\), so after ${years} years it is \\(${principal}(${factor})^{${years}} = ${exact}\\).`,
      );
    },
  },
  {
    id: 'adv-composition',
    domain: 'advanced-math',
    skill: 'Nonlinear functions',
    topic: 'Function notation and composition',
    difficulty: 'medium',
    build(r) {
      const a = r.nonZero(-5, 5);
      const b = r.nonZero(-9, 9);
      const c = r.nonZero(-9, 9);
      const n = r.nonZero(-4, 4);
      const g = n * n + c;          // g(n)
      const fg = a * g + b;         // f(g(n))
      const gf = (a * n + b) ** 2 + c;
      const inner = `\\(g(${n}) = ${g}\\)`;
      const set = choiceSet(r, fg, [
        [gf, `This finds \\(g(f(${n}))\\) by applying \\(f\\) first. For \\(f(g(${n}))\\), apply \\(g\\) first: ${inner}, then \\(f(${g}) = ${fg}\\).`],
        [a * n + b + g, `This adds \\(f(${n}) = ${a * n + b}\\) and ${inner} instead of putting one inside the other. Use \\(${g}\\) as the input to \\(f\\): \\(f(${g}) = ${fg}\\).`],
        [a * (n * n) + b, `This drops the \\(${term(c, '')}\\) in \\(g(x)\\) and uses \\(g(${n}) = ${n * n}\\). In fact ${inner}, so \\(f(${g}) = ${fg}\\).`],
      ]);
      return mc(
        `The functions \\(f\\) and \\(g\\) are defined by \\(f(x) = ${lead(a, 'x')} ${term(b, '')}\\) and \\(g(x) = x^2 ${term(c, '')}\\). What is the value of \\(f(g(${n}))\\)?`,
        set,
        `First \\(g(${n}) = ${n * n} ${term(c, '')} = ${g}\\), then \\(f(${g}) = ${a}(${g}) ${term(b, '')} = ${fg}\\).`,
      );
    },
  },

  // -------------------------------------------------------- problem-solving
  {
    id: 'ps-percent-change',
    domain: 'problem-solving',
    skill: 'Percentages',
    topic: 'Percent change',
    difficulty: 'easy',
    build(r) {
      const base = r.int(2, 25) * 20;
      const pct = r.pick([5, 10, 15, 20, 25, 40, 50]);
      const up = r.chance(0.5);
      const after = round(base * (up ? 1 + pct / 100 : 1 - pct / 100), 2);
      const diff = Math.abs(after - base);
      const fix = `\\(\\frac{${diff}}{${base}} \\times 100 = ${pct}\\%\\)`;
      const set = choiceSet(r, `${pct}%`, [
        [`${round((diff / after) * 100, 2)}%`, `This divides the change, ${diff}, by the new value, ${after}. Percent change divides by the original value: ${fix}.`],
        [`${round(diff, 2)}%`, `This gives the amount of change, ${diff}, as if it were the percent. Divide it by the original value: ${fix}.`],
        [`${round(100 - pct, 2)}%`, up
          ? `This is \\(100\\% - ${pct}\\%\\), the percent that would be left after a ${pct}% decrease. The quantity increased by ${fix}.`
          : `This is the new value as a percent of the original, \\(\\frac{${after}}{${base}} \\times 100 = ${100 - pct}\\%\\). The decrease is \\(100\\% - ${100 - pct}\\% = ${pct}\\%\\).`],
      ]);
      return mc(
        `A quantity changed from ${base} to ${after}. By what percent did it ${up ? 'increase' : 'decrease'}?`,
        set,
        `Percent change is \\(\\frac{|${after} - ${base}|}{${base}} \\times 100 = ${pct}\\%\\); the original value is always the base.`,
      );
    },
  },
  {
    id: 'ps-unit-rate',
    domain: 'problem-solving',
    skill: 'Ratios, rates, proportional relationships, and units',
    topic: 'Ratios, rates, and proportions',
    difficulty: 'easy',
    build(r) {
      const unitRate = r.int(2, 30);
      const known = r.int(3, 12);
      const target = r.int(13, 40);
      const produced = unitRate * known;
      const answer = unitRate * target;
      const fix = `\\(${unitRate} \\times ${target} = ${answer}\\)`;
      const set = choiceSet(r, answer, [
        [produced + (target - known), `This adds the ${target - known} extra hours to the ${produced} parts, as if each extra hour made just one part. At ${unitRate} parts per hour, ${target} hours give ${fix}.`],
        [unitRate * (target - known), `This counts only the parts from the extra \\(${target} - ${known} = ${target - known}\\) hours. In all ${target} hours the machine makes ${fix}.`],
        // Multiply before dividing: produced * (known / target) lands a hair
        // under an exact .5 (165 * 11/30 = 60.5 became 60) and rounds the wrong way.
        [Math.round((produced * known) / target), `This multiplies ${produced} by \\(\\frac{${known}}{${target}}\\)${(produced * known) % target ? ' and rounds' : ''}, which shrinks the count even though the time is longer. Multiply by \\(\\frac{${target}}{${known}}\\) instead: \\(${produced} \\times \\frac{${target}}{${known}} = ${answer}\\).`],
      ]);
      return mc(
        `A machine produces ${produced} parts in ${known} hours at a constant rate. At this rate, how many parts does it produce in ${target} hours?`,
        set,
        `The rate is \\(${produced} \\div ${known} = ${unitRate}\\) parts per hour, so in ${target} hours it produces \\(${unitRate} \\times ${target} = ${answer}\\).`,
      );
    },
  },
  {
    id: 'ps-mean-missing',
    domain: 'problem-solving',
    skill: 'One-variable data: Distributions and measures of center and spread',
    topic: 'Mean of a data set',
    difficulty: 'medium',
    build(r) {
      const n = r.int(4, 6);
      const mean = r.int(10, 40);
      const values = Array.from({ length: n - 1 }, () => r.int(5, 60));
      const missing = mean * n - values.reduce((s, v) => s + v, 0);
      if (missing < 0 || missing > 120) return null;
      const knownSum = values.reduce((s, v) => s + v, 0);
      const fix = `The ${n} numbers total \\(${mean} \\times ${n} = ${mean * n}\\), so the remaining one is \\(${mean * n} - ${knownSum} = ${missing}\\).`;
      const set = choiceSet(r, missing, [
        [mean, `This assumes the remaining number equals the mean. ${fix}`],
        [mean * (n - 1) - knownSum, `This multiplies the mean by ${n - 1}, the number of known values, instead of by ${n}. ${fix}`],
        [missing + mean, `This multiplies the mean by ${n + 1} instead of by ${n}, counting one number too many. ${fix}`],
      ]);
      return mc(
        `A data set of ${n} numbers has a mean of ${mean}. ${n - 1} of the numbers are ${values.join(', ')}. What is the remaining number?`,
        set,
        `The ${n} numbers total \\(${mean} \\times ${n} = ${mean * n}\\). Subtracting the ${n - 1} known values leaves ${missing}.`,
      );
    },
  },
  {
    id: 'ps-probability',
    domain: 'problem-solving',
    skill: 'Probability and conditional probability',
    topic: 'Probability from a sample',
    difficulty: 'easy',
    build(r) {
      const a = r.int(4, 30);
      const b = r.int(4, 30);
      const c = r.int(4, 30);
      const total = a + b + c;
      // The colors are drawn after the choices, so these explanations name
      // counts, not colors.
      const fix = `\\(${ratio(a, total)}\\)`;
      const set = choiceSet(r, frac(a, total), [
        [frac(a, b + c), `This divides by the ${b + c} marbles of the other two colors. The denominator is all ${total} marbles, so the probability is ${fix}.`],
        [frac(b, total), `This counts the ${b} marbles of another color as the favorable outcomes. Only the ${a} marbles of the color asked about count, so the probability is ${fix}.`],
        [frac(total, a), `This divides the total, ${total}, by ${a}, which is upside down and gives a probability greater than 1. Probability is favorable outcomes over total outcomes: ${fix}.`],
      ]);
      const [x, y, z] = r.shuffle(['red', 'blue', 'green']);
      return mc(
        `A bag contains ${a} ${x} marbles, ${b} ${y} marbles, and ${c} ${z} marbles. If one marble is selected at random, what is the probability that it is ${x}?`,
        set,
        `There are \\(${a} + ${b} + ${c} = ${total}\\) marbles in total, so the probability is \\(${frac(a, total)}\\).`,
      );
    },
  },

  // ---------------------------------------------------------- geometry/trig
  {
    id: 'geo-pythagorean',
    domain: 'geometry-trig',
    skill: 'Right triangles and trigonometry',
    topic: 'Right triangles and the Pythagorean theorem',
    difficulty: 'easy',
    build(r) {
      const [a, b, c] = r.pick(PYTHAG);
      const fix = `\\(\\sqrt{${a}^2 + ${b}^2} = \\sqrt{${c * c}} = ${c}\\)`;
      const set = choiceSet(r, c, [
        [a + b, `This adds the legs, \\(${a} + ${b}\\). The Pythagorean theorem adds their squares: ${fix}.`],
        [round(Math.sqrt(b * b - a * a), 2), `This subtracts the squares, \\(\\sqrt{${b}^2 - ${a}^2}\\), which finds a missing leg, not the hypotenuse. Add the squares instead: ${fix}.`],
        [round((a + b) / 2, 2), `This averages the two legs, but the hypotenuse is longer than either leg. By the Pythagorean theorem it is ${fix}.`],
      ]);
      return mc(
        `In a right triangle, the two legs have lengths ${a} and ${b}. What is the length of the hypotenuse?`,
        set,
        `\\(${a}^2 + ${b}^2 = ${a * a} + ${b * b} = ${c * c}\\), and \\(\\sqrt{${c * c}} = ${c}\\).`,
      );
    },
  },
  {
    id: 'geo-circle',
    domain: 'geometry-trig',
    skill: 'Circles',
    topic: 'Circles: area and circumference',
    difficulty: 'easy',
    build(r) {
      const radius = r.int(2, 14);
      const wantArea = r.chance(0.5);
      const correct = wantArea ? `\\(${radius * radius}\\pi\\)` : `\\(${2 * radius}\\pi\\)`;
      const fix = wantArea
        ? `Area is \\(\\pi r^2 = \\pi(${radius})^2 = ${radius * radius}\\pi\\).`
        : `Circumference is \\(2\\pi r = 2\\pi(${radius}) = ${2 * radius}\\pi\\).`;
      const set = choiceSet(r, correct, [
        [wantArea ? `\\(${2 * radius}\\pi\\)` : `\\(${radius * radius}\\pi\\)`, wantArea
          ? `This is the circumference, \\(2\\pi r\\), not the area. ${fix}`
          : `This is the area, \\(\\pi r^2\\), not the circumference. ${fix}`],
        [`\\(${radius}\\pi\\)`, wantArea
          ? `This multiplies \\(\\pi\\) by the radius without squaring it. ${fix}`
          : `This leaves out the 2 in \\(2\\pi r\\). ${fix}`],
        [`\\(${4 * radius * radius}\\pi\\)`, wantArea
          ? `This squares the diameter, ${2 * radius}, instead of the radius. ${fix}`
          : `This is \\(\\pi(${2 * radius})^2\\), the area formula applied to the diameter. ${fix}`],
      ]);
      return mc(
        `A circle has a radius of ${radius}. What is the ${wantArea ? 'area' : 'circumference'} of the circle?`,
        set,
        wantArea
          ? `Area is \\(\\pi r^2 = \\pi(${radius})^2 = ${radius * radius}\\pi\\).`
          : `Circumference is \\(2\\pi r = 2\\pi(${radius}) = ${2 * radius}\\pi\\).`,
      );
    },
  },
  {
    id: 'geo-similar',
    domain: 'geometry-trig',
    skill: 'Lines, angles, and triangles',
    topic: 'Similar triangles',
    difficulty: 'medium',
    build(r) {
      const scale = r.int(2, 5);
      const a = r.int(3, 12);
      const b = r.int(3, 12);
      const fix = `\\(EF = ${b} \\times ${scale} = ${b * scale}\\)`;
      const set = choiceSet(r, b * scale, [
        [b + (a * scale - a), `This adds the difference \\(${a * scale} - ${a} = ${a * scale - a}\\) to ${b}. Similar triangles multiply every side by the same scale factor, ${scale}, so ${fix}.`],
        [b * (scale + 1), `This multiplies ${b} by ${scale + 1}, one more than the scale factor. The scale factor is \\(${a * scale} \\div ${a} = ${scale}\\), so ${fix}.`],
        [Math.round(b / scale), `This divides ${b} by the scale factor, ${scale}, instead of multiplying${b % scale ? ', then rounds' : ''}. Triangle \\(DEF\\) is the larger one, so ${fix}.`],
      ]);
      return mc(
        `Triangle \\(ABC\\) is similar to triangle \\(DEF\\). Side \\(AB\\) has length ${a} and corresponds to side \\(DE\\), which has length ${a * scale}. If side \\(BC\\) has length ${b}, what is the length of side \\(EF\\)?`,
        set,
        `The scale factor is \\(${a * scale} \\div ${a} = ${scale}\\), so \\(EF = ${b} \\times ${scale} = ${b * scale}\\).`,
      );
    },
  },
  {
    id: 'geo-trig-ratio',
    domain: 'geometry-trig',
    skill: 'Right triangles and trigonometry',
    topic: 'Right triangle trigonometry',
    difficulty: 'medium',
    build(r) {
      const [a, b, c] = r.pick(PYTHAG);
      const fn = r.pick(['sin', 'cos', 'tan']);
      const correct = fn === 'sin' ? frac(a, c) : fn === 'cos' ? frac(b, c) : frac(a, b);
      const rule = {
        sin: `Sine is opposite over hypotenuse: \\(${ratio(a, c)}\\).`,
        cos: `Cosine is adjacent over hypotenuse: \\(${ratio(b, c)}\\).`,
        tan: `Tangent is opposite over adjacent: \\(${ratio(a, b)}\\).`,
      }[fn];
      const set = choiceSet(r, correct, [
        [fn === 'sin' ? frac(b, c) : fn === 'cos' ? frac(a, c) : frac(b, a), {
          sin: `This is adjacent over hypotenuse, which is \\(\\cos A\\). ${rule}`,
          cos: `This is opposite over hypotenuse, which is \\(\\sin A\\). ${rule}`,
          tan: `This is adjacent over opposite, the tangent ratio upside down. ${rule}`,
        }[fn]],
        [frac(c, a), `This is hypotenuse over opposite${fn === 'sin' ? ', the sine ratio upside down' : ''}. ${rule}`],
        fn === 'tan'
          ? [frac(a, c), `This is opposite over hypotenuse, which is \\(\\sin A\\). ${rule}`]
          : [frac(b, a), `This is adjacent over opposite. ${rule}`],
      ]);
      const label = { sin: 'opposite over hypotenuse', cos: 'adjacent over hypotenuse', tan: 'opposite over adjacent' }[fn];
      return mc(
        `In right triangle \\(ABC\\), angle \\(C\\) is the right angle. The side opposite angle \\(A\\) has length ${a}, the side adjacent to angle \\(A\\) has length ${b}, and the hypotenuse has length ${c}. What is \\(\\${fn} A\\)?`,
        set,
        `\\(\\${fn}\\) is ${label}, which gives \\(${correct}\\).`,
      );
    },
  },
  {
    id: 'geo-volume',
    domain: 'geometry-trig',
    skill: 'Area and volume',
    topic: 'Volume of solids',
    difficulty: 'medium',
    build(r) {
      const radius = r.int(2, 9);
      const height = r.int(3, 15);
      const v = radius * radius * height;
      const why = `Volume is \\(\\pi r^2 h = \\pi(${radius})^2(${height}) = ${v}\\pi\\).`;
      const set = choiceSet(r, `\\(${v}\\pi\\)`, [
        [`\\(${2 * radius * height}\\pi\\)`, `This is \\(2\\pi r h\\), the area of the curved side, not the volume. ${why}`],
        [`\\(${radius * height}\\pi\\)`, `This uses \\(\\pi r h\\) and never squares the radius. ${why}`],
        [`\\(${round((v / 3), 2)}\\pi\\)`, `This uses the cone formula, \\(\\frac{1}{3}\\pi r^2 h\\)${v % 3 ? ', and rounds' : ''}. A cylinder has no \\(\\frac{1}{3}\\): \\(\\pi(${radius})^2(${height}) = ${v}\\pi\\).`],
      ]);
      // Roughly half of these become student-produced responses, which is how
      // the real section mixes them.
      return r.chance(0.5)
        ? grid(
          `A right circular cylinder has a radius of ${radius} and a height of ${height}. What is the volume of the cylinder, in terms of \\(\\pi\\)? Give the coefficient of \\(\\pi\\).`,
          v,
          `${why} The coefficient is ${v}.`,
        )
        : mc(
          `A right circular cylinder has a radius of ${radius} and a height of ${height}. What is the volume of the cylinder?`,
          set,
          why,
        );
    },
  },

  // --------------------------------------------------------------- hard tier
  {
    id: 'alg-no-solution',
    domain: 'algebra',
    skill: 'Systems of two linear equations in two variables',
    topic: 'Systems with no solution',
    difficulty: 'hard',
    build(r) {
      const scale = r.int(2, 5);     // ratio the coefficients must share
      const m = r.int(2, 7);
      const n = r.int(2, 7);
      const k = m * scale;           // the value asked for
      const b = n * scale;
      const p = r.int(5, 20);
      const c = r.int(5, 60);
      if (c === scale * p) return null; // that would make the system consistent
      const fix = `For no solution the coefficients must be proportional: \\(\\frac{k}{${m}} = \\frac{${b}}{${n}} = ${scale}\\), so \\(k = ${m} \\times ${scale} = ${k}\\).`;
      const set = choiceSet(r, k, [
        [m * n, `This multiplies ${m} and ${n}, the coefficients of the second equation. ${fix}`],
        [scale, `This is the ratio of the \\(y\\)-coefficients, \\(\\frac{${b}}{${n}} = ${scale}\\), not \\(k\\). The \\(x\\)-coefficients need the same ratio, so \\(k = ${m} \\times ${scale} = ${k}\\).`],
        [m + scale, `This adds ${scale}, the ratio \\(\\frac{${b}}{${n}}\\), to ${m} instead of multiplying by it. ${fix}`],
        [b, `This sets \\(k\\) equal to ${b}, the \\(y\\)-coefficient in its own equation. ${fix}`],
      ]);
      return mc(
        `\\(kx ${term(b, 'y')} = ${c}\\)\n\\(${lead(m, 'x')} ${term(n, 'y')} = ${p}\\)\n\nIn the system of equations above, \\(k\\) is a constant. If the system has no solution, what is the value of \\(k\\)?`,
        set,
        `With no solution the two lines are parallel, so the coefficients are proportional: \\(\\frac{k}{${m}} = \\frac{${b}}{${n}} = ${scale}\\), giving \\(k = ${k}\\).`,
      );
    },
  },
  {
    id: 'adv-discriminant',
    domain: 'advanced-math',
    skill: 'Nonlinear equations in one variable and systems of equations in two variables',
    topic: 'Discriminant and repeated roots',
    difficulty: 'hard',
    build(r) {
      const t = r.nonZero(-9, 9);
      const b = 2 * t;
      const c = t * t;               // exactly one real solution when b^2 = 4c
      const fix = `\\(c = \\frac{${paren(b)}^2}{4} = ${c}\\)`;
      const set = choiceSet(r, c, [
        [b * b, `This is \\(${paren(b)}^2\\) without dividing by 4. Setting \\(b^2 - 4c = 0\\) gives ${fix}.`],
        [t, `This halves the \\(x\\)-coefficient, \\(${b}\\), but never squares the result. The left side must be the perfect square \\((x ${term(t, '')})^2\\), so \\(c = ${paren(t)}^2 = ${c}\\).`],
        [-c, `This gets the sign wrong when solving \\(b^2 - 4c = 0\\). Adding \\(4c\\) to both sides gives \\(4c = ${b * b}\\), so \\(c = ${c}\\).`],
        [b, `This uses the \\(x\\)-coefficient, \\(${b}\\), as \\(c\\). A single solution needs \\(b^2 - 4c = 0\\), so ${fix}.`],
      ]);
      return mc(
        `The equation \\(x^2 ${term(b, 'x')} + c = 0\\) has exactly one distinct real solution, where \\(c\\) is a constant. What is the value of \\(c\\)?`,
        set,
        `One repeated root means the discriminant is zero: \\(b^2 - 4c = 0\\), so \\(c = \\frac{${paren(b)}^2}{4} = ${c}\\).`,
      );
    },
  },
  {
    id: 'ps-weighted-mean',
    domain: 'problem-solving',
    skill: 'One-variable data: Distributions and measures of center and spread',
    topic: 'Weighted averages',
    difficulty: 'hard',
    build(r) {
      const n1 = r.int(5, 30);
      const n2 = r.int(5, 30);
      const mean = r.int(60, 95);
      const a1 = r.int(50, 99);
      const numerator = mean * (n1 + n2) - n1 * a1;
      if (numerator % n2 !== 0) return null;      // keep the second mean whole
      const a2 = numerator / n2;
      if (a2 < 40 || a2 > 100 || a2 === a1) return null;
      const points = n1 * a1 + n2 * a2;
      const bigger = Math.max(n1, n2);
      const fix = `\\(\\frac{${n1}(${a1}) + ${n2}(${a2})}{${n1 + n2}} = ${mean}\\)`;
      const set = choiceSet(r, mean, [
        [Math.round((a1 + a2) / 2), `This is the plain average of ${a1} and ${a2}${(a1 + a2) % 2 ? ', rounded' : ''}, which treats the two groups as the same size. Weight each average by its group size: ${fix}.`],
        [Math.round(points / bigger), `This divides the ${points} total points by ${bigger}, the size of just one group${points % bigger ? ', and rounds' : ''}. Divide by all ${n1 + n2} students: \\(\\frac{${points}}{${n1 + n2}} = ${mean}\\).`],
        [a1, `This is the average of the ${n1} students alone. The other ${n2} students count too: ${fix}.`],
      ]);
      return mc(
        `In a class, ${n1} students scored an average of ${a1} on a test and the other ${n2} students scored an average of ${a2}. What was the average score for the whole class?`,
        set,
        `Total points are \\(${n1}(${a1}) + ${n2}(${a2}) = ${n1 * a1 + n2 * a2}\\) across ${n1 + n2} students, so the average is ${mean}. Averaging ${a1} and ${a2} directly ignores the different group sizes.`,
      );
    },
  },
  {
    id: 'geo-circle-equation',
    domain: 'geometry-trig',
    skill: 'Circles',
    topic: 'Equation of a circle',
    difficulty: 'hard',
    build(r) {
      const h = r.nonZero(-7, 7);
      const k = r.nonZero(-7, 7);
      const rad = r.int(2, 9);
      const D = -2 * h;
      const E = -2 * k;
      const F = h * h + k * k - rad * rad;
      if (F === 0) return null; // the stem would read "+ 0 = 0"
      const set = choiceSet(r, rad, [
        [rad * rad, `This is \\(r^2\\), not the radius. Completing the square gives \\(r^2 = ${rad * rad}\\), so \\(r = \\sqrt{${rad * rad}} = ${rad}\\).`],
        [Math.abs(h) + Math.abs(k), `This adds ${Math.abs(h)} and ${Math.abs(k)}, which come from the center \\((${h}, ${k})\\), not the radius. Completing the square gives \\(r^2 = ${rad * rad}\\), so \\(r = ${rad}\\).`],
        [Math.abs(F), `This uses the constant term${F < 0 ? ' without its sign' : ''}, ${Math.abs(F)}, as the radius. Completing the square gives \\(r^2 = ${-F} + ${h * h} + ${k * k} = ${rad * rad}\\), so \\(r = ${rad}\\).`],
      ]);
      return mc(
        `In the xy-plane, the graph of \\(x^2 + y^2 ${term(D, 'x')} ${term(E, 'y')} ${term(F, '')} = 0\\) is a circle. What is the radius of the circle?`,
        set,
        `Completing the square gives \\((x ${term(-h, '')})^2 + (y ${term(-k, '')})^2 = ${rad * rad}\\), a circle centered at \\((${h}, ${k})\\) with radius \\(\\sqrt{${rad * rad}} = ${rad}\\).`,
      );
    },
  },

  // ------------------------------------------------------ later additions
  // Appended rather than filed under their domains above, so every existing
  // template keeps its place in this list.
  {
    id: 'alg-inequality',
    domain: 'algebra',
    skill: 'Linear inequalities in one or two variables',
    topic: 'Solving linear inequalities',
    difficulty: 'medium',
    build(r) {
      // c - ax (op) d + ex collects to -sx (op) d - c with s = a + e > 0, so
      // solving with x on the left ends in a division by a negative number.
      const s = r.int(2, 7);
      const e = r.nonZero(-6, 6);
      const a = s - e;
      if (a < 2) return null;
      const k = r.nonZero(-9, 9);
      // Moving c with the wrong sign ends at -(d + c)/s = k - 2c/s, a whole
      // number only when s divides 2c, so c is drawn from those values.
      const unit = s % 2 === 0 ? s / 2 : s;
      const most = Math.floor(20 / unit);
      const c = unit * r.nonZero(-most, most);
      const d = c - s * k;
      if (d === 0) return null; // the right side would read "0 + ex"
      const k2 = -(d + c) / s;
      const [op, flip] = r.pick([['<', '>'], ['>', '<'], ['\\le', '\\ge'], ['\\ge', '\\le']]);
      const sx = lead(-s, 'x');
      const collected = `\\(${sx} ${op} ${d - c}\\)`;
      const moveX = e > 0
        ? `subtracting \\(${lead(e, 'x')}\\) from both sides`
        : `adding \\(${lead(-e, 'x')}\\) to both sides`;
      const moveC = c > 0 ? `subtracting ${c} from both sides` : `adding ${-c} to both sides`;
      const solved = `\\(x ${flip} ${k}\\)`;
      // "2x - 55" and "32 - 3x" read naturally; "-55 + 2x" and "-3x + 32" less so.
      const right = e > 0 ? `${lead(e, 'x')} ${term(d, '')}` : `${d} ${term(e, 'x')}`;
      const set = choiceSet(r, solved, [
        [`\\(x ${op} ${k}\\)`, `This divides both sides of ${collected} by \\(${-s}\\) without reversing the inequality symbol. Dividing both sides of an inequality by a negative number reverses the symbol, so ${solved}.`],
        [`\\(x ${op} ${-k}\\)`, `This drops the negative sign of \\(${sx}\\) and solves \\(${lead(s, 'x')} ${op} ${d - c}\\), which gives \\(x ${op} ${-k}\\). Dividing both sides of ${collected} by \\(${-s}\\) and reversing the inequality symbol gives ${solved}.`],
        [`\\(x ${flip} ${k2}\\)`, `This moves the \\(${c}\\) to the right side without changing its sign, which leads to \\(${sx} ${op} ${d + c}\\) and \\(x ${flip} ${k2}\\). ${cap(moveC)} gives ${collected}, so ${solved}.`],
      ]);
      return mc(
        `Which of the following describes all solutions to the inequality \\(${c} ${term(-a, 'x')} ${op} ${right}\\)?`,
        set,
        `${cap(moveX)} gives \\(${c} ${term(-s, 'x')} ${op} ${d}\\), and ${moveC} gives ${collected}. Dividing both sides by \\(${-s}\\) reverses the inequality symbol, so ${solved}.`,
      );
    },
  },
  {
    id: 'adv-equivalent',
    domain: 'advanced-math',
    skill: 'Equivalent expressions',
    topic: 'Expanding and combining polynomials',
    difficulty: 'medium',
    build(r) {
      // (ax + b)(cx + d) - ex(x + f)
      const a = r.int(1, 4);
      const b = r.nonZero(-7, 7);
      const c = r.int(1, 4);
      const d = r.nonZero(-7, 7);
      const e = r.int(2, 5);
      const f = r.nonZero(-6, 6);
      if (a === c && b === d) return null; // a square, which would be written (ax + b)^2
      const A = a * c - e;
      const B = a * d + b * c - e * f;
      const C = b * d;
      if (A === 0 || B === 0) return null; // keep all three terms of the answer
      const pair = `(${lead(a, 'x')} ${term(b, '')})(${lead(c, 'x')} ${term(d, '')})`;
      const single = `${e}x(x ${term(f, '')})`;
      const product = poly(a * c, a * d + b * c, b * d);
      const subtracted = `${e}x^2 ${term(e * f, 'x')}`;
      const answer = `\\(${poly(A, B, C)}\\)`;
      const set = choiceSet(r, answer, [
        [`\\(${poly(A, a * d + b * c + e * f, C)}\\)`, `This changes the sign of \\(${e}x^2\\) but not of \\(${lead(e * f, 'x')}\\) when subtracting \\(${single} = ${subtracted}\\). Subtracting both terms gives \\(-${e}x^2 ${term(-e * f, 'x')}\\), so the expression is ${answer}.`],
        [`\\(${poly(A, -e * f, C)}\\)`, `This multiplies only the first terms and the last terms of \\(${pair}\\), which leaves out \\(${lead(a * d, 'x')}\\) and \\(${lead(b * c, 'x')}\\). The product is \\(${product}\\), so the expression is ${answer}.`],
        [`\\(${poly(A, B, b + d)}\\)`, `This adds the constant terms \\(${b}\\) and \\(${d}\\) instead of multiplying them. The constant term of \\(${pair}\\) is \\(${b} \\times ${paren(d)} = ${C}\\), so the expression is ${answer}.`],
        [`\\(${poly(a * c + e, a * d + b * c + e * f, C)}\\)`, `This adds \\(${single}\\) instead of subtracting it. Subtracting \\(${subtracted}\\) from \\(${product}\\) gives ${answer}.`],
      ]);
      return mc(
        `Which of the following is equivalent to \\(${pair} - ${single}\\)?`,
        set,
        `Expanding gives \\(${pair} = ${product}\\) and \\(${single} = ${subtracted}\\). Subtracting the second from the first gives \\(${poly(A, B, C)}\\).`,
      );
    },
  },
  {
    id: 'ps-best-fit',
    domain: 'problem-solving',
    skill: 'Two-variable data: Models and scatterplots',
    topic: 'Line of best fit',
    difficulty: 'medium',
    build(r) {
      const sc = r.pick(BEST_FIT);
      const m10 = r.pick(sc.slopes); // the slope in tenths, so every value below is exact
      const b = r.int(...sc.intercepts);
      const m = m10 / 10;
      const at = (x) => (m10 * x + 10 * b) / 10;
      const intro = `${sc.setup} A line of best fit for the data is \\(y = ${m}x + ${b}\\). Based on the line of best fit, `;

      if (r.chance(0.5)) {
        // How much the prediction changes from one x-value to another.
        const lo = r.int(sc.xs[0], sc.xs[1] - 2);
        const hi = r.int(lo + 2, sc.xs[1]);
        const dx = hi - lo;
        const diff = (m10 * dx) / 10;
        const both = `\\((${m}(${hi}) + ${b}) - (${m}(${lo}) + ${b}) = ${at(hi)} - ${at(lo)} = ${diff}\\)`;
        const set = choiceSet(r, diff, [
          [m, `This is the predicted increase for 1 additional ${sc.one}. From ${lo} to ${hi} ${sc.many} is ${dx} more ${sc.many}, so the predicted ${sc.what} increases by \\(${m} \\times ${dx} = ${diff}\\) ${sc.unit}.`],
          [at(hi), `This is the predicted ${sc.what} for ${hi} ${sc.many}, \\(${m}(${hi}) + ${b} = ${at(hi)}\\), not the difference between two predictions. Subtracting the prediction for ${lo} ${sc.many} gives ${both}.`],
          [(m10 * dx + 10 * b) / 10, `This adds the \\(y\\)-intercept, ${b}, to the difference. Both predictions include the ${b}, so it cancels: ${both}.`],
        ]);
        return mc(
          intro + sc.change(hi, lo),
          set,
          `The slope, ${m}, is the predicted increase in ${sc.what} for each additional ${sc.one}, so ${dx} more ${sc.many} add \\(${m} \\times ${dx} = ${diff}\\) ${sc.unit}. Computing both predictions gives the same result: ${both}.`,
        );
      }

      // Which x-value the line gives a stated prediction for.
      const x0 = r.int(...sc.xs);
      const y0 = at(x0);
      if (!Number.isInteger(y0)) return null;
      // v / m, kept only when it ends within two decimal places.
      const over = (v) => ((1000 * v) % m10 === 0 ? (10 * v) / m10 : null);
      const solve = `Setting \\(y = ${y0}\\) gives \\(${y0} = ${m}x + ${b}\\), so \\(x = (${y0} - ${b}) \\div ${m} = ${x0}\\).`;
      const set = choiceSet(r, x0, [
        [(m10 * y0 + 10 * b) / 10, `This substitutes ${y0} for \\(x\\) instead of for \\(y\\): \\(${m}(${y0}) + ${b} = ${(m10 * y0 + 10 * b) / 10}\\). ${solve}`],
        [over(y0 + b), `This adds ${b} to ${y0} instead of subtracting it: \\((${y0} + ${b}) \\div ${m} = ${over(y0 + b)}\\). ${solve}`],
        [over(y0), `This divides ${y0} by ${m} without first subtracting the \\(y\\)-intercept, ${b}. ${solve}`],
        [y0 - b, `This subtracts the \\(y\\)-intercept, ${b}, but never divides by the slope, ${m}. ${solve}`],
      ]);
      return mc(
        intro + sc.reverse(y0),
        set,
        `Setting \\(y = ${y0}\\) gives \\(${y0} = ${m}x + ${b}\\). Subtracting ${b} from both sides gives \\(${y0 - b} = ${m}x\\), so \\(x = ${y0 - b} \\div ${m} = ${x0}\\).`,
      );
    },
  },
  {
    id: 'ps-margin-of-error',
    domain: 'problem-solving',
    skill: 'Inference from sample statistics and margin of error',
    topic: 'Margin of error',
    difficulty: 'medium',
    build(r) {
      const sv = r.pick(SURVEYS);
      const thousands = r.int(8, 90);
      const total = thousands * 1000;
      const hundreds = r.int(2, 12);
      const n = hundreds * 100;
      const p = r.int(12, 88);
      const e = r.int(2, 6);
      const est = 10 * thousands * p; // p% of the whole population
      const count = (pct) => 10 * thousands * pct; // pct% of the whole population
      const between = (lo, hi) => `Between ${commas(lo)} and ${commas(hi)}`;
      const range = `${p - e}% to ${p + e}% of ${commas(total)}: ${commas(count(p - e))} to ${commas(count(p + e))}`;
      // e% of the estimate itself, offered only when it is a whole number.
      const relative = (thousands * p * e) % 10 === 0 ? (thousands * p * e) / 10 : null;
      const set = choiceSet(r, between(count(p - e), count(p + e)), [
        [between(hundreds * (p - e), hundreds * (p + e)), `This applies ${p - e}% and ${p + e}% to the ${n} ${sv.members} in the sample. The survey estimates the percentage for all ${commas(total)} ${sv.members}, so the range is ${range}.`],
        [between(est - e, est + e), `This adds and subtracts ${e} ${sv.members} from the estimate of ${commas(est)}, which is ${p}% of ${commas(total)}. The margin of error is ${e} percentage points, and ${e}% of ${commas(total)} is ${commas(count(e))}, so the range is ${commas(count(p - e))} to ${commas(count(p + e))}.`],
        [relative === null ? null : between(est - relative, est + relative), `This uses ${e}% of the estimate ${commas(est)}, or ${commas(relative)}, as the margin. The margin of error is ${e} percentage points of the ${p}%, so the range is ${range}.`],
        [between(count(100 - p - e), count(100 - p + e)), `This finds the range for the other ${100 - p}%, the ${sv.members} outside the group asked about: ${100 - p - e}% to ${100 - p + e}% of ${commas(total)}. The group asked about is ${p}% of those surveyed, so the range is ${range}.`],
      ]);
      return mc(
        `${sv.place} has ${commas(total)} ${sv.members}. A random sample of ${n} of ${sv.whose} was surveyed, and ${p}% of those surveyed ${sv.said}. The margin of error for this estimate is ${e} percentage points. Which of the following gives the range of plausible values for the number of ${sv.asked}?`,
        set,
        `The sample estimate is ${p}%, and a margin of error of ${e} percentage points means the percentage for all ${commas(total)} ${sv.members} is plausibly between ${p - e}% and ${p + e}%. That is between ${p - e}% of ${commas(total)}, or ${commas(count(p - e))}, and ${p + e}% of ${commas(total)}, or ${commas(count(p + e))}.`,
      );
    },
  },
  {
    id: 'ps-study-design',
    domain: 'problem-solving',
    skill: 'Evaluating statistical claims: Observational studies and experiments',
    topic: 'Random sampling and random assignment',
    difficulty: 'medium',
    build(r) {
      const st = r.pick(STUDIES);
      const sampled = r.chance(0.5); // a random sample of the population, or volunteers
      const assigned = r.chance(0.5); // groups assigned at random, or chosen by the participants
      const n = r.pick([120, 150, 200, 240, 300, 400, 500]);
      const weeks = r.int(4, 12);
      const Ing = cap(st.ing);
      // Each conclusion as [claims cause and effect, extends to the whole population].
      const claims = [[true, true], [true, false], [false, true], [false, false]];
      const text = ([cause, general]) => {
        if (cause && general) return `${Ing} causes ${st.effect} among ${st.pop}.`;
        if (cause) return `${Ing} causes ${st.effect} among the participants, but the result cannot be generalized to all ${st.pop}.`;
        if (general) return `${Ing} is associated with ${st.effect} among ${st.pop}, but a cause-and-effect relationship cannot be concluded.`;
        return `${Ing} is associated with ${st.effect} among the participants, but a cause-and-effect relationship cannot be concluded, and the result cannot be generalized to all ${st.pop}.`;
      };
      const why = ([cause, general]) => {
        const reasons = [];
        // One sentence per reason, so an explanation of two mistakes is two sentences.
        if (cause && !assigned) reasons.push(`claims that ${st.ing} causes ${st.effect}, but the participants chose for themselves whether to ${st.treat} instead of being randomly assigned, so the two groups may differ in other ways that affect ${st.measure}.`);
        if (!cause && assigned) reasons.push(`says only that ${st.ing} is associated with ${st.effect}, but the participants were randomly assigned to groups, which supports a cause-and-effect conclusion.`);
        if (general && !sampled) reasons.push(`extends the result to all ${st.pop}, but the participants were volunteers rather than a random sample of that population.`);
        if (!general && sampled) reasons.push(`says the result cannot be generalized to all ${st.pop}, but the participants were a random sample of that population, so it can be.`);
        return reasons.map((s, i) => `${i ? 'It also' : 'This'} ${s}`).join(' ');
      };
      const key = claims.find(([cause, general]) => cause === assigned && general === sampled);
      const set = choiceSet(r, text(key), claims.filter((c) => c !== key).map((c) => [text(c), why(c)]));
      const sample = sampled
        ? `A researcher selected ${n} ${st.people} at random from all ${st.from}.`
        : `A researcher advertised for volunteers among ${st.from} and enrolled ${n} of those who responded.`;
      const groups = assigned
        ? `The researcher randomly assigned ${n / 2} of the participants to ${st.treat} for ${weeks} weeks and the other ${n / 2} not to.`
        : `The researcher asked each participant whether they ${st.treat} and followed all of them for ${weeks} weeks.`;
      const outcome = `At the end of the study, the participants ${assigned ? 'assigned to' : 'who said they'} ${st.treat} ${st.result}, on average, than the other participants.`;
      return mc(
        `${sample} ${groups} ${outcome} Which of the following is the most appropriate conclusion from this study?`,
        set,
        `${sampled
          ? `The participants were selected at random from all ${st.from}, so the result can be generalized to all ${st.pop}.`
          : `The participants were volunteers, not a random sample of ${st.from}, so the result cannot be generalized to all ${st.pop}.`} ${assigned
          ? `They were randomly assigned to groups, so the study supports the conclusion that ${st.ing} causes ${st.effect}.`
          : `They chose for themselves whether to ${st.treat}, so the study shows an association but cannot establish cause and effect.`}`,
      );
    },
  },
  {
    id: 'alg-infinite-solutions',
    domain: 'algebra',
    skill: 'Linear equations in one variable',
    topic: 'Equations with infinitely many solutions',
    difficulty: 'hard',
    build(r) {
      // k(x + p) - qx = mx + c: the x-coefficients fix k, and only then do the
      // constant terms give c = pk. Two conditions, chained.
      const p = r.nonZero(-9, 9);
      const q = r.int(2, 9);
      const m = r.nonZero(-9, 9);
      if (Math.abs(p) === 1) return null; // c would be just k or -k, worked as "c = k = 1(7)"
      const k = m + q;
      if (k === 0) return null; // c would be 0 and the left side would vanish
      const c = p * k;
      const fix = `\\(k = ${k}\\) and \\(c = ${p}(${k}) = ${c}\\)`;
      const set = choiceSet(r, c, [
        [p * m, `This uses \\(k = ${m}\\), the \\(x\\)-coefficient on the right, which ignores the \\(-${q}x\\) on the left and gives \\(c = ${p}(${m}) = ${p * m}\\). The left side's \\(x\\)-coefficient is \\(k - ${q}\\), so ${fix}.`],
        [p * (m - q), `This solves \\(k - ${q} = ${m}\\) by subtracting ${q} from both sides instead of adding it, which gives \\(k = ${m - q}\\) and \\(c = ${p}(${m - q}) = ${p * (m - q)}\\). Adding ${q} gives ${fix}.`],
        [k, `This is the value of \\(k\\), not \\(c\\). Matching the constant terms gives \\(c = ${lead(p, 'k')} = ${p}(${k}) = ${c}\\).`],
        [p, `This distributes \\(k\\) to \\(x\\) but not to \\(${p}\\), so it takes the constant term of the left side to be \\(${p}\\). That constant term is \\(${lead(p, 'k')}\\), and matching the \\(x\\)-coefficients gives \\(k = ${k}\\), so \\(c = ${p}(${k}) = ${c}\\).`],
      ]);
      return mc(
        `\\(k(x ${term(p, '')}) - ${q}x = ${lead(m, 'x')} + c\\)\n\nIn the equation above, \\(k\\) and \\(c\\) are constants. If the equation has infinitely many solutions, what is the value of \\(c\\)?`,
        set,
        `An equation with infinitely many solutions is true for every \\(x\\), so its two sides are the same expression. The left side is \\((k - ${q})x ${term(p, 'k')}\\). Matching the \\(x\\)-coefficients gives \\(k - ${q} = ${m}\\), so \\(k = ${k}\\), and matching the constant terms gives \\(c = ${lead(p, 'k')} = ${p}(${k}) = ${c}\\).`,
      );
    },
  },
  {
    id: 'ps-discount-tax',
    domain: 'problem-solving',
    skill: 'Percentages',
    topic: 'Undoing successive percent changes',
    difficulty: 'hard',
    build(r) {
      const thing = r.pick(['jacket', 'bicycle', 'lamp', 'backpack', 'pair of boots', 'desk chair']);
      const price = r.int(8, 80) * 5; // the original price, in whole dollars
      const off = r.pick([15, 20, 25, 30, 40]);
      const tax = r.pick([5, 6, 8, 10]);
      // Money in cents, on integers. A total that is not a whole number of
      // cents is not something a customer could have paid.
      const paidTimes100 = price * (100 - off) * (100 + tax);
      if (paidTimes100 % 100 !== 0) return null;
      const paid = paidTimes100 / 100;
      const original = price * 100;
      const dollars = (c) => `$${(c / 100).toFixed(2)}`;
      const amt = (c) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2)); // inside math: 100, 86.40
      const keep = String((100 - off) / 100);
      const up = String((100 + tax) / 100);
      const both = String(((100 - off) * (100 + tax)) / 10000);
      const net = String((100 - off + tax) / 100);
      // n / d cents to the nearest cent, and whether any rounding happened.
      const cents = (n, d) => ({ value: Math.round(n / d), exact: n % d === 0 });
      const reversed = cents(paid * (100 + off) * (100 - tax), 10000);
      const combined = cents(paid * 100, 100 - off + tax);
      const discounted = price * (100 - off); // paid / (1 + tax), exactly
      const untaxed = price * (100 + tax); // paid / (1 - off), exactly
      const solve = `\\(${amt(paid)} \\div ${both} = ${amt(original)}\\)`;
      const set = choiceSet(r, dollars(original), [
        [dollars(reversed.value), `This undoes the changes by increasing ${dollars(paid)} by ${off}% and then decreasing the result by ${tax}%${reversed.exact ? '' : ', rounded to the nearest cent'}. The discount was ${off}% of the original price, not of what the customer paid, so each change is undone by dividing: ${solve}.`],
        [dollars(combined.value), `This treats the ${off}% discount and the ${tax}% tax as a single ${off - tax}% decrease${combined.exact ? '' : ', rounded to the nearest cent'}. The tax is ${tax}% of the discounted price, so the total is \\(${both}\\) times the original price, not \\(${net}\\) times it: ${solve}.`],
        [dollars(discounted), `This is the discounted price, \\(${amt(paid)} \\div ${up} = ${amt(discounted)}\\), before the discount is undone. The discounted price is \\(${keep}\\) times the original price, so the original price is \\(${amt(discounted)} \\div ${keep} = ${amt(original)}\\).`],
        [dollars(untaxed), `This undoes the ${off}% discount but not the ${tax}% tax: \\(${amt(paid)} \\div ${keep} = ${amt(untaxed)}\\). Dividing by \\(${up}\\) as well gives ${solve}.`],
      ]);
      return mc(
        `A store discounts the price of a ${thing} by ${off}%, and then a sales tax of ${tax}% is applied to the discounted price. A customer paid a total of ${dollars(paid)} for the ${thing}. What was the original price of the ${thing}?`,
        set,
        `If the original price is \\(p\\) dollars, the discounted price is \\(${keep}p\\) and the total with tax is \\(${up}(${keep}p) = ${both}p\\). Solving \\(${both}p = ${amt(paid)}\\) gives \\(p = ${amt(original)}\\), so the original price was ${dollars(original)}.`,
      );
    },
  },
  {
    id: 'geo-similar-area',
    domain: 'geometry-trig',
    skill: 'Lines, angles, and triangles',
    topic: 'Similar triangles and area',
    difficulty: 'hard',
    build(r) {
      // DE parallel to BC makes triangle ADE similar to triangle ABC with
      // scale factor AB/AD = P/Q in lowest terms. Making the area of ADE Q^2 m
      // keeps every area in the item, right or wrong, a whole number.
      const ad = r.int(2, 9);
      const db = r.int(1, 9);
      // With DB = AD the scale factor is 2, and scaling by DB/AD squared lands
      // on the same value as scaling by AB/AD without squaring.
      if (db === ad) return null;
      const ab = ad + db;
      const g = gcd(ab, ad);
      const P = ab / g;
      const Q = ad / g;
      const m = r.int(1, Math.max(1, Math.floor(240 / (Q * Q))));
      const small = Q * Q * m;
      const whole = P * P * m;
      const quad = whole - small;
      const k = Q === 1 ? String(P) : `\\frac{${P}}{${Q}}`;
      const k2 = Q === 1 ? `${P}^2` : `\\left(\\frac{${P}}{${Q}}\\right)^2`;
      const scaled = `\\(${small} \\times ${k2} = ${whole}\\)`;
      const set = choiceSet(r, quad, [
        [whole, `This is the area of the whole triangle \\(ABC\\), ${scaled}. Quadrilateral \\(DBCE\\) is what remains after removing triangle \\(ADE\\): \\(${whole} - ${small} = ${quad}\\).`],
        [Q * (P - Q) * m, `This multiplies the area of triangle \\(ADE\\) by the scale factor, \\(${k}\\), instead of by its square, which gives ${P * Q * m} for triangle \\(ABC\\) and \\(${P * Q * m} - ${small} = ${Q * (P - Q) * m}\\) for the quadrilateral. Areas scale by the square of the scale factor, so triangle \\(ABC\\) has area ${scaled} and the quadrilateral has area ${quad}.`],
        [(P - Q) * (P - Q) * m, `This multiplies ${small} by the square of \\(\\frac{DB}{AD} = ${ratio(db, ad)}\\), as if quadrilateral \\(DBCE\\) were similar to triangle \\(ADE\\). It is triangle \\(ABC\\) that is similar to triangle \\(ADE\\), with scale factor \\(\\frac{AB}{AD} = ${ratio(ab, ad)}\\), so the quadrilateral has area \\(${small} \\times ${k2} - ${small} = ${quad}\\).`],
      ]);
      return mc(
        `In triangle \\(ABC\\), point \\(D\\) lies on side \\(AB\\) and point \\(E\\) lies on side \\(AC\\) so that \\(DE\\) is parallel to \\(BC\\). If \\(AD = ${ad}\\), \\(DB = ${db}\\), and the area of triangle \\(ADE\\) is ${small}, what is the area of quadrilateral \\(DBCE\\)?`,
        set,
        `Because \\(DE\\) is parallel to \\(BC\\), triangle \\(ADE\\) is similar to triangle \\(ABC\\) with scale factor \\(\\frac{AB}{AD} = ${ratio(ab, ad)}\\). Areas scale by the square of the scale factor, so triangle \\(ABC\\) has area ${scaled}, and quadrilateral \\(DBCE\\) has area \\(${whole} - ${small} = ${quad}\\).`,
      );
    },
  },
];

export const TEMPLATES_BY_DOMAIN = MATH_TEMPLATES.reduce((acc, t) => {
  (acc[t.domain] ||= []).push(t);
  return acc;
}, {});

/**
 * Templates that can serve one (domain, difficulty) cell. A template's own
 * difficulty is the honest label, so asking for `hard` must not hand back an
 * easy template relabelled -- the caller needs to know the cell is unservable
 * and say so, rather than loop forever never filling it.
 */
export function templatesFor(domain, difficulty) {
  return (TEMPLATES_BY_DOMAIN[domain] || []).filter((t) => t.difficulty === difficulty);
}

/**
 * Build one item from a template, re-rolling the seed when a draw produces a
 * degenerate case (repeated roots, colliding distractors, out-of-range values).
 * Returns null if the template cannot produce a usable item in `tries` attempts.
 */
export function buildItem(template, seed, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const built = template.build(rng(seed + i * 7919));
    if (built) return { ...built, templateId: template.id, seed: seed + i * 7919 };
  }
  return null;
}
