// Checks grid-in scoring against the SAT's rules, without a database.
//
// With the source's accepted list, an entry is correct only if it equals one
// of the listed forms as text or as a number: unreduced fractions count, a
// shorter rounding does not, and two-solution questions accept either value.
// Without a list, numeric equivalence within a small tolerance applies.
//
//   npm run check:scoring

import assert from 'node:assert/strict';
import { gridMatch } from '../lib/session.js';

const SEVEN_SIXTHS = ['7/6', '1.166', '1.167'];

const cases = [
  // [given, expected, accepted, correct?, why]
  ['7/6', '7/6', SEVEN_SIXTHS, true, 'the printed fraction'],
  ['1.166', '7/6', SEVEN_SIXTHS, true, 'a listed truncation'],
  ['1.167', '7/6', SEVEN_SIXTHS, true, 'a listed rounding'],
  ['14/12', '7/6', SEVEN_SIXTHS, true, 'an unreduced fraction is the same number'],
  ['1.17', '7/6', SEVEN_SIXTHS, false, 'a shorter rounding is not accepted'],
  ['1.1666', '7/6', SEVEN_SIXTHS, false, 'too many digits is not a listed form'],
  ['30', '30', ['30', '-30'], true, 'first of two solutions'],
  ['-30', '30', ['30', '-30'], true, 'second of two solutions'],
  ['0', '30', ['30', '-30'], false, 'neither solution'],
  ['0.5', '.5', ['.5', '1/2'], true, 'a leading zero is the same number'],
  ['\u22124', '-4', ['-4'], true, 'a typographic minus'],
  [' 25 ', '25', ['25'], true, 'surrounding spaces'],
  ['', '5', ['5'], false, 'no entry'],
  ['1188', '1,188', ['1,188'], true, 'a thousands separator is not part of the entry'],
  ['1,188', '1188', ['1188'], true, 'nor when the student types one'],
  ['.5', '1/2', [], true, 'no list: fraction equivalence'],
  ['.667', '2/3', [], true, 'no list: rounding within tolerance'],
  ['.6', '2/3', [], false, 'no list: too far off'],
  ['abc', 'abc', [], true, 'no list: exact text'],
];

let failed = 0;
for (const [given, expected, accepted, want, why] of cases) {
  try {
    assert.equal(gridMatch(given, expected, accepted), want);
  } catch {
    failed += 1;
    console.log(`FAIL  ${JSON.stringify(given)} vs ${JSON.stringify(accepted.length ? accepted : expected)}: expected ${want} (${why})`);
  }
}
console.log(`${cases.length - failed}/${cases.length} scoring cases pass`);
process.exitCode = failed ? 1 : 0;
