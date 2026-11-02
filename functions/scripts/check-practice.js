// Checks the self-guided practice policy, without a database: how a skill's
// record reads as a level, what difficulty it is practised at, and the shape of
// the practice specs handed to the assembly engine.
//
//   npm run check:practice

import assert from 'node:assert/strict';

// lib/practice.js also holds the Firestore-backed profile; nothing here reads it.
const {
  mastery, level, practiceDifficulty, perSkillFor, skillsSpec, sectionSpec, practiceTitle, nextSkills,
} = await import('../lib/practice.js');
const { FULL_SAT_SPEC } = await import('../lib/blueprints.js');
const {
  realismCost, recencyCost, newestOf, TEMPLATE_BIAS, LINEAGE_SEEN, instanceFromRow,
} = await import('../lib/assembly.js');

let passed = 0;
const check = (what, fn) => {
  try { fn(); passed += 1; } catch (err) { console.error(`FAIL ${what}\n  ${err.message}`); process.exitCode = 1; }
};

check('mastery is smoothed toward one half', () => {
  assert.equal(mastery(0, 0), 0.5);
  assert.equal(mastery(1, 1), 2 / 3);
  assert.equal(mastery(9, 10), 10 / 12);
});

check('levels', () => {
  assert.equal(level(0, 0), 'untested');
  assert.equal(level(0, 1), 'focus');      // 0.33
  assert.equal(level(1, 2), 'focus');      // 0.50
  assert.equal(level(1, 1), 'building');   // 0.67: right once is unproven, not strong
  assert.equal(level(2, 2), 'building');   // 0.75
  assert.equal(level(3, 3), 'strong');     // 0.80
  assert.equal(level(7, 10), 'building');  // 0.67
});

check('practice difficulty follows mastery', () => {
  assert.equal(practiceDifficulty(0, 0), 'mixed');
  assert.equal(practiceDifficulty(0, 4), 'easy');
  assert.equal(practiceDifficulty(2, 4), 'mixed');
  assert.equal(practiceDifficulty(8, 8), 'hard');
});

check('a skill set is about a dozen questions, at least three a skill', () => {
  assert.deepEqual([1, 2, 3, 4, 6, 8].map(perSkillFor), [10, 6, 4, 3, 3, 3]);
});

check('a skill set splits by section, reading and writing first, untimed', () => {
  const profile = { skills: [
    { skill: 'Circles', correct: 0, answered: 5 },
    { skill: 'Transitions', correct: 6, answered: 6 },
  ] };
  const spec = skillsSpec(['Circles', 'Transitions', 'Not a skill'], profile);
  assert.deepEqual(spec.sections.map((s) => s.kind), ['rw', 'math']);
  for (const s of spec.sections) {
    assert.equal(s.timeLimitSec, null);
    assert.equal(s.modules.length, 1);
    assert.equal(s.modules[0].adaptive, false);
  }
  const [rw, math] = spec.sections.map((s) => s.modules[0]);
  // Two real skills: six questions each (the unknown name is dropped).
  assert.deepEqual(rw.skills, { Transitions: { n: 6, difficulty: 'hard' } });
  assert.deepEqual(math.skills, { Circles: { n: 6, difficulty: 'easy' } });
  assert.equal(rw.count + math.count, 12);
});

check('an untested skill is practised at mixed difficulty', () => {
  const spec = skillsSpec(['Percentages'], { skills: [] });
  assert.deepEqual(spec.sections[0].modules[0].skills, { Percentages: { n: 10, difficulty: 'mixed' } });
});

check('section specs are the full test, cut to one section', () => {
  assert.equal(sectionSpec('full'), FULL_SAT_SPEC);
  assert.deepEqual(sectionSpec('math').sections.map((s) => s.kind), ['math']);
  assert.deepEqual(sectionSpec('rw').sections.map((s) => s.kind), ['rw']);
  assert.deepEqual(sectionSpec('rw').sections[0], FULL_SAT_SPEC.sections[0]);
});

check('a chosen difficulty applies to every skill, strictly', () => {
  const profile = { skills: [{ skill: 'Circles', correct: 0, answered: 5 }] };
  const spec = skillsSpec(['Circles', 'Transitions'], profile, { difficulty: 'hard' });
  const [rw, math] = spec.sections.map((s) => s.modules[0]);
  assert.deepEqual(rw.skills, { Transitions: { n: 6, difficulty: 'hard', strict: true } });
  assert.deepEqual(math.skills, { Circles: { n: 6, difficulty: 'hard', strict: true } });
});

check('titles', () => {
  assert.equal(practiceTitle('full'), 'Full SAT practice test');
  assert.equal(practiceTitle('skills', ['Circles']), 'Skill practice: Circles');
  assert.equal(practiceTitle('skills', ['Circles', 'Percentages']), 'Skill practice: 2 skills');
  assert.equal(practiceTitle('skills', ['Circles'], 'hard'), 'Skill practice: Circles (hard)');
});

// In a draw a step away from the wanted difficulty costs 1.
const STEP = 1;

