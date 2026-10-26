// Official explanations put in the bank's shape (lib/official.js): the right
// answer's explanation and each wrong choice's, with no choice named by its
// letter, since choices are shuffled for every student; and the shapes that
// cannot be, which keep their question reference material. Also which practice
// tests are the College Board's own, how each question is rated, and how an
// import keeps the served questions in line with its dataset
// (lib/datasetSync.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { collegeBoardTests, officialRationale, officialRealism } from '../lib/official.js';
import { byCell, holds, planSync } from '../lib/datasetSync.js';
import { contentHash } from '../lib/items.js';
import { simhash } from '../lib/similarity.js';

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

test('an angle or point in function notation is not a choice named by letter', () => {
  const { rationale } = mc('Choice B is correct. Since \\(\\tan(A) = \\sqrt{3}\\), it follows that \\(\\tan(D) = \\sqrt{3}\\) and \\(f(C) = 2\\).\n\nChoice A is incorrect and may result from using \\(\\sin(A)\\).');
  assert.match(rationale.correct, /tan\(D\)/);
  assert.match(mc('Choice B is correct, as (A) and (C) are too small.').why, /names a choice by letter/);
});

test('when the choices are figures, which keep their order, a letter in the explanation stays', () => {
  const figures = ['A', 'B', 'C', 'D'].map((choice) => ({ kind: 'graph', choice }));
  const { rationale } = officialRationale({
    answer_type: 'multiple-choice', answer: 'B', figures,
    rationale: 'Choice B is correct. The lines meet at (2, 4). Choice B is a graph that shows them meeting there. Thus, choice B represents the system.\n\nChoice A is incorrect. This graph shows lines that never meet, unlike choice B.',
  });
  assert.match(rationale.correct, /Choice B is a graph that shows them meeting there\. Thus, choice B represents the system\./);
  assert.equal(rationale.A, 'This choice is incorrect. This graph shows lines that never meet, unlike choice B.');
  // The same explanation for choices that are shuffled is not served.
  assert.ok(mc('Choice B is correct. The lines meet at (2, 4). Choice B is a graph that shows them meeting there.').why);
});

// A served question and a dataset row of the College Board's bank, by its id.
const served = (id, cb, fields = {}) => ({ id, content_hash: `h-${cb}`, rationale: { collegeBoardId: cb }, retired_at: null, difficulty: 'easy', question: 'Q', ...fields });
const dataset = (cb, fields = {}) => ({ content_hash: `h-${cb}`, rationale: { collegeBoardId: cb }, difficulty: 'easy', question: 'Q', ...fields });
const originOf = (r) => (r.rationale && 'collegeBoardId' in r.rationale ? JSON.stringify(r.rationale.collegeBoardId) : null);

test('a sync changes a question in place, by where it came from', () => {
  const { updates, moves, counts } = planSync({
    have: [served('i1', 'a'), served('i2', 'b'), served('i3', 'c'), served('i4', 'd', { retired_at: new Date() }), served('i9', null, { rationale: { classmarker: { id: 1 } } })],
    rows: [
      dataset('a', { difficulty: 'hard', published_on: '2026-04-16' }), // re-rated and dated: the same identity
      dataset('b', { content_hash: 'h-b2', question: 'Q, reworded' }),     // reworded: it moves to a new identity
      dataset('d'),                                                     // the dataset holds it again
    ],
    originOf,
  });
  assert.deepEqual(updates.map((u) => [u.item.id, u.changes]), [
    ['i1', { difficulty: 'hard', published_on: '2026-04-16' }],
    ['i3', { retired_at: updates.find((u) => u.item.id === 'i3').changes.retired_at }],
    ['i4', { retired_at: null }],
  ]);
  assert.ok(updates.find((u) => u.item.id === 'i3').changes.retired_at instanceof Date, 'one the dataset dropped retires');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].item.id, 'i2', 'a reworded question keeps its id');
  assert.deepEqual(moves[0].changes, { question: 'Q, reworded' });
  assert.equal(moves[0].fresh, true);
  assert.deepEqual(counts, { retired: 1, restored: 1, changed: 2, moved: 1, repeats: 0 });
  // A question of another collection (the academy's own) is not the dataset's to retire.
  assert.ok(![...updates, ...moves].some((u) => u.item.id === 'i9'));
});

test('a reworded question another one already holds retires as a repeat; a held one is not served', () => {
  const { updates, moves, counts } = planSync({
    have: [served('i1', 'a'), served('i2', 'b')],
    rows: [dataset('a', { content_hash: 'h-x' }), dataset('b')],
    originOf,
    holderOf: (hash) => (hash === 'h-x' ? 'i7' : null),
    held: new Set([JSON.stringify('b')]),
  });
  assert.equal(moves.length, 0);
  assert.deepEqual(updates.map((u) => u.item.id), ['i1', 'i2']);
  assert.ok(updates.every((u) => u.changes.retired_at instanceof Date));
  assert.equal(counts.repeats, 1);
  // Run again on what it left, nothing changes.
  const again = planSync({ have: [served('i1', 'a', { content_hash: 'h-a' })], rows: [dataset('a')], originOf });
  assert.deepEqual([again.updates, again.moves], [[], []]);
});

test('a copy of a bank question is the same question, or the same words with the same answer where there is a figure', () => {
  const q = (question, choices, correct, extra = {}) => {
    const row = { section: 'math', domain: 'algebra', question, choices, correct_idx: correct, answer_type: 'multiple-choice', passage: null, ...extra };
    // A figure is part of a question's identity, as the bank's figure fingerprint makes it.
    return { ...row, content_hash: contentHash({ ...row, figure: extra.asset_id }), simhash: simhash(row) };
  };
  const stem = 'The graph of the linear function f is shown, where y = f(x). What is the y-intercept of the graph of y = f(x)?';
  const bank = byCell([q(stem, ['(0, 4)', '(0, 2)', '(4, 0)', '(2, 0)'], 0, { asset_id: 'fig-1' })]);
  // Reworded slightly, no figure on either side would do; with a figure the answer must agree.
  assert.ok(holds(bank, q(stem, ['(0, 4)', '(0, 2)', '(4, 0)', '(2, 0)'], 0, { asset_id: 'fig-9' })));
  assert.ok(!holds(bank, q(stem, ['(0, 4)', '(0, 2)', '(4, 0)', '(2, 0)'], 1, { asset_id: 'fig-9' })), 'the same words of another graph');
  const plain = byCell([q('If 3x + 5 = 20, what is the value of x?', ['5', '15', '25', '3'], 0)]);
  assert.ok(holds(plain, q('If 3x + 5 = 20, what is the value of x?', ['5', '15', '25', '3'], 0)));
  assert.ok(!holds(plain, q('A gym charges a fee of $30 plus $12 a month. What is the cost of 9 months?', ['$138', '$108', '$42', '$270'], 0)));
});
