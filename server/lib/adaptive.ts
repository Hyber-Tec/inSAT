/**
 * Adaptive routing for insat.
 *
 * The digital SAT uses a two-stage adaptive design: every student takes a
 * mixed-difficulty Module 1, and their performance on it determines whether
 * Module 2 is the "easy" or "hard" routing variant. The threshold isn't
 * a simple raw-score cutoff - it's a provisional ability estimate (theta)
 * derived from item-level performance.
 *
 * This module implements:
 *   1. provisionalTheta() - a maximum-likelihood theta estimate from
 *      Module 1 responses using the 3-parameter logistic IRT model.
 *   2. selectModule2() - picks the easy or hard variant from theta.
 *   3. finalScaledScore() - combines both modules into a scaled section
 *      score (200–800), the way real high-stakes tests do.
 *
 * In production the IRT parameters (a, b, c) for each item come from
 * pretesting on a large sample. They live in the `items` table.
 */

export interface IrtItem {
  /** Discrimination (a) - slope of the ICC at theta = b. Typical: 0.5–2.5 */
  discrimination: number;
  /** Difficulty (b) - theta at which P(correct) = (1 + c) / 2. Typical: -3 to 3 */
  difficulty: number;
  /** Guessing (c) - lower asymptote of the ICC. For 4-option MC, typically ~0.25 */
  guessing: number;
}

export interface ResponseRecord {
  item: IrtItem;
  correct: boolean;
}

/**
 * 3-parameter logistic item response function.
 * Returns the probability of a correct response given ability theta.
 */
export function pCorrect(theta: number, item: IrtItem): number {
  const { discrimination: a, difficulty: b, guessing: c } = item;
  const z = a * (theta - b);
  return c + (1 - c) / (1 + Math.exp(-z));
}

/**
 * Log-likelihood of an observed response pattern at a given theta.
 */
function logLikelihood(theta: number, responses: ResponseRecord[]): number {
  let ll = 0;
  for (const r of responses) {
    const p = pCorrect(theta, r.item);
    // Clamp to avoid log(0) when the model gives near-zero probability.
    const pClamped = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
    ll += r.correct ? Math.log(pClamped) : Math.log(1 - pClamped);
  }
  return ll;
}

/**
 * Estimate theta by maximum likelihood with a coarse-to-fine grid search.
 *
 * We deliberately avoid Newton-Raphson here: with a small number of items
 * (a Module 1 typically has 22–27) the likelihood surface can be flat
 * or multi-modal near the extremes (all-correct, all-incorrect). Grid
 * search is slow but bulletproof and easy to reason about - and 200
 * grid points × 27 items is still microseconds.
 *
 * Returns a theta in [-3, 3]. Saturation cases (0 correct, all correct)
 * are clamped to ±2.5 with a Bayesian prior - pure MLE would return
 * ±infinity, which is meaningless for routing.
 */
export function provisionalTheta(responses: ResponseRecord[]): number {
  if (responses.length === 0) return 0;

  const allCorrect = responses.every((r) => r.correct);
  const noneCorrect = responses.every((r) => !r.correct);
  if (allCorrect) return 2.5;
  if (noneCorrect) return -2.5;

  // Coarse grid: 0.05 steps from -3 to 3
  let bestTheta = 0;
  let bestLL = -Infinity;
  for (let t = -3; t <= 3; t += 0.05) {
    const ll = logLikelihood(t, responses);
    if (ll > bestLL) {
      bestLL = ll;
      bestTheta = t;
    }
  }
  // Fine grid around the coarse winner: 0.005 steps
  let fineBest = bestTheta;
  let fineBestLL = bestLL;
  for (let t = bestTheta - 0.05; t <= bestTheta + 0.05; t += 0.005) {
    const ll = logLikelihood(t, responses);
    if (ll > fineBestLL) {
      fineBestLL = ll;
      fineBest = t;
    }
  }
  return Math.round(fineBest * 1000) / 1000;
}

/**
 * Pick the routing for Module 2 based on Module 1 theta.
 *
 * The cut score should be calibrated empirically - the value below is a
 * reasonable starting point that puts roughly the upper half of test
 * takers into the hard module. In production, this constant lives in
 * config and gets re-tuned after each test administration.
 */
export const ROUTING_THRESHOLD = 0.0;

export type ModuleRouting = 'easy' | 'hard';

export function selectModule2(theta: number): ModuleRouting {
  return theta >= ROUTING_THRESHOLD ? 'hard' : 'easy';
}

/**
 * Combine module 1 + module 2 results into a section-scaled score (200–800).
 *
 * Real exams use elaborate equating tables to map raw → scaled scores
 * separately for each module pairing (so the hard route has a higher
 * ceiling and a steeper conversion at the top). This implementation
 * approximates that: hard-route students get a higher conversion slope,
 * and the score is capped/floored at the routing's reachable range.
 */
export function finalScaledScore(
  module1Correct: number,
  module1Total: number,
  module2Correct: number,
  module2Total: number,
  routing: ModuleRouting
): number {
  const correctTotal = module1Correct + module2Correct;
  const itemsTotal = module1Total + module2Total;
  if (itemsTotal === 0) return 200;
  const frac = correctTotal / itemsTotal;
  if (routing === 'hard') {
    // Hard route: 500–800 reachable range, can drop to ~450 at the bottom
    return Math.round(450 + frac * 350);
  } else {
    // Easy route: 200–600 reachable range
    return Math.round(200 + frac * 400);
  }
}
