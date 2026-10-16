// Official explanations put in the bank's shape (lib/official.js): the right
// answer's explanation and each wrong choice's, with no choice named by its
// letter, since choices are shuffled for every student; and the shapes that
// cannot be, which keep their question reference material. Also which practice
// tests are the College Board's own, and how each question is rated.

import test from 'node:test';
import assert from 'node:assert/strict';
import { collegeBoardTests, officialRationale, officialRealism } from '../lib/official.js';

const mc = (rationale, answer = 'B') => officialRationale({ answer_type: 'multiple-choice', answer, rationale });

test('the right answer and each wrong choice get their own explanation', () => {
  const { rationale } = mc([
    'Choice B is correct. Applying the commutative property, the expression can be rewritten as \\(m^{5}q^{9}z^{2}\\).',
    'Choice A is incorrect and may result from multiplying, not adding, the exponents.',
    'Choice C is incorrect and may result from conceptual or calculation errors.',
    'Choice D is incorrect and may result from conceptual or calculation errors.',
  ].join('\n\n'));
  assert.deepEqual(rationale, {
    correct: 'Applying the commutative property, the expression can be rewritten as \\(m^{5}q^{9}z^{2}\\).',
    A: 'This choice is incorrect and may result from multiplying, not adding, the exponents.',
    C: 'This choice is incorrect and may result from conceptual or calculation errors.',
    D: 'This choice is incorrect and may result from conceptual or calculation errors.',
  });
});

test('a grid-in explanation stays whole', () => {
  const text = 'The correct answer is \\(\\frac{7}{6}\\). Subtracting the exponents gives \\(x^{\\frac{7}{6}}\\). Note that 7/6 and 1.166 are examples of ways to enter a correct answer.';
  assert.deepEqual(officialRationale({ answer_type: 'grid-in', answer: '7/6', rationale: text }), { rationale: { correct: text } });
});

test('a reason given for several choices goes to each of them', () => {
  const { rationale } = mc('Choice B is correct. Combining like terms yields \\(5x^{2} - 2x + 3\\).\n\nChoices A, C, and D are incorrect and may be the result of errors when applying the distributive property.');
  for (const letter of ['A', 'C', 'D']) {
    assert.equal(rationale[letter], 'This choice is incorrect and may be the result of errors when applying the distributive property.');
  }
  assert.equal(rationale.B, undefined);
});

test('choices explained in one paragraph are told apart', () => {
  const { rationale } = mc('Choice B is correct. The slope is 2.\n\nChoice A is incorrect and may result from using the y-intercept. Choice C is incorrect and may result from a sign error. Choice D is incorrect. This is the value of the y-intercept.');
  assert.equal(rationale.A, 'This choice is incorrect and may result from using the y-intercept.');
  assert.equal(rationale.C, 'This choice is incorrect and may result from a sign error.');
  assert.equal(rationale.D, 'This choice is incorrect. This is the value of the y-intercept.');
});

test('the practice tests\' labels, lead-ins and alternate approaches find their place', () => {
  const { rationale } = mc([
    'The question asks for the value of \\(x\\).',
    'Key Explanation: Choice C is the best answer because subtracting 3 from both sides gives \\(x = 4\\).',
    'Alternate approach: substituting each choice into the equation shows only 4 works.',
    'Distractor Explanations: Choice A is incorrect and may result from adding 3.',
  ].join('\n\n'), 'C');
  assert.equal(rationale.correct, [
    'The question asks for the value of \\(x\\).',
    'This is the best answer because subtracting 3 from both sides gives \\(x = 4\\).',
    'Alternate approach: substituting each choice into the equation shows only 4 works.',
  ].join('\n\n'));
  assert.equal(rationale.A, 'This choice is incorrect and may result from adding 3.');
});

test('an explanation that still names a choice by letter is not served', () => {
  assert.match(mc('Choice B is correct. The answer is 4.\n\nChoice A is incorrect. This is half of the value in choice C.').why, /names a choice by letter/);
  assert.match(mc('Choice B is correct, since (A) and (C) are too small.').why, /names a choice by letter/);
  assert.match(officialRationale({ answer_type: 'grid-in', answer: '4', rationale: 'The correct answer is 4, which choice B in another form also gives.' }).why, /names a choice by letter/);
});

test('an explanation that disagrees with the key, or has another shape, is not served', () => {
  assert.match(mc('Choice C is correct. The answer is 4.').why, /calls another choice correct/);
  assert.match(mc('Choice B is correct. It is 4.\n\nChoice B is incorrect and may result from an error.').why, /calls the key incorrect/);
  assert.match(mc('Choice B is correct. It is 4.\n\nChoices A and C are incorrect because they ignore the sign.').why, /another shape/);
  assert.match(mc('The slope is 2, so the line rises.').why, /right answer not found/);
  assert.match(mc('').why, /no explanation/);
  assert.match(mc('Choice B is correct.', '').why, /no answer key/);
});

test('a Reading and Writing explanation takes the same shape', () => {
  const { rationale } = mc([
    'Choice A is the best answer. Text 1 states that the root\'s "rise to popularity was slow," and Text 2 also describes its "slow adoption."',
    'Choice B is incorrect. This isn\'t something that either text claims. Choice C is incorrect. Neither text mentions the climate. Choice D is incorrect. Neither text describes how the root is cooked.',
  ].join('\n\n'), 'A');
  assert.equal(rationale.correct, 'Text 1 states that the root\'s "rise to popularity was slow," and Text 2 also describes its "slow adoption."');
  assert.equal(rationale.B, 'This choice is incorrect. This isn\'t something that either text claims.');
  assert.equal(rationale.C, 'This choice is incorrect. Neither text mentions the climate.');
  assert.equal(rationale.D, 'This choice is incorrect. Neither text describes how the root is cooked.');
});

test('a practice test most of whose questions the bank holds is the College Board\'s own', () => {
  const q = (test, question, choices = ['1', '2', '3', '4']) => ({ test, section: 'math', question, choices });
  const bank = [q(null, 'What is 2 + 2?'), q(null, 'What is  3 + 3 ?'), q(null, 'Solve 2x = 8.')];
  const tests = [
    // The bank's questions, as transcribed again: spacing and case aside.
    q(8, 'what is 2 + 2?'), q(8, 'What is 3 + 3?'), q(8, 'Solve 2x = 8.'), q(8, 'A question of its own.'),
    // A third party's: one bank question among its own.
    q(14, 'What is 2 + 2?'), q(14, 'Another question.'), q(14, 'And another.'),
  ];
  assert.deepEqual([...collegeBoardTests(tests, bank)], [8]);
});

test('the College Board\'s own questions are rated above a third party\'s', () => {
  const own = new Set([8]);
  assert.equal(officialRealism('cb', {}, own), 5);
  assert.equal(officialRealism('dsat', { test: 8 }, own), 5);
  assert.equal(officialRealism('dsat', { test: 14 }, own), 4);
});
