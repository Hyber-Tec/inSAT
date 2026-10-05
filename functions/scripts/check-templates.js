// Validates every math template across many seeds.
//
// Two layers. Structural checks run on every template: a skill from the
// taxonomy, four distinct non-empty options, a correct index in range, balanced
// LaTeX delimiters, no stringified undefined/NaN, em dash or zero term ("+ 0",
// "0x") in the stem or choices, and an explanation for every wrong choice that
// opens with "This", renders cleanly and never names a choice by its letter. Then
// independent solvers re-derive the answer by PARSING THE RENDERED QUESTION --
// they never call the template's own arithmetic -- so a template that computes
// its key wrongly is caught here rather than in front of a student. A solver
// whose answer is not a single number (an inequality, an expression, a
// conclusion) judges every choice instead, and the key must be the only one
// it accepts.
//
// Run: node functions/scripts/check-templates.js [seedsPerTemplate]

import { MATH_TEMPLATES, buildItem } from '../lib/templates/math.js';
import { DOMAINS, SKILLS } from '../lib/taxonomy.js';
import { itemProblems } from '../lib/itemChecks.js';
import { pathToFileURL } from 'node:url';

const SEEDS = Number(process.argv[2]) || 300;
const failures = [];
const fail = (t, seed, msg, item) => failures.push({ id: t.id, seed, msg, item });

const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));

/** The LaTeX inside a choice or span written as \( ... \). */
const inner = (s) => String(s).replace(/^\\\(\s*|\s*\\\)$/g, '');

/**
 * The value at x of an expression as the templates render it: integers and
 * decimals, x, + and -, implicit products, parentheses, powers (a digit or a
 * braced exponent) and \frac{..}{..}. Anything else throws, so a solver never
 * quietly misreads a stem.
 */
