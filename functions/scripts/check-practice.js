// Checks the self-guided practice policy, without a database: how a skill's
// record reads as a level, what difficulty it is practised at, and the shape of
// the practice specs handed to the assembly engine.
//
//   npm run check:practice

import assert from 'node:assert/strict';

// lib/practice.js also holds the database-backed profile. Nothing here queries,
// but loading the module reads the config, which requires a database URL.
process.env.DATABASE_URL ||= 'postgres://unused@localhost/unused';
const {
  mastery, level, practiceDifficulty, perSkillFor, skillsSpec, sectionSpec, practiceTitle,
} = await import('../lib/practice.js');
const { FULL_SAT_SPEC } = await import('../lib/blueprints.js');

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

check('a test is drawn as an exam, a skill set as practice', () => {
  assert.notEqual(sectionSpec('full').exam, false);
  assert.notEqual(sectionSpec('math').exam, false);
  assert.equal(skillsSpec(['Circles'], null).exam, false);
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

if (!process.exitCode) console.log(`${passed} practice checks pass`);