check('every draw takes the College Board\'s own questions first, imitations next, templates last', () => {
  const own = { realism: 5 };
  const imitation = { realism: 4 };
  const unrated = {};
  const template = realismCost({ rationale: { template: 'ps-residual' } }) + TEMPLATE_BIAS;
  assert.ok(realismCost(own) < realismCost(imitation), 'the College Board\'s own before an imitation');
  assert.equal(realismCost(unrated), realismCost(imitation), 'an unrated question counts as an imitation');
  // The College Board's own a step off the wanted difficulty before an imitation at it.
  assert.ok(realismCost(own) + STEP < realismCost(imitation));
  // An imitation two steps off before a template at the wanted difficulty.
  assert.ok(realismCost(imitation) + 2 * STEP < template, 'templates last');
});

check('a question met before, with new numbers, comes after every fresh one and before a template', () => {
  const oldest = recencyCost({}, Date.parse('2026-07-30'));
  // A fresh imitation, however old, before the student's own question again.
  assert.ok(realismCost({ realism: 4 }) + oldest < LINEAGE_SEEN + realismCost({ realism: 5 }));
  // The same question with new numbers, however old, before a template.
  assert.ok(LINEAGE_SEEN + realismCost({ realism: 5 }) + oldest < realismCost({ rationale: { template: 'ps-residual' } }) + TEMPLATE_BIAS);
});

check('the newest questions go first, without trading away the difficulty or the College Board\'s own', () => {
  const rows = [{ published_on: '2026-07-30' }, { published_on: '2025-03-31' }, { published_on: '2023-08-02' }, {}];
  const newest = newestOf(rows);
  assert.equal(newest, Date.parse('2026-07-30'));
  const [latest, recent, first, undated] = rows;
  const cost = (r) => recencyCost(r, newest);
  assert.equal(cost(latest), 0);
  assert.ok(cost(latest) < cost(recent) && cost(recent) < cost(first), 'newer before older');
  assert.equal(cost(undated), cost({ published_on: '2019-01-01' }), 'an undated question counts as the oldest');
  assert.equal(cost(undated), cost({ published_on: '2000-01-01' }), 'age counts only so far');
  // Its whole range is less than a step of difficulty, and less than a step of
  // realism: the College Board's oldest question still goes before any imitation.
  assert.ok(cost(undated) < STEP);
  assert.ok(cost(undated) < realismCost({ realism: 4 }) - realismCost({ realism: 5 }));
  // A draw of undated questions has no newest: none is preferred.
  assert.equal(newestOf([{}, {}]), null);
  assert.equal(recencyCost({}, null), recencyCost({ published_on: '2026-01-01' }, null));
});

check('the weak skills take turns', () => {
  const skill = (name, correct, answered) => ({ skill: name, correct, answered, mastery: mastery(correct, answered), level: level(correct, answered) });
  const skills = [
    skill('Circles', 0, 6), skill('Percentages', 1, 6), skill('Transitions', 1, 5), skill('Boundaries', 2, 6),
    skill('Inferences', 2, 5), skill('Words in Context', 6, 6), skill('Area and volume', 0, 0),
  ];
  const first = nextSkills(skills);
  assert.deepEqual(first, ['Circles', 'Percentages', 'Transitions'], 'the weakest first');
  // The skills of the latest sets rest, as long as other skills are weak.
  assert.deepEqual(nextSkills(skills, { resting: first }), ['Boundaries', 'Inferences', 'Circles']);
  // A skill answered right every time, or not yet answered, is not weak.
  assert.ok(!nextSkills(skills).includes('Words in Context') && !nextSkills(skills).includes('Area and volume'));
  // Nothing to practise in a skill keeps it out.
  assert.deepEqual(nextSkills(skills, { practicable: (x) => x.skill !== 'Circles' }), ['Percentages', 'Transitions', 'Boundaries']);
  // With no other weak skills, the same ones come back.
  assert.deepEqual(nextSkills(skills.slice(0, 2), { resting: ['Circles', 'Percentages'] }), ['Circles', 'Percentages']);
});

check('choices that are figures keep their order, so the picture\'s labels name them', () => {
  const row = (figures) => ({ id: 'q', section: 'math', answer_type: 'multiple-choice', choices: ['a', 'b', 'c', 'd'], correct_idx: 2,
    rationale: { correct: 'c is right', A: 'not a', B: 'not b', D: 'not d' }, figure: figures ? { figures } : null });
  const pictured = row(['A', 'B', 'C', 'D'].map((choice) => ({ kind: 'table', choice })));
  for (let i = 0; i < 20; i += 1) {
    const q = instanceFromRow(pictured);
    assert.deepEqual(q.choices, ['a', 'b', 'c', 'd']);
    assert.equal(q.correctIdx, 2);
    assert.equal(q.rationale.A, 'not a');
  }
  // Any other question's choices are shuffled for every student.
  const orders = new Set(Array.from({ length: 40 }, () => instanceFromRow(row(null)).choices.join('')));
  assert.ok(orders.size > 1);
});

if (!process.exitCode) console.log(`${passed} practice checks pass`);