function evalTex(tex, x) {
  const s = tex.replace(/\\left|\\right/g, '').replace(/\s+/g, '');
  let i = 0;
  const bad = () => { throw new Error(`cannot read "${tex}" at ${i}`); };
  const group = () => {
    if (s[i] !== '{') bad();
    i += 1;
    const v = sum();
    if (s[i++] !== '}') bad();
    return v;
  };
  const atom = () => {
    if (s[i] === '(') {
      i += 1;
      const v = sum();
      if (s[i++] !== ')') bad();
      return v;
    }
    if (s[i] === '{') return group();
    if (s[i] === 'x') { i += 1; return x; }
    if (s.startsWith('\\frac', i)) {
      i += 5;
      const n = group();
      return n / group();
    }
    const m = s.slice(i).match(/^\d+(?:\.\d+)?/);
    if (!m) bad();
    i += m[0].length;
    return Number(m[0]);
  };
  const power = () => {
    const base = atom();
    if (s[i] !== '^') return base;
    i += 1;
    return base ** (s[i] === '{' ? group() : Number(s[i++]));
  };
  // A signed run of factors: -2x(x - 5), 3x^2, (x + 1)(x - 4).
  const product = () => {
    let sign = 1;
    while (s[i] === '+' || s[i] === '-') if (s[i++] === '-') sign = -sign;
    let v = power();
    while (i < s.length && /[\d.x({\\]/.test(s[i])) v *= power();
    return sign * v;
  };
  const sum = () => {
    let v = product();
    while (s[i] === '+' || s[i] === '-') v = s[i++] === '+' ? v + product() : v - product();
    return v;
  };
  const v = sum();
  if (i !== s.length) bad();
  return v;
}

const COMPARE = { '<': (u, v) => u < v, '>': (u, v) => u > v, '\\le': (u, v) => u <= v, '\\ge': (u, v) => u >= v };

/** Whether a rendered inequality ("10 - 6x < 2 - 4x", "x \ge -6") holds at x. */
function holds(tex, x) {
  const [left, op, right, ...rest] = tex.split(/\s(<|>|\\le|\\ge)\s/);
  if (!COMPARE[op] || rest.length) throw new Error(`not one inequality: "${tex}"`);
  return COMPARE[op](evalTex(left, x), evalTex(right, x));
}

/** Report an item's first structural problem (lib/itemChecks.js). */
function structural(t, seed, item) {
  const [problem] = itemProblems(item);
  if (problem) fail(t, seed, problem, item);
}

// --- Independent solvers: parse the stem, solve it, compare to the key -------
const SOLVERS = {
  'alg-linear-solve'(item) {
    const m = item.question.match(/\\\((-?\d*)x\s*([+-])\s*(\d+)\s*=\s*(-?\d+)\\\)/);
    if (!m) return null;
    const a = m[1] === '' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
    const b = (m[2] === '-' ? -1 : 1) * Number(m[3]);
    const c = Number(m[4]);
    return String((c - b) / a);
  },
  'geo-pythagorean'(item) {
    const m = item.question.match(/lengths (\d+) and (\d+)/);
    if (!m) return null;
    return String(Math.sqrt(Number(m[1]) ** 2 + Number(m[2]) ** 2));
  },
  'ps-unit-rate'(item) {
    const m = item.question.match(/produces (\d+) parts in (\d+) hours.*?in (\d+) hours/s);
    if (!m) return null;
    return String((Number(m[1]) / Number(m[2])) * Number(m[3]));
  },
  'ps-mean-missing'(item) {
    const m = item.question.match(/mean of (\d+)\.\s*(\d+) of the numbers are ([\d, ]+)\./);
    if (!m) return null;
    const n = item.question.match(/data set of (\d+) numbers/);
    const known = m[3].split(',').map((v) => Number(v.trim()));
    return String(Number(m[1]) * Number(n[1]) - known.reduce((s, v) => s + v, 0));
  },
  'geo-volume'(item) {
    const m = item.question.match(/radius of (\d+) and a height of (\d+)/);
    if (!m) return null;
    return String(Number(m[1]) ** 2 * Number(m[2]));
  },
  'alg-linear-model'(item) {
    const m = item.question.match(/fee of \$(\d+).*?\$(\d+) per month.*?lasting (\d+) months/s);
    if (!m) return null;
    return String(Number(m[1]) + Number(m[2]) * Number(m[3]));
  },
  'adv-discriminant'(item) {
    const m = item.question.match(/x\^2\s*([+-])\s*(\d+)x\s*\+\s*c\s*=\s*0/);
    if (!m) return null;
    const b = (m[1] === '-' ? -1 : 1) * Number(m[2]);
    return String((b * b) / 4);           // one repeated root <=> b^2 - 4c = 0
  },
  'geo-circle-equation'(item) {
    const m = item.question.match(/x\^2 \+ y\^2\s*([+-])\s*(\d+)x\s*([+-])\s*(\d+)y\s*([+-])\s*(\d+)\s*=\s*0/);
    if (!m) return null;
    const D = (m[1] === '-' ? -1 : 1) * Number(m[2]);
    const E = (m[3] === '-' ? -1 : 1) * Number(m[4]);
    const F = (m[5] === '-' ? -1 : 1) * Number(m[6]);
    return String(Math.sqrt((D * D) / 4 + (E * E) / 4 - F));
  },
  'ps-weighted-mean'(item) {
    const m = item.question.match(/(\d+) students scored an average of (\d+).*?other (\d+) students scored an average of (\d+)/s);
    if (!m) return null;
    const [n1, a1, n2, a2] = m.slice(1).map(Number);
    return String((n1 * a1 + n2 * a2) / (n1 + n2));
  },
  'alg-no-solution'(item) {
    const m = item.question.match(/kx\s*([+-])\s*(\d+)y\s*=\s*-?\d+.*?\\\((-?\d+)x\s*([+-])\s*(\d+)y/s);
    if (!m) return null;
    const b = (m[1] === '-' ? -1 : 1) * Number(m[2]);
    const mm = Number(m[3]);
    const n = (m[4] === '-' ? -1 : 1) * Number(m[5]);
    return String((mm * b) / n);          // parallel lines <=> k/m = b/n
  },
  'geo-similar'(item) {
    const m = item.question.match(/length (\d+) and corresponds.*?which has length (\d+).*?length (\d+)/s);
    if (!m) return null;
    return String((Number(m[2]) / Number(m[1])) * Number(m[3]));
  },
  'alg-inequality'(item) {
    const m = item.question.match(/inequality \\\((.+?)\\\)\?$/);
    if (!m) return null;
    // The choice that holds exactly where the original does, tested on a
    // half-step grid that covers every boundary a draw can produce, strictness
    // included (a boundary is a whole number, so it is on the grid).
    const xs = Array.from({ length: 241 }, (_, i) => -60 + i / 2);
    return item.choices.flatMap((c, i) => (xs.every((x) => holds(inner(c), x) === holds(m[1], x)) ? [i] : []));
  },
  'adv-equivalent'(item) {
    const m = item.question.match(/equivalent to \\\((.+?)\\\)\?$/);
    if (!m) return null;
    // Two quadratics that agree at more than two points are the same quadratic.
    const xs = [-7, -2, 0, 1, 3, 10];
    return item.choices.flatMap((c, i) => (xs.every((x) => evalTex(inner(c), x) === evalTex(m[1], x)) ? [i] : []));
  },
  'ps-best-fit'(item) {
    const m = item.question.match(/\\\(y = (\d+(?:\.\d+)?)x \+ (\d+)\\\)\. (.*)$/s);
    if (!m) return null;
    const predict = (x) => Number(m[1]) * x + Number(m[2]);
    const asked = [...m[3].matchAll(/\d+(?:\.\d+)?/g)].map((v) => Number(v[0]));
    // Two x-values: the larger prediction minus the smaller. One y-value: the
    // x the line predicts it for.
    if (asked.length === 2) return String(predict(asked[0]) - predict(asked[1]));
    if (asked.length === 1) return String((asked[0] - Number(m[2])) / Number(m[1]));
    return null;
  },
  'ps-margin-of-error'(item) {
    const total = item.question.match(/ has ([\d,]+) /);
    const pct = item.question.match(/(\d+)% of those surveyed/);
    const margin = item.question.match(/margin of error for this estimate is (\d+) percentage points/);
    if (!total || !pct || !margin) return null;
    // The plausible percentages for the whole population, applied to its size.
    const [lo, hi] = [-1, 1].map((sign) => (num(total[1]) * (Number(pct[1]) + sign * Number(margin[1]))) / 100);
    return item.choices.flatMap((c, i) => {
      const m = String(c).match(/^Between ([\d,]+) and ([\d,]+)$/);
      return m && num(m[1]) === lo && num(m[2]) === hi ? [i] : [];
    });
  },
  'ps-study-design'(item) {
    const q = item.question;
    const sampled = /selected \d+ \w+ at random from all /.test(q);
    const volunteers = /advertised for volunteers/.test(q);
    const assigned = /randomly assigned/.test(q);
    const selfChosen = /asked each participant whether they/.test(q);
    if (sampled === volunteers || assigned === selfChosen) return null; // the stem must state each design fact once
    // A random sample lets the result extend to the population; random
    // assignment is what supports cause and effect.
    return item.choices.flatMap((c, i) => {
      const cause = /\bcauses\b/.test(c) && !/cause-and-effect relationship cannot be concluded/.test(c);
      const general = !/cannot be generalized/.test(c);
      return cause === assigned && general === sampled ? [i] : [];
    });
  },
  'alg-infinite-solutions'(item) {
    const m = item.question.match(/^\\\((k\(x [+-] \d+\) - \d+x) = (-?\d*x) \+ c\\\)/);
    if (!m) return null;
    // Infinitely many solutions: left minus right is the same number for every
    // x. Search for the k that makes the x-terms cancel; c is what is left over.
    const left = (k, x) => evalTex(m[1].replace('k', `(${k})`), x);
    const right = (x) => evalTex(m[2], x);
    const gap = (k, x) => left(k, x) - right(x);
    const ks = Array.from({ length: 201 }, (_, i) => i - 100).filter((k) => [1, 2, 5].every((x) => gap(k, x) === gap(k, 0)));
    return ks.length === 1 ? String(gap(ks[0], 0)) : null;
  },
  'ps-discount-tax'(item) {
    const m = item.question.match(/by (\d+)%, and then a sales tax of (\d+)% .*? a total of \$(\d+\.\d\d) /s);
    if (!m) return null;
    const [off, tax, paid] = m.slice(1).map(Number);
    // What was paid is the original price times (1 - off) and then times (1 + tax).
    return String(Math.round((100 * paid) / ((1 - off / 100) * (1 + tax / 100))) / 100);
  },
  'geo-similar-area'(item) {
    const ad = item.question.match(/AD = (\d+)/);
    const db = item.question.match(/DB = (\d+)/);
    const area = item.question.match(/area of triangle \\\(ADE\\\) is (\d+)/);
    if (!ad || !db || !area) return null;
    // Triangle ABC is triangle ADE scaled by AB/AD, so its area is scaled by
    // the square; the quadrilateral is the difference.
    const scale = (Number(ad[1]) + Number(db[1])) / Number(ad[1]);
    return String(Number(area[1]) * scale * scale - Number(area[1]));
  },
};

function independent(t, seed, item) {
  const solve = SOLVERS[t.id];
  if (!solve) return;
  let expected;
  try { expected = solve(item); } catch { expected = null; }
  if (expected === null || expected === undefined) return fail(t, seed, 'solver could not parse the stem', item);
  if (Array.isArray(expected)) {
    if (expected.length !== 1 || expected[0] !== item.correctIdx) {
      const accepted = expected.length ? expected.map((i) => item.choices[i]).join(' | ') : 'no choice';
      fail(t, seed, `key is ${item.choices[item.correctIdx]}, independent check accepts ${accepted}`, item);
    }
    return;
  }
  const keyed = item.answerType === 'grid-in' ? item.answerText : item.choices[item.correctIdx];
  // Equal up to floating-point noise: 1.2 * 9 - 1.2 * 4 is 6.000000000000001.
  const want = Number(expected);
  if (!(Math.abs(num(keyed) - want) <= 1e-9 * Math.max(1, Math.abs(want)))) {
    fail(t, seed, `key says ${keyed}, independent solve says ${expected}`, item);
  }
}

/** Check the exact item being imported, with an independent solver required. */
export function verifyTemplateItem(template, item) {
  const start = failures.length;
  if (!SOLVERS[template.id]) return { verified: false, errors: ['No independent solver for this template'] };
  if (!(SKILLS[template.domain] || []).includes(template.skill)) {
    return { verified: false, errors: ['Unknown domain or skill'] };
  }
  structural(template, item.seed, item);
  independent(template, item.seed, item);
  const errors = failures.splice(start).map((f) => f.msg);
  return { verified: errors.length === 0, errors };
}

export function checkTemplates() {
  let built = 0;
  let skipped = 0;
  const covered = [];
  for (const t of MATH_TEMPLATES) {
    // Items are filed and measured by skill, so a skill spelled differently from
    // the taxonomy's would be a skill no student is ever given practice in.
    if (!(SKILLS[t.domain] || []).includes(t.skill)) fail(t, 0, `skill "${t.skill}" is not one of the ${t.domain} skills in taxonomy.js`);
    if (SOLVERS[t.id]) covered.push(t.id);
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const item = buildItem(t, seed * 1013);
      if (!item) { skipped += 1; continue; }
      built += 1;
      structural(t, seed, item);
      independent(t, seed, item);
    }
  }

  console.log(`templates        ${MATH_TEMPLATES.length}`);
  console.log(`items built      ${built} (${SEEDS} seeds each)`);
  console.log(`re-rolled out    ${skipped}`);
  console.log(`independently checked  ${covered.length}/${MATH_TEMPLATES.length} templates: ${covered.join(', ')}`);
  const mathSkills = DOMAINS.math.flatMap((d) => SKILLS[d]);
  const untemplated = mathSkills.filter((s) => !MATH_TEMPLATES.some((t) => t.skill === s));
  console.log(`math skills with a template  ${mathSkills.length - untemplated.length}/${mathSkills.length}${untemplated.length ? `, none for: ${untemplated.join('; ')}` : ''}`);

  if (failures.length) {
    console.error(`\nFAILURES: ${failures.length}`);
    for (const f of failures.slice(0, 12)) {
      console.error(`\n  [${f.id}] seed ${f.seed}: ${f.msg}`);
      if (f.item) console.error(`    ${f.item.question}\n    choices: ${JSON.stringify(f.item.choices)} idx ${f.item.correctIdx} ${f.item.answerText ?? ''}\n    rationale: ${JSON.stringify(f.item.rationale)}`);
    }
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkTemplates();
