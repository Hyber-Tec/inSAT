// Pure scoring + adaptive routing. Ported from the repo's adaptive.ts/scoring.ts
// and simplified to work without per-item IRT calibration: Module 2 routing is
// decided by the Module-1 raw-correct fraction, and the section scaled score is
// routing-aware (the hard route reaches a higher ceiling than the easy route).

export const DEFAULT_ROUTING_FRACTION = 0.6;

/** Route Module 2 to 'hard' when Module 1 clears the threshold, else 'easy'. */
export function routeFromModule1(correct, total, thresholdFraction = DEFAULT_ROUTING_FRACTION) {
  if (!total) return 'easy';
  return correct / total >= thresholdFraction ? 'hard' : 'easy';
}

/**
 * Section scaled score (200–800), routing-aware.
 *   hard route: ~450–800 reachable
 *   easy route: ~200–600 reachable
 */
export function sectionScaledScore(m1Correct, m1Total, m2Correct, m2Total, routing) {
  const correct = m1Correct + m2Correct;
  const total = m1Total + m2Total;
  if (!total) return 200;
  const frac = correct / total;
  return routing === 'hard'
    ? Math.round(450 + frac * 350)
    : Math.round(200 + frac * 400);
}

/** Simple non-adaptive scaled score, for single-route demo/untimed exams. */
export function plainScaled(correct, total) {
  if (!total) return 200;
  return Math.round(200 + (correct / total) * 600);
}
