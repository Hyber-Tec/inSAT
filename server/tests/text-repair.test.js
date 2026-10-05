import test from 'node:test';
import assert from 'node:assert/strict';
import { repairText, repairItemText } from '../lib/textRepair.js';

test('a backslash lost to a JSON escape comes back', () => {
  assert.equal(repairText('so \\(\\cos(C)=-\frac{\\sqrt{3}}{2}\\).'), 'so \\(\\cos(C)=-\\frac{\\sqrt{3}}{2}\\).');
  assert.equal(repairText('\\(\beta + 1\\)'), '\\(\\beta + 1\\)');
  assert.equal(repairText('\\(\vec{v}\\)'), '\\(\\vec{v}\\)');
  // bare LaTeX in prose too
  assert.equal(repairText('The value \frac{1}{2} is not it.'), 'The value \\frac{1}{2} is not it.');
});

test('a tab or carriage return is a lost backslash only before a command, inside math', () => {
  assert.equal(repairText('\\(3\times 4\\)'), '\\(3\\times 4\\)');
  assert.equal(repairText('\\(\right)\\)'), '\\(\\right)\\)');
  assert.equal(repairText('\\(a\tb\\)'), '\\(a\tb\\)');
  assert.equal(repairText('Column A\tan apple'), 'Column A\tan apple');
});

test('an escaped line break becomes a line break, a command starting with n stays', () => {
  assert.equal(repairText('cylinder B.\\n\\nRight cylinder A: \\(250\\pi\\)\\nRight'), 'cylinder B.\n\nRight cylinder A: \\(250\\pi\\)\nRight');
  assert.equal(repairText('\\(x=1\\)\\n\\(y=2\\)'), '\\(x=1\\)\n\\(y=2\\)');
  assert.equal(repairText('x \\neq 3 and \\nu'), 'x \\neq 3 and \\nu');
  // a row break followed by n, inside math, is LaTeX
  assert.equal(repairText('\\(\\begin{cases}a \\ge 1\\\\n \\le 2\\end{cases}\\)'), '\\(\\begin{cases}a \\ge 1\\\\n \\le 2\\end{cases}\\)');
  // a line break that swallowed \n of \neq inside math
  assert.equal(repairText('\\(x \neq 3\\)'), '\\(x \\neq 3\\)');
});

test('$ and % inside math are escaped, outside and escaped ones are not', () => {
  assert.equal(repairText('about \\(($66,000-$26,000)/10=$4,000\\), not $2,600'), 'about \\((\\$66,000-\\$26,000)/10=\\$4,000\\), not $2,600');
  assert.equal(repairText('\\(5\\%\\) and \\(5%\\)'), '\\(5\\%\\) and \\(5\\%\\)');
  assert.equal(repairText('$$x^2$$'), '$$x^2$$');
});

test('math delimiters written as bare parentheses come back', () => {
  assert.equal(
    repairText('The short leg is (5/\\sqrt{3}=5\\sqrt{3}/3), not (5/2); the hypotenuse is (10\\sqrt{3}/3).'),
    'The short leg is \\(5/\\sqrt{3}=5\\sqrt{3}/3\\), not \\(5/2\\); the hypotenuse is \\(10\\sqrt{3}/3\\).',
  );
  // without a LaTeX command anywhere, parentheses are parentheses
  assert.equal(repairText('Multiply by (1/2) twice.'), 'Multiply by (1/2) twice.');
  // a function's argument, words, and math already delimited stay
  assert.equal(repairText('f(\\sqrt{2}) is \\(2\\) (see the figure).'), 'f(\\sqrt{2}) is \\(2\\) (see the figure).');
  assert.equal(repairText('It is (2\\sqrt{2}) (the long leg).'), 'It is \\(2\\sqrt{2}\\) (the long leg).');
  // real grouping: a base, a factor, a group inside a group
  const grouping = 'restored as (1 + \\sqrt{k})^{2} - 2(1 + \\sqrt{k}), (1 + \\sqrt{2})l and ((-3 - \\sqrt{2}) + 1)';
  assert.equal(repairText(grouping), grouping);
});

test('repairing is idempotent and reaches what a student reads, nothing else', () => {
  const damaged = {
    question: 'Solve.\\n\\(x=1\\)',
    choices: ['\\(\frac{1}{2}\\)', '2'],
    rationale: { correct: 'so \\(\\sin(C)=\frac{1}{2}\\).', flags: ['restored (2\\sqrt{2}) and a\\nb'], classmarker: { id: 'cm:1' } },
    answer: 'A',
  };
  const once = repairItemText(damaged);
  assert.deepEqual(once, {
    question: 'Solve.\n\\(x=1\\)',
    choices: ['\\(\\frac{1}{2}\\)', '2'],
    rationale: { correct: 'so \\(\\sin(C)=\\frac{1}{2}\\).', flags: ['restored (2\\sqrt{2}) and a\\nb'], classmarker: { id: 'cm:1' } },
    answer: 'A',
  });
  assert.deepEqual(repairItemText(once), once);
  assert.equal(repairItemText({ rationale: 'a\\nb' }).rationale, 'a\nb');
  // a habit seen in one explanation is looked for in its siblings
  const sib = repairItemText({ rationale: { correct: 'The long leg is (3\\sqrt{3}/2).', A: 'So x cannot be (9/2), which is longer.' } });
  assert.equal(sib.rationale.A, 'So x cannot be \\(9/2\\), which is longer.');
  assert.equal(repairItemText({ rationale: { correct: 'It is 4.', A: 'So x cannot be (9/2).' } }).rationale.A, 'So x cannot be (9/2).');
  const clean = 'Which choice completes the text?\n\\(\\frac{3}{4}\\) of \\(x\\)';
  assert.equal(repairText(clean), clean);
});
