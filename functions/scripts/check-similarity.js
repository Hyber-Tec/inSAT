// Measures the near-duplicate detector so the thresholds in similarity.js are
// backed by numbers. Run: node functions/scripts/check-similarity.js

import { simhash, hamming, NEAR_DUPLICATE_BITS } from '../lib/similarity.js';
import { MATH_TEMPLATES, buildItem } from '../lib/templates/math.js';

const P1 = 'The 2019 study by Okonkwo et al. examined whether urban green corridors measurably reduce ambient temperature. Analyzing 40 cities, the team found a consistent 1.8 C drop within 200 metres of a corridor.';
const P1_EDIT = P1.replace('Analyzing 40 cities', 'After analysing forty cities');
const P2 = 'Marine biologist Renata Alves has argued that coral bleaching events, once episodic, now recur faster than reefs can recover. Her 2021 survey of the Coral Sea documented three events in five years.';
const rw = (passage, question) => ({ passage, question, choices: ['a', 'b', 'c', 'd'] });

const cases = [
  ['rw  reused passage, reworded stem', rw(P1, 'Which choice best states the main idea?'), rw(P1, 'Which best expresses the central idea?'), true],
  ['rw  lightly edited passage       ', rw(P1, 'Q'), rw(P1_EDIT, 'Q'), true],
  ['rw  different passage            ', rw(P1, 'Q'), rw(P2, 'Q'), false],
];

let bad = 0;
for (const [label, a, b, shouldFlag] of cases) {
  const d = hamming(simhash(a), simhash(b));
  const flagged = d <= NEAR_DUPLICATE_BITS.rw;
  const ok = flagged === shouldFlag;
  if (!ok) bad += 1;
  console.log(`${label}  ${String(d).padStart(2)} bits  flagged=${flagged}  ${ok ? 'ok' : 'FAIL'}`);
}

let collisions = 0;
let pairs = 0;
for (const t of MATH_TEMPLATES) {
  const hs = Array.from({ length: 40 }, (_, i) => simhash(buildItem(t, i * 7919 + 1)));
  for (let i = 0; i < hs.length; i += 1) {
    for (let j = i + 1; j < hs.length; j += 1) {
      pairs += 1;
      if (hamming(hs[i], hs[j]) <= NEAR_DUPLICATE_BITS.math) collisions += 1;
    }
  }
}
const rate = (100 * collisions) / pairs;
console.log(`math sibling false-flag rate       ${rate.toFixed(2)}%  (${collisions}/${pairs})`);
if (rate > 6) { console.error('FAIL: math threshold is rejecting too many legitimate variants'); bad += 1; }

if (bad) process.exit(1);
console.log('\nThresholds hold.');
